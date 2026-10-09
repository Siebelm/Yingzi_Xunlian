# Shadowing

Local Mandarin shadowing practice built with React, TypeScript, and Vite. Compact dark interface for Mac and phone-sized screens.

**Optional private NAS sync is implemented, not deployed.** Local mode remains the
default. See [NAS_SETUP.md](NAS_SETUP.md) for progress migration, prerequisites,
security, limitations, and the remaining setup for DH4300PLUS-2643.

## Current scope

The app now loads the supplied deck, displays its full recognition-card answer (word, homograph, pinyin, meaning, part of speech, example sentence, translation, and image when present), and supports local practice and review scheduling. Chinese text and pinyin can be hidden; text embedded in images is not altered.

### Verified source data

The supplied `Mandarin_Vocabulary_HSK_1-5.apkg` was inspected and converted locally:

- 2,501 cards in `collection.anki21`, using the `HSK` recognition model.
- Chinese word audio on all cards; sentence audio missing on 299 cards.
- Images missing on 631 cards; 5,777 distinct local media files in total.
- **No English recordings or English audio field.** The app asks you to start without English audio; it does not fabricate recordings or use speech synthesis. The playback controller supports English once if an English clip is supplied later, but this deck cannot currently provide that step.
- The original package and guide remain untouched. Existing Anki scheduling/history is not imported; app reviews start fresh.

`prepare-deck.mjs` maps actual field names instead of assuming column positions. It does not execute Anki HTML templates or CSS. Display fields are sanitized with DOMPurify; only verified local media paths are allowed. Layout is adapted for dark mode rather than reproducing Anki's original styling.

### Practice

1. Choose an HSK level and sentence or word audio, then select **Start Review**. This deck has no English audio.
2. Chinese plays twice. If autoplay is blocked, tap **Continue audio**. Missing sentence audio requires an explicit switch to word audio or a skip; there is no silent substitution.
3. Tap **Record**, allow microphone access, and speak. Tap **Stop & play back** for immediate playback (maximum recording length: 60 seconds).
4. After playback, choose **Again**, **Hard**, **Good**, or **Easy**. The next due/new card starts only after the review is saved (locally by default, or to the NAS in NAS mode). Recording can be explicitly skipped with **Rate without recording**.
5. **Skip for this session** does not change scheduling. **Reset audio**, switching audio mode, ending the session, or hiding/leaving the page stops active media and discards unfinished recordings.

The recorder detects supported MIME types and uses the actual recording format. It releases microphone tracks and revokes blob URLs. Recordings are never uploaded, stored in IndexedDB, or retained after successful playback; recordings awaiting a playback retry are released when reset, skipped, or ended.

### Review policy

A small deterministic SRS, **not Anki/SM-2/FSRS-compatible**:

| Rating | First pass (or after Again) | Subsequent passing review |
| --- | --- | --- |
| Again | 10 minutes | 10 minutes; reset passing streak |
| Hard | 1 day | Previous interval × 1.2, rounded up; at least 1 day |
| Good | 3 days | Previous interval × 2, rounded up; at least 3 days |
| Easy | 5 days | Previous interval × 3, rounded up; at least 5 days |

Days mean fixed 24-hour durations. Due reviews come first (oldest due first), then new cards in deck order. There is no daily new-card limit. Word and sentence practice share the same per-card schedule. The queue refreshes every 15 seconds while idle.

In default local mode, review metadata and activity statistics are saved in IndexedDB (`shadowing-reviews-v1`, schema version 2), scoped to this browser and origin. Use the same address/port to retain access to progress. Browser data clearing, eviction, or private browsing can remove progress. **Progress backup** exports schedules and activity as validated JSON and restores into empty storage only. Failed saves keep the current card visible for retry. Corrupt records produce an error rather than silently resetting progress. Keep one practice tab open; simultaneous ratings/time tracking across tabs are not supported.

The separately built NAS mode uses an authenticated same-origin API and NAS-local SQLite. It never automatically copies or modifies the existing local database. Export at the old browser address and import once into the empty NAS before practicing. NAS mode is online-first; offline queues/PWA caching are not implemented. Recordings are never synchronized.

### Reviewed-card viewer

Select **View Cards** to browse cards that have at least one saved review. New cards are excluded. The current HSK level filter applies, and search supports Chinese, pinyin, English meaning, and card number. Cards are sorted by next due date and paginated in groups of 20.

Each entry shows its next scheduled date/time and review count. Select it to see the full card, last review date, and scheduling details. This is read-only: it does not play audio, rate cards, alter schedules, or accrue practice time. Opening the viewer from practice ends the active media session.

Review counts include every saved rating, including Again and repeats on the same day; they are not the scheduler's passing streak. The database upgrade preserves existing schedules. For cards reviewed before counting was added, **At least N** means one known earlier review plus newly tracked reviews. Older exact lifetime counts cannot be reconstructed from the previous schema and are not guessed.

### Activity statistics

