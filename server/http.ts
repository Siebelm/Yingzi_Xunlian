import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { AttemptLimit, Sessions } from './auth.ts';
import { resolveConfig } from './config.ts';
import type { NasConfig } from './config.ts';
import { contained, requestPath, StaticFiles } from './static.ts';
import { StateStore } from './store.ts';
import { badInput, exactObject, HttpError, parseOperation, safeJson } from './validation.ts';

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.removeHeader('Content-Length');
  response.end(JSON.stringify(body));
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

/** Resolve existing ancestors too: DATA_DIR may not exist yet, or /var may alias /private/var. */
function destination(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    tail.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) throw new Error('Storage/static path has no existing ancestor.');
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}

async function body(request: IncomingMessage, response: ServerResponse, max: number, timeoutMs: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
      || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
    throw new HttpError(415, 'JSON_REQUIRED', 'Send an uncompressed application/json request.');
  }
  if (Number(request.headers['content-length'] ?? 0) > max) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(new HttpError(408, 'BODY_TIMEOUT', 'Request body timed out.')), timeoutMs);
    timer.unref();
    function cleanup(): void {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    }
    function fail(error: Error): void {
      cleanup();
      request.pause();
      request.once('error', () => { /* The response closes an interrupted request's socket. */ });
      response.setHeader('Connection', 'close');
      reject(error);
    }
    function onData(chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > max) { fail(new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.')); return; }
      chunks.push(chunk);
    }
    function onAborted(): void { fail(new HttpError(400, 'ABORTED', 'Request was interrupted.')); }
    function onError(): void { fail(new HttpError(400, 'INVALID_BODY', 'Could not read request.')); }
    function onEnd(): void {
      cleanup();
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        safeJson(value);
        resolveBody(value);
      } catch { reject(new HttpError(400, 'INVALID_JSON', 'Request must contain valid, safe JSON.')); }
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

/** No listening or environment access occurs here. The caller owns listen(), and must await close(). */
export function createNasServer(input: NasConfig) {
  const config = resolveConfig(input);
  const distPath = destination(config.distDir);
  const dataPath = destination(config.dataDir);
  if (contained(distPath, dataPath) || contained(dataPath, distPath)) {
    throw new Error('DATA_DIR and distDir must be separate, non-nested directories.');
  }
  const sessions = new Sessions(config);
  const store = new StateStore(config.dataDir);
  const files = new StaticFiles(distPath);
  const globalLimit = new AttemptLimit(config.requestsPerMinute, 60_000);
  const loginLimit = new AttemptLimit(config.loginAttempts, config.loginWindowMs);
  const active = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    globalLimit.take();
    const path = requestPath(request.url ?? '/');
    const method = request.method ?? 'GET';
    if ((method === 'GET' || method === 'HEAD')
        && (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0)) badInput();
    if (method !== 'GET' && method !== 'HEAD') {
      if (request.headers.origin !== config.publicOrigin) {
        throw new HttpError(403, 'ORIGIN_REJECTED', 'This request must originate from the configured NAS origin.');
      }
    }
    if (path === '/api/session' && method === 'GET') {
      json(response, 200, { authenticated: sessions.authenticated(request) }); return;
    }
    if (path === '/api/login' && method === 'POST') {
      loginLimit.take();
      const value = await body(request, response, Math.min(config.maxBodyBytes, 4096), config.bodyTimeoutMs);
      exactObject(value, ['password']);
      if (typeof value.password !== 'string' || Buffer.byteLength(value.password) > 1024) badInput();
      if (!await sessions.verify(value.password)) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid password.');
      if (closing) throw new HttpError(503, 'SHUTTING_DOWN', 'Server is shutting down.');
      response.setHeader('Set-Cookie', sessions.issue(request));
      json(response, 200, { authenticated: true }); return;
    }
    if (path === '/api/logout' && method === 'POST') {
      // Support an empty body or {}, but never silently accept extra fields/content.
      if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) > 0) {
        const value = await body(request, response, Math.min(config.maxBodyBytes, 4096), config.bodyTimeoutMs);
        exactObject(value, []);
      }
      response.setHeader('Set-Cookie', sessions.revoke(request));
      json(response, 200, { ok: true }); return;
    }
    if (path === '/api' || path.startsWith('/api/')) {
      if (!sessions.authenticated(request)) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in to access NAS progress.');
      if (path === '/api/state' && method === 'GET') { json(response, 200, store.read()); return; }
      const kind = path === '/api/reviews' ? 'review' : path === '/api/time' ? 'time' : path === '/api/import' ? 'import' : null;
      if (kind && method === 'POST') {
        const value = await body(request, response, config.maxBodyBytes, config.bodyTimeoutMs);
        if (closing) throw new HttpError(503, 'SHUTTING_DOWN', 'Server is shutting down.');
        // A session can expire or be revoked while a slow body is in flight.
        if (!sessions.authenticated(request)) throw new HttpError(401, 'AUTH_REQUIRED', 'Session expired. Sign in again.');
        json(response, 200, store.apply(parseOperation(kind, value))); return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'No such API endpoint or method.');
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are allowed for files.');
    const foldedPath = path.toLowerCase();
    if ((foldedPath === '/deck' || foldedPath.startsWith('/deck/')) && !sessions.authenticated(request)) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in to access the deck.');
    }
    await files.serve(request, response, path);
  }

  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 20_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000 }, (request, response) => {
    securityHeaders(response);
    if (config.secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (closing || active.size >= config.maxPendingRequests) {
      response.setHeader('Connection', 'close');
      json(response, 503, { error: { code: 'BUSY', message: 'Server is busy. Try again shortly.' } }); return;
    }
    const pending = handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (!request.complete) response.setHeader('Connection', 'close');
      const known = error instanceof HttpError;
      if (known && error.status === 429) response.setHeader('Retry-After', String(Math.ceil(Math.max(config.loginWindowMs, 60_000) / 1000)));
      json(response, known ? error.status : 500, {
        error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'NAS request failed. No uncommitted changes were saved.' },
      });
    }).finally(() => active.delete(pending));
    active.add(pending);
  });
  server.keepAliveTimeout = 5000;
  server.setTimeout(30_000, (socket) => socket.destroy());
  server.maxConnections = Math.max(16, config.maxPendingRequests * 2);
  server.maxRequestsPerSocket = 1000;
  server.on('checkContinue', (_request, response) => {
    securityHeaders(response);
    response.setHeader('Connection', 'close');
    json(response, 417, { error: { code: 'EXPECTATION_FAILED', message: 'Expect headers are not supported.' } });
  });

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      const stopped = new Promise<void>((resolveClose, reject) => {
        if (!server.listening) { resolveClose(); return; }
        server.close((error) => error ? reject(error) : resolveClose());
        server.closeAllConnections();
      });
      await stopped;
      await Promise.allSettled([...active]);
      sessions.clear();
      store.close();
    })();
    return closePromise;
  }

  return { server, close };
}

export type NasServer = ReturnType<typeof createNasServer>;