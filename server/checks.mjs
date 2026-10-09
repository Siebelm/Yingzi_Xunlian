import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createNasServer } from './index.ts';
import { resolveConfig } from './config.ts';
import { DECK_ID, emptyActivity } from '../activity.ts';
import { scheduleReview } from '../scheduler.ts';

const PASSWORD = 'test-only-password-32-characters-long';
const ORIGIN = 'http://127.0.0.1:8787';
const DAY = '2026-10-09';
const NOW = Date.UTC(2026, 9, 9, 12);
const snapshot = () => ({ format: 1, deckId: DECK_ID, reviews: {}, activity: emptyActivity() });
const time = (ms = 1000, day = DAY) => ({ id: randomUUID(), slices: [{ day, timeMs: ms }] });
const rating = (cardId = 'hsk:1', expected = null, value = 'good', now = NOW) => ({
  id: randomUUID(), expected, review: scheduleReview(cardId, expected ?? undefined, value, now), day: DAY,
});

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nas-check-'));
  const dataDir = join(root, 'data');
  const distDir = join(root, 'dist');
  await mkdir(join(distDir, 'deck', 'media'), { recursive: true });
  await mkdir(join(distDir, 'assets'));
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Login shell</title>');
  await writeFile(join(distDir, 'deck', 'deck.json'), '{"cards":[]}');
  await writeFile(join(distDir, 'deck', 'media', 'word.mp3'), '0123456789');
  await writeFile(join(distDir, 'assets', 'app.js'), 'console.log("public shell");');
  const config = { password: PASSWORD, publicOrigin: ORIGIN, dataDir, distDir, ...overrides };
  let app;
  let port;
  async function start() {
    app = createNasServer(config);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    port = app.server.address().port;
  }
  await start();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

  async function call(path, { method = 'GET', payload, cookie, origin = config.publicOrigin, headers = {}, raw } = {}) {
    const body = raw ?? (payload === undefined ? undefined : JSON.stringify(payload));
    const requestHeaders = { ...headers };
    if (method !== 'GET' && method !== 'HEAD' && origin !== null) requestHeaders.Origin = origin;
    if (cookie) requestHeaders.Cookie = cookie;
    if (body !== undefined) {
      requestHeaders['Content-Type'] ??= 'application/json';
      requestHeaders['Content-Length'] ??= Buffer.byteLength(body);
    }
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: requestHeaders, agent: false }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try { json = JSON.parse(text); } catch { /* Static content and HEAD intentionally aren't JSON. */ }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(body);
    });
  }
  async function login() {
    const response = await call('/api/login', { method: 'POST', payload: { password: PASSWORD } });
    assert.equal(response.status, 200, response.text);
    return response.headers['set-cookie'][0].split(';')[0];
  }
  return {
    root, dataDir, distDir, config, call, login,
    get port() { return port; }, get app() { return app; },
    async restart() { await app.close(); await start(); },
  };
}

test('configuration requires a long secret, exact origin, absolute paths and bounded limits', () => {
  const base = { password: PASSWORD, publicOrigin: 'https://nas.example', dataDir: '/tmp/nas-data', distDir: '/tmp/nas-dist' };
  assert.equal(resolveConfig(base).host, '127.0.0.1');
  assert.equal(resolveConfig(base).port, 8787);
  assert.equal(resolveConfig(base).secure, true);
  for (const password of ['', 'short', 'x'.repeat(1025)]) assert.throws(() => resolveConfig({ ...base, password }));
  for (const publicOrigin of ['http://nas.example', 'https://nas.example/', 'https://nas.example/path', 'https://u:p@nas.example', 'https://nas.example?x', 'null']) {
    assert.throws(() => resolveConfig({ ...base, publicOrigin }));
  }
  for (const publicOrigin of ['http://127.0.0.1:1234', 'http://localhost', 'http://[::1]:1234']) {
    assert.equal(resolveConfig({ ...base, publicOrigin }).secure, false);
  }
  assert.throws(() => resolveConfig({ ...base, maxBodyBytes: 9 * 1024 * 1024 }));
  assert.throws(() => resolveConfig({ ...base, port: NaN }));
  assert.throws(() => resolveConfig({ ...base, dataDir: './relative' }));
});

