# Private NAS backend

Authenticated, single-user backend for optional private NAS progress sync.
Installation and trusted HTTPS remain unconfigured; see [NAS_SETUP.md](../NAS_SETUP.md).

## Runtime and integration

- Node **22.23.3** was found at `/opt/homebrew/opt/node@22/bin/node`.
  Uses only built-in HTTP, crypto, filesystem and `node:sqlite`; no new dependencies.
- Entry: `server/index.ts`. Start with Node's `--experimental-strip-types` flag.
  SQLite may print Node's experimental-feature warning.
- Shared runtime imports: `../syncSchema.ts` (`assertSnapshot`, `assertReview`,
  `assertTimeBatch`, `validDay`), `../scheduler.ts` (`scheduleReview`), and
  `../activity.ts` (`DECK_ID`, `emptyActivity`). Shared type imports also use
  `../types.ts`. These root modules are shared with the frontend.
- Factory: `createNasServer(config: NasConfig)` from `server/index.ts` or
  `server/http.ts` returns `{ server: http.Server, close(): Promise<void> }`.
  Importing it does not read environment variables, open storage, or listen.
  Creating it opens storage but does not listen. Call `server.listen(...)`
  explicitly and always await the idempotent `close()`; closing revokes all
  sessions, terminates sockets, waits for request handlers, and closes SQLite.
- A separately built NAS frontend must set `VITE_NAS_SYNC=true`, make same-origin
  API requests with cookies, and supply JSON content type. Browser-created POSTs
  supply Origin automatically. No CORS is enabled. Static files come exclusively
  from the root `dist/`; `/` serves `index.html`, not an arbitrary SPA fallback.

Root scripts:

| Name | Value |
| --- | --- |
| `server:start` | `node --experimental-strip-types server/index.ts` |
| `server:check` | `tsc -p server/tsconfig.json` |
| `test:server` | `node --experimental-strip-types --test server/checks.mjs` |

`checks.mjs` deliberately avoids `.test`/`.spec` names so Vitest does not collect
Node-runner tests. Tests create disposable local databases and loopback listeners
on port 0; they neither start a preview nor deploy anything. `server/tsconfig.json`
is strict, no-emit, and separate from the frontend configuration.

## Configuration

Production entry reads these environment variables **only when directly executed**:

| Variable | Requirement/default |
| --- | --- |
| `SYNC_PASSWORD` | Required; at least 20 Unicode characters, at most 1024 UTF-8 bytes. Never included in logs. |
| `PUBLIC_ORIGIN` | Required exact HTTPS origin, e.g. `https://nas.example`; no trailing slash, path, credentials, query or fragment. HTTP is permitted only for `localhost`, `127.0.0.1`, or `[::1]` development/test origins. |
| `DATA_DIR` | Required absolute, dedicated directory on the NAS's **local disk**. No implicit cwd/default path. Never use SMB/NFS/cloud-sync storage. |
| `HOST` | `127.0.0.1` |
| `PORT` | `8787` |

The factory takes camelCase `password`, `publicOrigin`, `dataDir`, `distDir`,
optional `host`/`port`, and test-tunable positive bounded numeric limits:

| Option | Default |
| --- | --- |
| `sessionTtlMs` | 12 hours, absolute expiry |
| `maxSessions` | 64; evicts oldest session |
| `loginAttempts` / `loginWindowMs` | 10 attempts per 15 minutes, global |
| `requestsPerMinute` | 600, global |
| `maxPendingRequests` | 32 (plus bounded sockets/header deadlines) |
| `maxBodyBytes` | 8 MiB maximum; login/logout limited to 4 KiB |
| `bodyTimeoutMs` | 15 seconds |

Also: 16 KiB headers, 10-second header timeout, 20-second request timeout,
30-second socket idle timeout, 5-second keepalive, 1,000 requests/socket, at most
two concurrent scrypt jobs. Login throttling includes successful attempts and
malformed login bodies; login does not reset the limiter. Limits and sessions
are in memory and reset on restart; progress and operation receipts do not.
Global limits deliberately avoid attacker-controlled IP maps and ignore all
forwarded/proxy headers. Do not run multiple backend processes: progress writes
are serialized by SQLite, but sessions/limits are single-process.

TLS is not implemented by this HTTP process. A private NAS HTTPS endpoint must
terminate TLS in front of the loopback listener, forward to it without exposing
the internal HTTP port, and preserve the browser's Origin. That future setup is
not performed here. Cookie security depends **only** on configured PUBLIC_ORIGIN,
never spoofable proxy headers. HTTPS uses a host-only `__Host-nas_session` cookie
with `Secure; HttpOnly; SameSite=Strict; Path=/`; loopback HTTP uses `nas_session`
without Secure. Sessions use 256-bit opaque random tokens, hashed in memory.
Passwords are verified with scrypt and timing-safe comparison. Logout revokes
the current token; restart revokes all tokens.

