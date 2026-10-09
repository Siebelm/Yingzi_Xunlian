import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DECK_ID, emptyActivity } from '../activity.ts';
import { scheduleReview } from '../scheduler.ts';
import { assertSnapshot } from '../syncSchema.ts';
import type { ProgressSnapshot } from '../syncSchema.ts';
import { badInput, canonical, HttpError, payloadHash, safeAdd, safeJson } from './validation.ts';
import type { Operation } from './validation.ts';

export interface StateResponse { revision: number; state: ProgressSnapshot }

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) throw new Error('DATA_DIR must be a real local directory.');
    // Known Linux NFS/SMB/CIFS/AFS/Coda mounts are never suitable for this SQLite backend.
    // Other platforms/filesystem drivers still require operator verification (see server README).
    if ([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x5346414f, 0x73757245].includes(statfsSync(dataDir).type)) {
      throw new Error('DATA_DIR must be on local disk, not a network filesystem.');
    }
    chmodSync(dataDir, 0o700);
    const filename = join(realpathSync(dataDir), 'progress.sqlite');
    // Create privately before SQLite can create journal/WAL files. Never follow a database symlink.
    const fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    if (!lstatSync(filename).isFile() || lstatSync(filename).nlink !== 1) throw new Error('Database must be a regular, unlinked local file.');
    chmodSync(filename, 0o600);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        const stat = lstatSync(filename + suffix);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe SQLite sidecar.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 3000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS progress (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          snapshot TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL
        ) STRICT;
      `);
      const initial: ProgressSnapshot = { format: 1, deckId: DECK_ID, reviews: {}, activity: emptyActivity() };
      this.db.prepare('INSERT OR IGNORE INTO progress VALUES (1, 0, ?)').run(JSON.stringify(initial));
      this.read();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  read(): StateResponse {
    const row = this.db.prepare('SELECT revision, snapshot FROM progress WHERE singleton = 1').get() as { revision: number; snapshot: string };
    const state: unknown = JSON.parse(row.snapshot);
    safeJson(state);
    assertSnapshot(state);
    if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid stored revision.');
    return { revision: row.revision, state };
  }

  apply(operation: Operation): StateResponse {
    const hash = payloadHash(operation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT payload_hash FROM receipts WHERE id = ?').get(operation.id) as { payload_hash: string } | undefined;
      const current = this.read();
      if (receipt) {
        if (receipt.payload_hash !== hash) {
          throw new HttpError(409, 'OPERATION_ID_REUSED', 'This operation ID already belongs to a different request. Reload NAS progress; do not retry it with changed data.');
        }
        // Return CURRENT state, not the original response, even if newer operations have committed.
        this.db.exec('COMMIT');
        return current;
      }
      let { state } = current;
      if (operation.kind === 'import') {
        if (current.revision !== 0) {
          throw new HttpError(409, 'NAS_NOT_PRISTINE', 'NAS progress already exists. Import is allowed only before any NAS changes; existing data was not overwritten or merged.');
        }
        state = operation.state;
      } else if (operation.kind === 'review') {
        const { review, expected, day } = operation;
        const previous = Object.hasOwn(state.reviews, review.cardId) ? state.reviews[review.cardId] : null;
        if (canonical(previous) !== canonical(expected)) {
          throw new HttpError(409, 'STALE_REVIEW', 'This card changed on another client. Reload NAS progress and rate the current card again; nothing was saved.');
        }
        const scheduled = scheduleReview(review.cardId, previous ?? undefined, review.rating, review.reviewedAt);
        if (canonical(scheduled) !== canonical(review) || (previous && review.reviewedAt < previous.reviewedAt)) badInput();
        state.reviews[review.cardId] = review;
        const activity = state.activity;
        const oldCount = Object.hasOwn(activity.counts, review.cardId) ? activity.counts[review.cardId] : 0;
        activity.counts[review.cardId] = safeAdd(oldCount, 1);
        const daily = activity.days[day] ??= { cardIds: [], reviews: 0, timeMs: 0 };
        if (!daily.cardIds.includes(review.cardId)) daily.cardIds.push(review.cardId);
        daily.reviews = safeAdd(daily.reviews, 1);
      } else {
        for (const slice of operation.slices) {
          const daily = state.activity.days[slice.day] ??= { cardIds: [], reviews: 0, timeMs: 0 };
          daily.timeMs = safeAdd(daily.timeMs, slice.timeMs);
        }
      }
      try { assertSnapshot(state); } catch { badInput(); }
      const revision = safeAdd(current.revision, 1);
      this.db.prepare('UPDATE progress SET revision = ?, snapshot = ? WHERE singleton = 1').run(revision, JSON.stringify(state));
      this.db.prepare('INSERT INTO receipts (id, payload_hash) VALUES (?, ?)').run(operation.id, hash);
      this.db.exec('COMMIT');
      return { revision, state };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}