test('public login shell, protected state/deck, authentication, no-store and security headers', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/session')).json, { authenticated: false });
  for (const path of ['/api/state', '/deck/deck.json', '/deck/media/word.mp3', '/%64eck/deck.json', '/DECK/deck.json']) {
    assert.equal((await f.call(path)).status, 401);
  }
  const shell = await f.call('/');
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Login shell/);
  assert.equal(shell.headers['cache-control'], 'no-store');
  assert.equal(shell.headers['x-content-type-options'], 'nosniff');
  assert.equal(shell.headers['x-frame-options'], 'DENY');
  assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(shell.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.call('/assets/app.js')).status, 200);
  assert.equal((await f.call('/api/login', { method: 'POST', payload: { password: 'wrong' } })).status, 401);
  const cookie = await f.login();
  assert.deepEqual((await f.call('/api/session', { cookie })).json, { authenticated: true });
  const initial = await f.call('/api/state', { cookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.revision, 0);
  assert.deepEqual(initial.json.state.reviews, {});
  assert.deepEqual(initial.json.state.activity.days, {});
  const deck = await f.call('/deck/deck.json', { cookie });
  assert.equal(deck.status, 200);
  assert.equal(deck.headers['cache-control'], 'no-store');
  assert.equal((await f.call('/api/missing', { cookie })).status, 404);
  assert.equal((await f.call('/api/state', { cookie, method: 'POST', payload: {} })).status, 404);
  assert.equal((await f.call('/api/session', { cookie: `${cookie}; ${cookie}` })).json.authenticated, false);
});

test('exact Origin is mandatory for every mutating route, including login and logout', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  for (const path of ['/api/login', '/api/logout', '/api/reviews', '/api/time', '/api/import', '/api/missing', '/']) {
    for (const origin of [null, 'null', 'https://evil.example', `${ORIGIN}/`, 'http://localhost:8787']) {
      const result = await f.call(path, { method: 'POST', origin, cookie, payload: {} });
      assert.equal(result.status, 403, `${path} ${origin}: ${result.text}`);
      assert.equal(result.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.equal((await f.call('/api/session', { cookie })).json.authenticated, true);
  assert.equal((await f.call('/api/state', { cookie })).json.revision, 0);
});

test('HTTPS cookies are opaque, Secure, host-only, HttpOnly and Strict; logout revokes', async (t) => {
  const f = await fixture(t, { publicOrigin: 'https://nas.example' });
  const response = await f.call('/api/login', { method: 'POST', payload: { password: PASSWORD }, headers: { 'X-Forwarded-Proto': 'http' } });
  assert.equal(response.status, 200);
  const setCookie = response.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-nas_session=[A-Za-z0-9_-]{43};/);
  for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(setCookie.includes(flag));
  assert.ok(!setCookie.includes('Domain='));
  assert.ok(!setCookie.includes(PASSWORD));
  const cookie = setCookie.split(';')[0];
  const logout = await f.call('/api/logout', { method: 'POST', cookie });
  assert.deepEqual(logout.json, { ok: true });
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.call('/api/state', { cookie })).status, 401);
  assert.equal((await f.call('/api/session', { cookie })).json.authenticated, false);
});

test('sessions expire, rotate, are bounded, and do not survive restart', async (t) => {
  const f = await fixture(t, { maxSessions: 1, sessionTtlMs: 200 });
  const first = await f.login();
  const second = await f.login();
  assert.notEqual(first, second);
  assert.equal((await f.call('/api/session', { cookie: first })).json.authenticated, false);
  assert.equal((await f.call('/api/session', { cookie: second })).json.authenticated, true);
  await delay(210);
  assert.equal((await f.call('/api/state', { cookie: second })).status, 401);
  const third = await f.login();
  await f.restart();
  assert.equal((await f.call('/api/state', { cookie: third })).status, 401);
});

