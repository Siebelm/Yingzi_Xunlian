import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { ResolvedConfig } from './config.ts';
import { HttpError } from './validation.ts';

/** A global fixed-window bucket cannot be bypassed with spoofed proxy/IP headers or unbounded IP maps. */
export class AttemptLimit {
  private start = performance.now();
  private attempts = 0;
  private readonly maximum: number;
  private readonly windowMs: number;

  constructor(maximum: number, windowMs: number) {
    this.maximum = maximum;
    this.windowMs = windowMs;
  }

  take(): void {
    const now = performance.now();
    if (now - this.start >= this.windowMs) { this.start = now; this.attempts = 0; }
    if (++this.attempts > this.maximum) {
      this.attempts = this.maximum + 1;
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Wait before trying again.');
    }
  }
}

export class Sessions {
  private readonly salt = randomBytes(32);
  private readonly passwordHash: Buffer;
  private readonly sessions = new Map<string, number>();
  private readonly config: ResolvedConfig;
  private passwordChecks = 0;
  readonly cookieName: string;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.cookieName = config.secure ? '__Host-nas_session' : 'nas_session';
    this.passwordHash = scryptSync(config.password, this.salt, 64);
  }

  private tokenHash(request: IncomingMessage): string | null {
    const values = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${this.cookieName}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(this.cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return createHash('sha256').update(token).digest('hex');
  }

  authenticated(request: IncomingMessage): boolean {
    const hash = this.tokenHash(request);
    if (!hash) return false;
    const expires = this.sessions.get(hash);
    if (!expires) return false;
    if (expires <= performance.now()) { this.sessions.delete(hash); return false; }
    return true;
  }

  async verify(password: string): Promise<boolean> {
    // Cap expensive concurrent KDF jobs separately from cheap HTTP work.
    if (this.passwordChecks >= 2) throw new HttpError(429, 'RATE_LIMITED', 'Too many password checks. Wait before trying again.');
    this.passwordChecks++;
    try {
      const derived = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, this.salt, 64, (error, key) => error ? reject(error) : resolve(key));
      });
      return timingSafeEqual(this.passwordHash, derived);
    } finally { this.passwordChecks--; }
  }

  issue(request: IncomingMessage): string {
    this.revoke(request);
    const now = performance.now();
    for (const [hash, expires] of this.sessions) if (expires <= now) this.sessions.delete(hash);
    while (this.sessions.size >= this.config.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(createHash('sha256').update(token).digest('hex'), now + this.config.sessionTtlMs);
    return this.cookie(token, Math.max(1, Math.floor(this.config.sessionTtlMs / 1000)));
  }

  revoke(request: IncomingMessage): string {
    const hash = this.tokenHash(request);
    if (hash) this.sessions.delete(hash);
    return this.cookie('', 0);
  }

  private cookie(token: string, age: number): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.config.secure ? '; Secure' : ''}`;
  }

  clear(): void { this.sessions.clear(); this.passwordHash.fill(0); }
}