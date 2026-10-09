# Project instructions

## Local-only requirements

- Do not create a GitHub repository, push files, deploy the app, or configure third-party cloud accounts. The user approved implementing optional private NAS progress sync on October 9, 2026; actual NAS installation/network exposure still requires confirmed device/runtime details and approval.
- Keep app data local by default; optional authenticated private NAS sync may transfer review schedules and activity only. Never upload recordings. This directory contains local assistant instructions only.
- Bind development and NAS servers to loopback by default. Trusted NAS HTTPS and real iPhone testing remain future setup steps.
- Preserve the original Anki package and guide in the parent directory.

## Workspace setup checklist

- [x] Verify instructions file exists.
- [x] Clarify requirements: React/TypeScript app for Mac and iPhone; local-only for now.
- [x] Scaffold project: Vite foundation in the active Folder workspace.
- [x] Customize app: compact dark interface; real local deck and practice functionality implemented.
- [x] Install required extensions: skipped; none required.
- [x] Compile project: Node 22 and dependencies installed; TypeScript and Vite build passed.
- [x] Create and run task: `Build shadowing app` in `.vscode/tasks.json` passed.
- [x] Launch project: user approved; local Vite server started at http://127.0.0.1:5173/ and opened in VS Code Simple Browser. Real-device testing remains pending.
- [x] Complete setup documentation: README includes launch guidance, local-only limitations, and remaining implementation work.

## Practice implementation checklist

- [x] Inspect original package: 2,501 HSK recognition cards; no English audio, 299 missing sentence clips, 631 missing images.
- [x] Prepare local data with `npm run prepare:deck`; generated `public/deck/` contains 5,777 media files. Original package hash preserved.
- [x] Sanitize full card content and provide Chinese/pinyin visibility and word/sentence audio selection.
- [x] Implement event-driven Chinese playback twice, tap-to-record, immediate playback, explicit autoplay/permission recovery, and cleanup. Never silently synthesize missing English audio.
- [x] Implement local IndexedDB ratings and documented simple SRS; fresh reviews, no Anki history migration.
- [x] Validate with 227 unit/component tests, two real Chromium smoke tests using a simulated microphone, and TypeScript/Vite build.
- [ ] Test physical microphone and real Mac/iPhone Safari; iPhone trusted local HTTPS is not configured.
- [x] Local progress backup/export and empty-store import implemented; offline/PWA installation remains pending.

## Reviewed-card viewer and activity tracking

- [x] Add read-only reviewed-card search and full-card viewing with next due date and lifetime review count.
- [x] Upgrade local IndexedDB without resetting schedules; mark legacy counts as partial rather than guessing earlier review history.
- [x] Track daily unique cards, daily rating count, visible practice time by local date, and all-time tracked practice time. Do not count viewer/background time.
- [x] Cover storage migration, atomic statistics writes, repeat ratings, midnight boundaries, timer cleanup/retry, and read-only browsing in unit/component tests.
- [x] Complete browser persistence/mobile-layout checks and final build: 246 unit/component tests and three Chromium tests passed; TypeScript/Vite build passed. Physical Mac/iPhone Safari checks remain pending.

## Private NAS sync implementation (October 9, 2026)

- [x] User approved optional private NAS implementation; local mode remains default, recordings never upload.
- [x] Authenticated same-origin API with NAS-local SQLite, secure cookies, request limits, per-card conflicts, atomic counts, and durable retry receipts.
- [x] NAS-only build/login UI, progress export and one-time migration into empty storage; no silent merge or overwrite.
- [x] Validation: 390 unit/component tests, 19 backend checks, three local Chromium tests, and one two-client NAS Chromium test passed. Local/NAS builds and backend type checks passed.
- [x] Documented runtime, HTTPS, migration, backup/restore, and online-first limitations in NAS_SETUP.md.
- [ ] Confirm DH4300PLUS-2643 manufacturer/model, NAS OS/runtime, and approved access method before installation or network exposure.
- [ ] Actual NAS deployment, trusted HTTPS, physical Mac/iPhone Safari testing, and backup/restore drill remain pending.
- [ ] Durable client offline queue, multi-user accounts, incremental sync, and PWA remain unimplemented. Pending client requests/time batches are in memory; server receipts persist.

## Development guidelines

- Work in the current workspace; do not create a separate project directory.
- Track multi-step work and update this checklist as progress changes.
- Keep communication concise and distinguish implemented functionality from planned work.
- Use React, TypeScript, and Vite; follow accessible, mobile-first design practices.
- Do not invent Anki field mappings or media; inspect the actual package before implementing import.
- Treat imported HTML as untrusted. Sanitize before rendering.
- Detect supported recording formats and handle Safari autoplay restrictions and microphone failures.
- Recordings are intended for immediate local playback and disposal, not upload.
- Avoid unrelated features, integrations, media, and extensions.
- Validate changes with the build task and relevant tests; do not claim real-device testing without performing it.
- Ask before launching preview/debug mode. No cloud service is needed for local setup.
