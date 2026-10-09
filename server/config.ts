import { isAbsolute } from 'node:path';

export interface NasConfig {
  password: string;
  publicOrigin: string;
  /** Dedicated directory on local disk, not an SMB/NFS mount. */
  dataDir: string;
  distDir: string;
  host?: string;
  port?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
  loginAttempts?: number;
  loginWindowMs?: number;
  requestsPerMinute?: number;
  maxPendingRequests?: number;
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
}

export type ResolvedConfig = Required<NasConfig> & { secure: boolean };

export function resolveConfig(input: NasConfig): ResolvedConfig {
  if (typeof input.password !== 'string' || [...input.password].length < 20
      || Buffer.byteLength(input.password) > 1024) {
    throw new Error('SYNC_PASSWORD must contain at least 20 characters and at most 1024 UTF-8 bytes.');
  }
  let origin: URL;
  try { origin = new URL(input.publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN must be an exact URL origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== input.publicOrigin || origin.username || origin.password
      || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin; HTTP is allowed only on loopback.');
  }
  for (const name of ['dataDir', 'distDir'] as const) {
    if (typeof input[name] !== 'string' || !isAbsolute(input[name])) throw new Error(`${name} must be an absolute path.`);
  }
  const config: ResolvedConfig = {
    ...input,
    host: input.host ?? '127.0.0.1', port: input.port ?? 8787,
    sessionTtlMs: input.sessionTtlMs ?? 12 * 60 * 60 * 1000,
    maxSessions: input.maxSessions ?? 64,
    loginAttempts: input.loginAttempts ?? 10,
    loginWindowMs: input.loginWindowMs ?? 15 * 60 * 1000,
    requestsPerMinute: input.requestsPerMinute ?? 600,
    maxPendingRequests: input.maxPendingRequests ?? 32,
    maxBodyBytes: input.maxBodyBytes ?? 8 * 1024 * 1024,
    bodyTimeoutMs: input.bodyTimeoutMs ?? 15_000,
    secure: origin.protocol === 'https:',
  };
  const bounds: [keyof ResolvedConfig, number, number][] = [
    ['port', 0, 65535], ['sessionTtlMs', 1, 30 * 86400_000], ['maxSessions', 1, 1024],
    ['loginAttempts', 1, 1000], ['loginWindowMs', 1, 86400_000], ['requestsPerMinute', 1, 100_000],
    ['maxPendingRequests', 1, 1024], ['maxBodyBytes', 1, 8 * 1024 * 1024], ['bodyTimeoutMs', 1, 60_000],
  ];
  for (const [name, min, max] of bounds) {
    const value = config[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid server limit: ${name}.`);
    }
  }
  if (!config.host || typeof config.host !== 'string') throw new Error('HOST must not be empty.');
  return config;
}