- **Cards reviewed today** counts distinct cards with a successfully saved rating today. Repeat ratings are also tracked separately in the smaller daily review count.
- **Practice time today** totals visible practice-session time on the device's local calendar date. Listening, recording, playback, and time spent reading/rating during a session count. The idle deck screen, viewer, and hidden/background tab do not.
- **All-time practice time** sums all recorded days for this deck, across reloads. It begins at the displayed tracking start date; no earlier time is inferred. These totals cover the entire deck, not just the selected HSK level.
- Sessions crossing local midnight are split between the two dates. Historical dates use the timezone active while the time was recorded; timezone changes do not rewrite history.
- Time is checkpointed every five seconds and flushed on end, view changes, page hiding, and cleanup. A long suspended/sleep interval or clock jump is excluded rather than counted as practice. A sudden process kill can lose the last unsaved interval; browser shutdown cannot guarantee an asynchronous final write.
- Failed time writes display an error and remain queued in memory for automatic/manual retry. Retrying a committed batch does not double-count it. Reloading before a failed batch can be saved loses that pending time. Rating counts and schedules commit atomically, so a failed rating does not inflate the totals.

Local builds send no progress to a server. Optional NAS builds send only schedules and activity to the user's private NAS. No recordings are saved with statistics, and no third-party account or analytics service is used.

## Development

No GitHub repository, public deployment, or third-party cloud account is required. Private NAS sync implementation was approved on October 9, 2026; installation/network exposure still requires confirmed NAS details and approval. The `.github` directory contains local Copilot instructions only. Development, preview, and NAS backend servers bind to loopback by default.

Requires Node.js 22.12 or newer and npm. From this project directory:

- `npm install` installs dependencies.
- `npm run prepare:deck` reads the original package from the parent directory and writes generated data to `public/deck/`. Conversion is already complete in this workspace. It supports this inspected HSK model, not arbitrary decks or newer compressed Anki database formats.
- `npm run dev` serves the app at the printed loopback address. The approved preview is at `http://127.0.0.1:5173/`. Use a standalone browser such as Safari for microphone testing; VS Code's embedded browser may restrict microphone permissions.
- `npm run build` type-checks and creates the local production build. Generated deck assets are copied into `dist/`; do not publish this folder.
- `npm run preview` serves the built output locally (a different port is a different review-storage origin).
- `npm run build:nas` creates the optional NAS-mode production build and checks backend types. Like the default build it writes `dist/`; the last build determines its mode.
- `npm run server:start` starts the private NAS backend only after the required secret, public origin, and local data directory are configured. See [NAS_SETUP.md](NAS_SETUP.md); nothing has been installed on the NAS.

Generated assets are ignored by `.gitignore` for privacy. This does not create a Git repository. Do not distribute the original deck or extracted media.

If Node was installed using Homebrew's `node@22`, add `/opt/homebrew/opt/node@22/bin` to your shell PATH, or use a Node version manager with the included `.nvmrc`.

In VS Code, **Terminal → Run Build Task → Build shadowing app** validates the project. **Terminal → Run Task → Preview shadowing app (local only)** starts the preview. Tasks include this Mac's Homebrew Node path without modifying shell configuration.

On iPhone, a Mac's localhost address is not accessible directly. Real-device testing requires a local-network server with HTTPS and a certificate trusted by both devices; this does not require public cloud deployment. LAN access and certificates are not configured yet. Microphone recording on iPhone requires a secure context, so plain HTTP over the LAN is insufficient. Local-mode progress is separate on each device; NAS-mode progress is shared after migration and sign-in.

## Validation

- `npm test`: 390 unit/component tests covering scheduling, IndexedDB validation and migration, atomic activity writes, sanitization, deck validation, playback ordering, recording/cancellation/permissions, timer visibility/cleanup/retry, local midnight boundaries, read-only card browsing, progress backup/import, strict sync validation, NAS authentication, and UI save/retry behavior. Media APIs are mocked in these tests.
- `npm run test:server`: 19 checks of the real SQLite backend, authentication, request boundaries, duplicate retries, atomic rollback, import preservation, restart persistence, and per-card conflicts.
- `npm run test:nas:browser`: one two-client Chromium check against the NAS production build and a disposable loopback backend/database: private sign-in, migration, shared progress, lost-response retry without duplicate counts, logout, and mobile layout. This rebuilds `dist/` in NAS mode; run the regular build again to restore local-mode output.
- `npm run test:browser`: three Chromium tests using real local assets, native browser audio/recording APIs, and a **simulated microphone**. Covers two Chinese plays, image loading, recording playback, rating persistence after reload, skipping, local-only requests, reviewed-card browsing, saved daily/all-time totals, exclusion of viewer time, and a 390-pixel viewport without horizontal overflow. A Playwright Chromium installation is required (installed in this workspace's development environment). Tests use isolated browser profiles, not your saved progress.
- Production TypeScript/Vite build and verification of all 5,777 referenced files passed. The original package SHA-256 still matches the import report.

**Not yet validated:** a physical microphone, Safari on Mac, or a real iPhone. Safari fallback logic is implemented and unit-tested but is not a substitute for device testing. Phone-sized Chromium tests are not iPhone tests.

## Remaining work

- Supply an English audio source if the full bilingual audio sequence is required.
- Real Mac/iPhone Safari testing, including permission denial, autoplay recovery, headphones, screen locking, and interruptions. iPhone testing needs trusted local-network HTTPS; no cloud service is necessary.
- NAS device/runtime confirmation, installation, trusted HTTPS, and backup/restore drills. Implemented sync is online-first and single-user; no NAS deployment has been performed.
- Offline/PWA installation and durable offline synchronization remain unimplemented. The selected local/NAS server must remain available for deck/media access. Local progress export/import is now available.
- General `.apkg` import and migration of existing Anki history remain out of scope for this first deck-specific version.