test('login and global throttles are bounded and ignore spoofed proxy headers', async (t) => {
  const f = await fixture(t, { loginAttempts: 2 });
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.call('/api/login', { method: 'POST', payload: { password: 'wrong' }, headers: { 'X-Forwarded-For': `10.0.0.${i}` } })).status, 401);
  }
  const blocked = await f.call('/api/login', { method: 'POST', payload: { password: PASSWORD }, headers: { 'X-Forwarded-For': '8.8.8.8' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  const g = await fixture(t, { requestsPerMinute: 2 });
  assert.equal((await g.call('/api/session')).status, 200);
  assert.equal((await g.call('/api/session')).status, 200);
  assert.equal((await g.call('/api/session', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 429);
});

test('review commits schedule and activity atomically; two-client stale writes conflict without changes', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const other = await f.login();
  const a = rating();
  const b = rating('hsk:1', null, 'easy');
  const results = await Promise.all([
    f.call('/api/reviews', { method: 'POST', cookie, payload: a }),
    f.call('/api/reviews', { method: 'POST', cookie: other, payload: b }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(results.find((r) => r.status === 409).json.error.code, 'STALE_REVIEW');
  const first = (await f.call('/api/state', { cookie })).json;
  assert.equal(first.revision, 1);
  assert.equal(first.state.activity.counts['hsk:1'], 1);
  assert.deepEqual(first.state.activity.days[DAY], { cardIds: ['hsk:1'], reviews: 1, timeMs: 0 });
  const previous = first.state.reviews['hsk:1'];
  const repeat = rating('hsk:1', previous, 'again', NOW + 1);
  assert.equal((await f.call('/api/reviews', { method: 'POST', cookie, payload: repeat })).status, 200);
  const state = (await f.call('/api/state', { cookie })).json;
  assert.equal(state.revision, 2);
  assert.deepEqual(state.state.reviews['hsk:1'], repeat.review);
  assert.deepEqual(state.state.activity.days[DAY], { cardIds: ['hsk:1'], reviews: 2, timeMs: 0 });
  const bad = rating('hsk:2');
  bad.review.due++;
  assert.equal((await f.call('/api/reviews', { method: 'POST', cookie, payload: bad })).status, 400);
  assert.deepEqual((await f.call('/api/state', { cookie })).json, state);
});

test('independent client time batches and a rating preserve all updates and local day slices', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const second = await f.login();
  const a = time(2000);
  a.slices.push({ day: '2026-10-10', timeMs: 3000 });
  const b = time(4000);
  const results = await Promise.all([
    f.call('/api/time', { method: 'POST', cookie, payload: a }),
    f.call('/api/time', { method: 'POST', cookie: second, payload: b }),
    f.call('/api/reviews', { method: 'POST', cookie: second, payload: rating() }),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  const state = (await f.call('/api/state', { cookie })).json;
  assert.equal(state.revision, 3);
  assert.deepEqual(state.state.activity.days[DAY], { cardIds: ['hsk:1'], reviews: 1, timeMs: 6000 });
  assert.equal(state.state.activity.days['2026-10-10'].timeMs, 3000);
});

test('durable canonical receipts deduplicate before expected checks, reject reuse, and return current state after restart', async (t) => {
  const f = await fixture(t);
  let cookie = await f.login();
  const review = rating();
  const batch = time(5000);
  for (const [path, payload] of [['/api/reviews', review], ['/api/time', batch]]) {
    const responses = await Promise.all([1, 2, 3].map(() => f.call(path, { method: 'POST', cookie, payload })));
    assert.ok(responses.every((r) => r.status === 200));
  }
  const next = rating('hsk:1', review.review, 'again', NOW + 1);
  assert.equal((await f.call('/api/reviews', { method: 'POST', cookie, payload: next })).status, 200);
  const committed = (await f.call('/api/state', { cookie })).json;
  assert.equal(committed.revision, 3);
  await f.restart();
  cookie = await f.login();
  assert.deepEqual((await f.call('/api/state', { cookie })).json, committed);
  const reordered = { day: review.day, review: Object.fromEntries(Object.entries(review.review).reverse()), expected: null, id: review.id };
  assert.deepEqual((await f.call('/api/reviews', { method: 'POST', cookie, payload: reordered })).json, committed);
  assert.deepEqual((await f.call('/api/time', { method: 'POST', cookie, payload: batch })).json, committed);
  const reused = await f.call('/api/time', { method: 'POST', cookie, payload: { ...batch, slices: [{ day: DAY, timeMs: 9999 }] } });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error.code, 'OPERATION_ID_REUSED');
  assert.equal((await f.call('/api/time', { method: 'POST', cookie, payload: { ...batch, id: review.id } })).status, 409);
  assert.deepEqual((await f.call('/api/state', { cookie })).json, committed);
  assert.equal((await stat(join(f.dataDir, 'progress.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700);
});

test('import is pristine-only, preserves legacy counts, deduplicates after later writes and restart', async (t) => {
  const f = await fixture(t);
  let cookie = await f.login();
  const state = snapshot();
  const old = scheduleReview('hsk:1', undefined, 'good', NOW - 1000);
  state.reviews['hsk:1'] = old;
  state.activity.legacyCardIds = ['hsk:1'];
  const payload = { id: randomUUID(), state };
  const imported = await f.call('/api/import', { method: 'POST', cookie, payload });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.json.revision, 1);
  assert.deepEqual(imported.json.state, state);
  const reviewed = await f.call('/api/reviews', { method: 'POST', cookie, payload: rating('hsk:1', old, 'again') });
  assert.equal(reviewed.status, 200, reviewed.text);
  assert.deepEqual(reviewed.json.state.activity.legacyCardIds, ['hsk:1']);
  assert.equal(reviewed.json.state.activity.counts['hsk:1'], 1);
  assert.equal((await f.call('/api/import', { method: 'POST', cookie, payload: { ...payload, id: randomUUID() } })).status, 409);
  await f.restart();
  cookie = await f.login();
  assert.deepEqual((await f.call('/api/import', { method: 'POST', cookie, payload })).json, reviewed.json);
  const fresh = await fixture(t);
  const another = await fresh.login();
  assert.equal((await fresh.call('/api/time', { method: 'POST', cookie: another, payload: time() })).status, 200);
  const denied = await fresh.call('/api/import', { method: 'POST', cookie: another, payload });
  assert.equal(denied.status, 409);
  assert.equal(denied.json.error.code, 'NAS_NOT_PRISTINE');
});

test('malformed fields, audio, unsafe integers, impossible days and prototype keys never mutate state', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const initial = (await f.call('/api/state', { cookie })).json;
  const review = rating();
  const malformed = [
    ['/api/reviews', { ...review, audio: 'data:audio/webm;base64,AAA' }],
    ['/api/reviews', { ...review, review: { ...review.review, audio: 'bad' } }],
    ['/api/reviews', { ...review, expected: { ...review.review, extra: 1 } }],
    ['/api/reviews', { ...review, expected: { ...review.review, cardId: 'different' } }],
    ['/api/reviews', { ...review, day: '2026-02-30' }],
    ['/api/reviews', { ...review, id: 'not-a-uuid' }],
    ['/api/reviews', { ...review, review: { ...review.review, rating: 'awesome' } }],
    ...['__proto__', 'constructor', 'prototype'].map((id) => ['/api/reviews', rating(id)]),
    ['/api/time', { ...time(), audio: [] }],
    ['/api/time', { id: randomUUID(), slices: [{ day: DAY, timeMs: -1 }] }],
    ['/api/time', { id: randomUUID(), slices: [{ day: DAY, timeMs: 0.5 }] }],
    ['/api/time', { id: randomUUID(), slices: [{ day: DAY, timeMs: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['/api/time', { id: randomUUID(), slices: [{ day: '2026-13-01', timeMs: 1 }] }],
    ['/api/time', { id: randomUUID(), slices: [{ day: DAY, timeMs: 1, recording: 'bad' }] }],
    ['/api/import', { id: randomUUID(), state: { ...snapshot(), audio: [] } }],
    ['/api/import', { id: randomUUID(), state: { ...snapshot(), deckId: 'different' } }],
    ['/api/import', { id: randomUUID(), state: { ...snapshot(), activity: { ...emptyActivity(), audio: 'bad' } } }],
  ];
  for (const [path, payload] of malformed) {
    const result = await f.call(path, { method: 'POST', cookie, payload });
    assert.equal(result.status, 400, `${path}: ${result.text}`);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = `{"id":"${randomUUID()}","slices":[{"day":"${DAY}","timeMs":1,"${key}":{"polluted":true}}]}`;
    assert.equal((await f.call('/api/time', { method: 'POST', cookie, raw })).status, 400);
    const state = snapshot();
    state.reviews = JSON.parse(`{"${key}":${JSON.stringify(scheduleReview(key, undefined, 'good', NOW))}}`);
    assert.equal((await f.call('/api/import', { method: 'POST', cookie, payload: { id: randomUUID(), state } })).status, 400);
  }
  for (const raw of ['null', '[]', '{', '{"id":1e999,"slices":[]}']) {
    assert.equal((await f.call('/api/time', { method: 'POST', cookie, raw })).status, 400);
  }
  assert.equal({}.polluted, undefined);
  assert.deepEqual((await f.call('/api/state', { cookie })).json, initial);
});

test('failed SQLite receipt write rolls back snapshot and revision and permits a later retry', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const db = new DatabaseSync(join(f.dataDir, 'progress.sqlite'));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  const payload = rating();
  assert.equal((await f.call('/api/reviews', { method: 'POST', cookie, payload })).status, 500);
  const failed = (await f.call('/api/state', { cookie })).json;
  assert.equal(failed.revision, 0);
  assert.deepEqual(failed.state.reviews, {});
  assert.deepEqual(failed.state.activity.counts, {});
  db.exec('DROP TRIGGER fail_receipt;');
  assert.equal((await f.call('/api/reviews', { method: 'POST', cookie, payload })).status, 200);
  assert.equal((await f.call('/api/state', { cookie })).json.state.activity.counts['hsk:1'], 1);
});

test('static traversal, symlinks, hardlinks, source/env/DB files are blocked; audio ranges and HEAD work', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  await writeFile(join(f.root, 'secret.json'), 'private secret');
  await symlink(join(f.root, 'secret.json'), join(f.distDir, 'leak.json'));
  await symlink(join(f.distDir, 'deck'), join(f.distDir, 'alias'));
  await link(join(f.root, 'secret.json'), join(f.distDir, 'hardlink.json'));
  for (const filename of ['source.ts', 'bundle.js.map', '.env', 'progress.sqlite', 'progress.sqlite-wal']) {
    await writeFile(join(f.distDir, filename), 'must not serve');
  }
  for (const path of ['/../secret.json', '/%2e%2e/secret.json', '/assets/../deck/deck.json', '/%252e%252e/secret.json', '/deck%5cmedia/word.mp3', '/%00', '/leak.json', '/alias/deck.json', '/hardlink.json', '/source.ts', '/bundle.js.map', '/.env', '/progress.sqlite', '/progress.sqlite-wal']) {
    const result = await f.call(path, { cookie });
    assert.ok([400, 404].includes(result.status), `${path}: ${result.text}`);
    assert.ok(!result.text.includes('private secret'));
    assert.ok(!result.text.includes('must not serve'));
  }
  assert.equal((await f.call('/not-a-route', { cookie })).status, 404);
  const audio = await f.call('/deck/media/word.mp3', { cookie, headers: { Range: 'bytes=2-5' } });
  assert.equal(audio.status, 206);
  assert.equal(audio.text, '2345');
  assert.equal(audio.headers['content-type'], 'audio/mpeg');
  assert.equal(audio.headers['content-range'], 'bytes 2-5/10');
  assert.equal((await f.call('/deck/media/word.mp3', { cookie, headers: { Range: 'bytes=-3' } })).text, '789');
  assert.equal((await f.call('/deck/media/word.mp3', { cookie, headers: { Range: 'bytes=100-200' } })).status, 416);
  const head = await f.call('/deck/media/word.mp3', { cookie, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['content-length'], '10');
  assert.equal((await f.call('/deck/media/word.mp3', { method: 'HEAD' })).status, 401);
});

test('JSON content type, body size and timeout bounds reject without state changes', async (t) => {
  const f = await fixture(t, { maxBodyBytes: 1024, bodyTimeoutMs: 100 });
  const cookie = await f.login();
  const wrongType = await f.call('/api/time', { method: 'POST', cookie, raw: '{}', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  assert.equal((await f.call('/api/time', { method: 'POST', cookie, raw: ' '.repeat(1025) })).status, 413);
  assert.equal((await f.call('/api/time', { method: 'POST', cookie, payload: time(), headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  const socket = connect(f.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  let response = '';
  socket.on('data', (chunk) => { response += chunk; });
  const ended = once(socket, 'end');
  socket.write(`POST /api/time HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await ended;
  assert.match(response, /HTTP\/1\.1 408/);
  assert.equal((await f.call('/api/state', { cookie })).json.revision, 0);
});

test('concurrent pending bodies are bounded; chunked oversized requests are rejected', async (t) => {
  const f = await fixture(t, { maxPendingRequests: 1, bodyTimeoutMs: 1000, maxBodyBytes: 1024 });
  const cookie = await f.login();
  const socket = connect(f.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`POST /api/time HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await delay(30);
  assert.equal((await f.call('/api/session')).status, 503);
  socket.destroy();
  await delay(30);
  const chunked = connect(f.port, '127.0.0.1');
  t.after(() => chunked.destroy());
  await once(chunked, 'connect');
  let result = '';
  chunked.on('data', (chunk) => { result += chunk; });
  const ended = once(chunked, 'end');
  chunked.write(`POST /api/time HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${(1025).toString(16)}\r\n${'x'.repeat(1025)}\r\n0\r\n\r\n`);
  await ended;
  assert.match(result, /HTTP\/1\.1 413/);
});

test('data cannot be inside the static tree and factory closes safely without listening', async (t) => {
  const f = await fixture(t);
  assert.throws(() => createNasServer({ ...f.config, dataDir: join(f.distDir, 'private') }), /separate/);
  const app = createNasServer({ ...f.config, dataDir: join(f.root, 'never-listened') });
  assert.equal(app.server.listening, false);
  await Promise.all([app.close(), app.close()]);
});

test('same-card retries are conflict-free while independent cards can both commit', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const a = rating('hsk:1');
  const b = rating('hsk:2');
  const results = await Promise.all([a, b, a, b].map((payload) => f.call('/api/reviews', { method: 'POST', cookie, payload })));
  assert.ok(results.every((r) => r.status === 200));
  const current = (await f.call('/api/state', { cookie })).json;
  assert.equal(current.revision, 2);
  assert.deepEqual(current.state.activity.counts, { 'hsk:1': 1, 'hsk:2': 1 });
  assert.equal(current.state.activity.days[DAY].reviews, 2);
  assert.deepEqual([...current.state.activity.days[DAY].cardIds].sort(), ['hsk:1', 'hsk:2']);
});

test('logout rejects hidden fields and a revoked in-flight mutation cannot commit', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  assert.equal((await f.call('/api/logout', { method: 'POST', cookie, payload: { audio: 'not allowed' } })).status, 400);
  assert.equal((await f.call('/api/session', { cookie })).json.authenticated, true);
  const payload = JSON.stringify(time());
  const socket = connect(f.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  let response = '';
  socket.on('data', (chunk) => { response += chunk; });
  const ended = once(socket, 'end');
  socket.write(`POST /api/time HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0, 1)}`);
  await delay(20);
  assert.equal((await f.call('/api/logout', { method: 'POST', cookie, payload: {} })).status, 200);
  socket.write(payload.slice(1));
  await ended;
  assert.match(response, /HTTP\/1\.1 401/);
  const next = await f.login();
  assert.equal((await f.call('/api/state', { cookie: next })).json.revision, 0);
});

test('rejects malformed UTF-8, excessive nesting, Expect uploads and database symlinks', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const invalid = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  assert.equal((await f.call('/api/time', { method: 'POST', cookie, raw: invalid })).status, 400);
  const nested = `${'['.repeat(25)}0${']'.repeat(25)}`;
  assert.equal((await f.call('/api/time', { method: 'POST', cookie, raw: nested })).status, 400);
  assert.equal((await f.call('/api/time', { method: 'POST', cookie, payload: time(), headers: { Expect: '100-continue' } })).status, 417);
  const target = join(f.root, 'protected.sqlite');
  await writeFile(target, 'do not touch');
  const dataDir = join(f.root, 'unsafe-data');
  await mkdir(dataDir);
  await symlink(target, join(dataDir, 'progress.sqlite'));
  assert.throws(() => createNasServer({ ...f.config, dataDir }));
});