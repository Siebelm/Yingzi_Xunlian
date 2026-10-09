# Private NAS progress sync

## Status and prerequisites

Implemented, but **not installed on DH4300PLUS-2643**. That identifier alone does
not establish the manufacturer, operating system, CPU, container support, or
HTTPS/reverse-proxy capabilities. No NAS credentials, network configuration,
public exposure, repository, or third-party cloud account has been created.

The first version is **one user, online-first, private-network access**. All
devices use the same app address and password. The NAS stores review schedules,
counts, and practice time. Recordings stay temporary in the browser and are never
uploaded. Deck files are served privately from your own NAS, not a public CDN.

Before installation, confirm:

1. NAS manufacturer, model, OS/version, and whether a maintained Node runtime or
   container runtime is available. The backend was tested on **Node 22.23.3**;
   it needs built-in `node:sqlite` and TypeScript type stripping. Node 24 is a
   possible deployment runtime but has not been tested here.
2. A dedicated NAS-local data directory and a non-root service user with write
   access. Do **not** run SQLite from a client-mounted SMB/NFS directory.
3. A stable hostname and an HTTPS reverse proxy with a certificate trusted by
   both Mac and iPhone. iPhone microphone access needs a secure context; plain
   HTTP to a LAN IP is insufficient. TLS/certificate setup is not included.
4. Home-only access or remote access through a private VPN. Public port
   forwarding is not needed or recommended. Do not expose the NAS administration
   interface or the backend HTTP port to the Internet.

## Preserve current progress first

1. Open the app at the **same address and browser profile** used for current
   practice, for example the existing Mac loopback address. A NAS address cannot
   read the old address's IndexedDB.
2. End practice. Open **Progress backup → Export progress** and retain the JSON
   file privately. It contains no audio, images, password, or session cookies.
   Keep the original browser data until the NAS migration has been verified.
3. After installation, sign in at the NAS address. **Before starting any practice**,
   choose the backup, inspect its card count, and select **Import into empty NAS**.
4. Import copies the baseline once, including partial legacy counts. It does not
   replay ratings, invent missing history, merge totals, or overwrite an existing
   NAS database. Even a time-only practice session makes the NAS nonempty.
5. Sign in from the second device at the same address. Do **not** import again.
   Compare View Cards, next due dates, review counts, and activity totals. Retain
   the old local backup until satisfied.

Local builds can also restore a validated backup into an empty browser profile.
An existing local database is never overwritten by import. NAS mode does not read,
copy, clear, or replace the old browser-local progress automatically.

## Build and service layout (installation pending approval)

Build on the Mac using `npm run build:nas`. This type-checks the frontend/backend
and creates the NAS frontend in `dist/`, including the locally prepared deck.
The checked-in `.env.nas` contains only the public `VITE_NAS_SYNC=true` switch.
**Never put passwords in a `VITE_*` variable:** those values are public JavaScript.

The service needs these files, preserving relative paths:

- `dist/` — built app, deck, and media; keep private and operator-owned.
- `server/` — backend sources (tests and documentation may be excluded).
- `activity.ts`, `scheduler.ts`, `syncSchema.ts`, `types.ts` — shared modules.
- `package.json` — ES module declaration and the startup script.

The backend uses only Node built-ins; the runtime does not need the frontend's
development dependencies. Build dependencies remain on the build machine. Do
not copy the original Anki package, guide, secrets, or unrelated Mac files.

Configure the service manager with:

| Variable | Value |
| --- | --- |
| `SYNC_PASSWORD` | A unique password of at least 20 characters, generated and kept in a password manager/service secret; never commit it. |
| `PUBLIC_ORIGIN` | Exact trusted HTTPS origin used by the browser, without trailing slash/path; e.g. `https://shadowing.home.arpa` **only if you configure that hostname and a trusted certificate**. |
| `DATA_DIR` | Absolute, dedicated directory on NAS-local disk, separate from the app's `dist/`. Its mode is set to 0700; database files are private. |
| `HOST` | Leave at `127.0.0.1` until an approved deployment design requires otherwise. |
| `PORT` | Defaults to `8787`. |

`npm run server:start` starts the backend with Node's type-stripping flag. A
service manager must securely provide the environment, restart policy, startup
working directory, and non-root identity. Node 22 prints an experimental SQLite
warning; this is expected. Actual service/container configuration depends on the
NAS runtime and has deliberately not been generated or installed yet.

