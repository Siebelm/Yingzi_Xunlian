import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNasServer } from './http.ts';
import { resolveConfig } from './config.ts';

export { createNasServer } from './http.ts';
export type { NasServer } from './http.ts';
export type { NasConfig } from './config.ts';

// Importing this entry point in a test neither reads configuration nor opens a DB/listener.
function directlyExecuted(): boolean {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
const direct = directlyExecuted();
if (direct) {
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const dataDir = process.env.DATA_DIR;
    if (!dataDir || !isAbsolute(dataDir)) throw new Error('DATA_DIR must explicitly name an absolute directory on local disk.');
    const config = resolveConfig({
      password: process.env.SYNC_PASSWORD ?? '',
      publicOrigin: process.env.PUBLIC_ORIGIN ?? '',
      dataDir: resolve(dataDir),
      distDir: join(root, 'dist'),
      host: process.env.HOST ?? '127.0.0.1',
      port: process.env.PORT === undefined ? 8787 : /^\d+$/.test(process.env.PORT) ? Number(process.env.PORT) : NaN,
    });
    const app = createNasServer(config);
    app.server.once('error', () => {
      console.error('NAS listener failed; check local host/port configuration.');
      void app.close().finally(() => { process.exitCode = 1; });
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
    }
    app.server.listen(config.port, config.host, () => { console.info('NAS sync server listening.'); });
  } catch {
    // Avoid disclosing passwords, filesystem content, or stack traces to logs.
    console.error('NAS startup failed. Check SYNC_PASSWORD, PUBLIC_ORIGIN, DATA_DIR, HOST, PORT and local storage permissions.');
    process.exitCode = 1;
  }
}