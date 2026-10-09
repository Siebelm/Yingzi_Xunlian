import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './validation.ts';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/** Parse the raw request target BEFORE URL normalization can discard traversal segments. */
export function requestPath(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#')) throw new HttpError(400, 'INVALID_PATH', 'Invalid request path.');
  let path: string;
  try { path = decodeURIComponent(raw.split('?')[0]); } catch { throw new HttpError(400, 'INVALID_PATH', 'Invalid request path.'); }
  if (/[\\\u0000-\u001f\u007f%]/.test(path) || path.startsWith('//')) throw new HttpError(400, 'INVALID_PATH', 'Invalid request path.');
  if (path.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.'))) {
    throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  }
  return path;
}

export class StaticFiles {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private async safeOpen(path: string): Promise<FileHandle> {
    const filename = resolve(this.root, `.${path}`);
    if (!contained(this.root, filename)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    // Reject symlinks even when their target remains inside dist. Check every path component.
    let current = this.root;
    const rootStat = await lstat(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(current) !== current) {
      throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    }
    for (const part of relative(this.root, filename).split(sep)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    }
    const before = await lstat(filename);
    if (!before.isFile() || before.nlink !== 1) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || await realpath(filename) !== filename) {
        throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      }
      return file;
    } catch (error) { await file.close(); throw error; }
  }

  async serve(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    // This is an asset server, not a workspace server. No source maps, DB files, TS, or SPA/API fallback.
    const target = path === '/' ? '/index.html' : path;
    const extension = extname(target).toLowerCase();
    if (!Object.hasOwn(mime, extension)) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    let file: FileHandle;
    try { file = await this.safeOpen(target); } catch (error) {
      if (error instanceof HttpError) throw error;
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      }
      throw error;
    }
    try {
      const { size } = await file.stat();
      let start = 0;
      let end = size - 1;
      response.setHeader('Content-Type', mime[extension]);
      response.setHeader('Accept-Ranges', 'bytes');
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        } else { start = -1; }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
          response.setHeader('Content-Range', `bytes */${size}`);
          throw new HttpError(416, 'INVALID_RANGE', 'Requested range is not available.');
        }
        response.statusCode = 206;
        response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      response.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (request.method === 'HEAD' || size === 0) { response.end(); return; }
      await pipeline(file.createReadStream({ start, end, autoClose: false }), response);
    } finally { await file.close(); }
  }
}