Keep dist and DATA_DIR operator-owned and non-nested, and do not allow untrusted
concurrent filesystem changes. Symlink database/static files and hardlinked
static files are rejected. Known Linux network filesystem types are rejected,
but mount detection is not universal: the operator must verify local storage
on other systems/drivers. DATA_DIR is set to mode 0700 and the database to 0600.
Never point DATA_DIR at a shared directory whose permissions should be preserved.

## API and consistency

All responses use `Cache-Control: no-store`, including public shell, API and
private deck/media. Security headers include CSP, frame denial, nosniff and
same-origin resource policy. The CSP permits self-hosted scripts/styles and
blob media, but not inline scripts/styles or external requests.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/session` | `{authenticated:boolean}`, public |
| `POST /api/login` | Exact `{password}`; returns `{authenticated:true}` and cookie |
| `POST /api/logout` | Empty body or exact `{}`; returns `{ok:true}` and expires cookie |
| `GET /api/state` | Authenticated `{revision,state}` |
| `POST /api/reviews` | Exact `{id,expected,review,day}`; UUID, validated reviews, local calendar day |
| `POST /api/time` | Exact `{id,slices}` shared TimeBatch; UUID; validated bounded integers |
| `POST /api/import` | Exact `{id,state}`; UUID; shared ProgressSnapshot |

Every mutating request, including login/logout and unknown paths, requires the
exact configured Origin. All progress routes require authentication, as does
every case spelling/encoded spelling of `/deck`. GET/HEAD with bodies are rejected.
Unknown API routes/methods never fall back to HTML. Static audio supports HEAD
and single byte ranges, including suffix ranges.

Initial state is revision 0, format 1, deck `mandarin-hsk-1-5`, empty reviews and
`emptyActivity()`. Each new operation increments the revision once. Reviews check
the entire previous review (or null); scheduled results must exactly match
`scheduleReview(cardId, expected, rating, reviewedAt)`, and timestamps cannot go
backwards relative to that card. Rating and lifetime/daily counts commit together;
the caller's local day is authoritative, not the server timezone. Legacy markers
and existing days/counts are preserved. Time batches add their slices independently
of card-review concurrency; safe-integer overflow is rejected.

SQLite `BEGIN IMMEDIATE` transactions write the snapshot, revision and persistent
receipt together (`WAL`, `synchronous=FULL`, 3-second busy timeout). Receipts use
a global operation UUID plus SHA-256 of canonical, property-sorted payload JSON
including operation kind. They are deliberately not expired: retrying a committed
operation returns **current** state before stale-review/pristine checks, including
after restart. Reusing the ID with different data or a different operation type
returns 409. Arrays retain order in canonical payloads. Failed operations leave
neither progress changes nor a receipt.

Import is allowed only at pristine revision 0, even when previous operations
added only time or imported an empty snapshot. It never merges or overwrites
existing NAS progress. Import payloads, including legacy partial counts, are
retained as validated rather than reconstructed.

Errors are JSON `{error:{code,message}}`. Notable codes:
`AUTH_REQUIRED`/`INVALID_CREDENTIALS` (401), `ORIGIN_REJECTED` (403),
`STALE_REVIEW`/`OPERATION_ID_REUSED`/`NAS_NOT_PRISTINE` (409), `INVALID_INPUT`
(400), `BODY_TOO_LARGE` (413), `RATE_LIMITED` (429), and `BUSY` (503).
Conflicts do not contain a replacement snapshot: reload `GET /api/state` and
show the actionable error, rather than silently retrying altered data. Retry
an uncertain committed request only with its unchanged UUID and payload.
Unexpected failures return a generic 500 without exposing SQL, paths, or secrets.

No recordings are accepted or persisted. Shared exact-field validators plus
recursive prototype-key rejection protect inputs; uploads, JSON compression,
traversal, hidden files, source files, sourcemaps and database assets are rejected.

## Validation

All **19 backend checks passed** with the real shared schema and Node 22.23.3,
using temporary SQLite databases and ephemeral loopback listeners. Strict backend
type-checking passed. A Chromium two-client check additionally exercises the
NAS production frontend, migration, private media, shared progress, an uncertain
committed rating response and exact retry, mobile layout, and logout.
No NAS deployment, browser preview, physical-device or live HTTPS testing was done.