Architecture: **Mac/iPhone → trusted HTTPS proxy → loopback backend → SQLite**.
The proxy forwards **all paths**, including `/api`, `/deck`, `/assets`, and `/`,
to the backend; preserve Origin and cookies, do not cache responses, and do not
bypass backend authentication by serving `/deck` separately. Host the app at the
origin root, not a subpath. TLS ends at the proxy; the backend is HTTP only.
Loopback HTTP is accepted solely for local automated tests/development.

`npm run build` remains the default **local-only** build. Both build commands use
`dist/`, so the last build determines its mode. `npm run dev` remains local-only
and loopback-bound by default. Vite development/preview is not the NAS production
server. No new preview has been launched as part of this implementation.

## Behavior and limits

- NAS mode requires sign-in before loading private deck/progress data. Passwords
  are not persisted in browser storage; sessions use HttpOnly, SameSite cookies
  (Secure over HTTPS), last 12 hours, and expire on backend restart.
- Only same-origin requests are supported. There is no arbitrary remote URL,
  CORS configuration, or third-party cloud integration. Login attempts, request
  sizes, concurrent requests, and sessions are bounded.
- Ratings, counts, and operation receipts commit atomically. Review requests
  check the prior per-card schedule; stale requests are rejected, not silently
  overwritten. The backend verifies the shared scheduler's output.
- A lost response displays **Retry pending … save**. The retry uses the exact
  original rating and operation ID. Other ratings/skip/end remain disabled until
  that save resolves. Server receipts survive restarts and prevent double counts.
  Sign-in recovery retries pending in-memory reviews before reloading schedules.
- Idle queues refresh every 15 seconds and on focus/visibility return; activity
  refreshes every five seconds. Manual **Refresh NAS progress** is available when
  not practicing. There is no WebSocket/push or background offline sync.
- Use **one active practice device at a time**. Simultaneous time intervals are
  added, not overlap-deduplicated. Daily activity uses each submitting device's
  local calendar date; NAS timezone does not rewrite history. Keep device clocks
  accurate.
- Pending client requests/time batches are in memory, **not a durable offline
  queue**. Reloading, closing, session expiry, or process termination can lose
  unsent activity or ratings. A committed rating remains on the NAS even if its
  response was lost; reload checks the server's saved state. Do not rely on
  offline practice. The last unsaved time interval can be lost.
- Backups are strict version-1 JSON for this deck. The UI accepts files up to
  7 MiB; the backend accepts requests up to 8 MiB. Arbitrary Anki import and
  combining two independently used browser histories are not implemented.
- API state uses whole progress snapshots rather than an incremental event feed;
  this is intended for one user and a small private deployment. Run one backend
  process. SQLite access and receipts are durable; sessions/limits are in memory.

## Backup and restore

Export progress periodically from NAS mode. Protect exports like any other
personal study history. NAS RAID is not a backup.

For a full-fidelity server backup, **stop the service cleanly**, then copy the
entire dedicated DATA_DIR (including any SQLite sidecars) to another protected
device/disk. Restart after copying. Do not copy just the live `.sqlite` file:
committed writes may still be in the WAL. Restore with the service stopped into
a dedicated private directory, preserving permissions, then verify schedules,
counts, time totals, and login. Keep the old data until the restore is verified.
Do not synchronize a live database with a generic folder-sync utility.

Database backup preserves idempotency receipts; a JSON export contains only
progress. A JSON restore is for a new empty database, not an in-place rollback.
Close old client tabs before restoring a backup so their in-memory requests are
not submitted against restored state. Restoring older data inherently loses
newer changes. No automated backup job or on-device restore drill is configured.

## Validation performed

- `npm test`: **390 unit/component tests passed**, including local migration,
  backup/import, strict validation, retry identity, login recovery, and NAS UI.
- `npm run test:server`: **19 backend checks passed**, including SQLite restart,
  atomic rollback, two-client conflicts, CSRF/authentication, protected media,
  malformed input, request limits, and import deduplication.
- `npm run test:nas:browser`: **one Chromium two-client test passed**, using the
  actual NAS production build with a disposable loopback backend/database. It
  imports a baseline, shares progress, simulates a lost committed response,
  verifies a non-duplicating retry, checks mobile layout, and signs out.
- `npm run test:browser`: **three existing local Chromium checks passed**, with
  simulated microphone where applicable.
- Local build task and NAS frontend/backend type checks/build passed.

These checks are not physical microphone, trusted-HTTPS, Safari, iPhone, NAS
architecture/runtime, or real-network testing. Those remain installation steps.
See [server/README.md](server/README.md) for API and security details.