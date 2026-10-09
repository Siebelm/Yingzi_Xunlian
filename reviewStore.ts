import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Review, Reviews } from './types';
import { DECK_ID, emptyActivity, localDay, type Activity, type TimeBatch } from './activity';
import { NAS_ENABLED, loadNasState, saveNasReview, saveNasTime, importNasProgress } from './nasClient';
import { assertSnapshot, type ProgressSnapshot } from './syncSchema';

let nasReviews: Reviews | undefined;

// Keep the database name stable; version 2 adds statistics without resetting reviews.
const DB_NAME = 'shadowing-reviews-v1';
const DB_VERSION = 2;
const STORE_NAME = 'reviews';

interface ReviewDatabase extends DBSchema {
  reviews: { key: string; value: Review };
  activity: { key: string; value: Activity };
  timeReceipts: { key: string; value: string };
}

const numericFields = ['due', 'intervalDays', 'repetitions', 'lapses', 'reviewedAt'] as const;
const fields = ['cardId', 'rating', ...numericFields];

/** Reject malformed records, including unknown fields; never salvage/reset data. */
function assertReview(value: unknown, context: string): asserts value is Review {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${context}: expected a review object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    throw new Error(`Invalid ${context}: expected only the Review fields (no recordings or extra data).`);
  }
  if (typeof record.cardId !== 'string' || record.cardId.trim() === '') {
    throw new Error(`Invalid ${context}: cardId must be a nonempty string.`);
  }
  if (!['again', 'hard', 'good', 'easy'].includes(record.rating as string)) {
    throw new Error(`Invalid ${context}: unknown rating.`);
  }
  // All times are integer epoch milliseconds; intervals/counters are integers.
  for (const field of numericFields) {
    const number = record[field];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
      throw new Error(`Invalid ${context}: ${field} must be a nonnegative safe integer.`);
    }
  }
}

function storageError(action: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Unable to ${action} local reviews: ${detail} Existing data was not reset. `
    + 'Check browser storage permissions/private-browsing restrictions; close other app tabs if an upgrade is blocked.',
    { cause },
  );
}

function openReviews(): Promise<IDBPDatabase<ReviewDatabase>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser. Use a browser with local storage enabled.'));
  }
  return new Promise((resolve, reject) => {
    let wasBlocked = false;
    const opening = openDB<ReviewDatabase>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion === 0) db.createObjectStore(STORE_NAME, { keyPath: 'cardId' });
        if (oldVersion < 2) {
          db.createObjectStore('activity', { keyPath: 'deckId' });
          db.createObjectStore('timeReceipts');
        }
      },
      blocked() {
        wasBlocked = true;
        reject(new Error('IndexedDB upgrade is blocked. Close other app tabs, then retry.'));
      },
    });
    void opening.then((db) => {
      // A blocked request may finish after its caller has already seen an error.
      if (wasBlocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    }, reject);
  });
}

function transactionFor<Mode extends 'readonly' | 'readwrite'>(db: IDBPDatabase<ReviewDatabase>, mode: Mode) {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    throw new Error('Invalid review database schema: the reviews store is missing.');
  }
  const transaction = db.transaction(STORE_NAME, mode);
  // Observe aborts even if a synchronous schema/request error exits the caller.
  void transaction.done.catch(() => undefined);
  if (transaction.store.keyPath !== 'cardId' || transaction.store.autoIncrement) {
    throw new Error('Invalid review database schema: expected cardId keys without auto-increment.');
  }
  return transaction;
}

/** Loads all reviews or rejects with a visible/actionable error; never returns a partial reset. */
export async function loadReviews(): Promise<Reviews> {
  if (NAS_ENABLED) {
    nasReviews = (await loadNasState()).state.reviews;
    return structuredClone(nasReviews);
  }
  let db: IDBPDatabase<ReviewDatabase> | undefined;
  try {
    db = await openReviews();
    const transaction = transactionFor(db, 'readonly');
    const [records, keys] = await Promise.all([
      transaction.store.getAll(),
      transaction.store.getAllKeys(),
      transaction.done,
    ]);
    const entries = records.map((record: unknown, index) => {
      assertReview(record, `persisted review at key ${String(keys[index])}`);
      if (keys[index] !== record.cardId) {
        throw new Error('Invalid persisted review: storage key does not match cardId.');
      }
      return [record.cardId, record] as const;
    });
    // Unlike property assignment, fromEntries safely handles IDs like "__proto__".
    return Object.fromEntries(entries);
  } catch (cause) {
    throw storageError('load', cause);
  } finally {
    db?.close();
  }
}

/** Validates before writing; resolves only after the transaction commits. */
export async function saveReview(review: Review): Promise<void> {
  if (NAS_ENABLED) {
    if (!nasReviews) throw new Error('Load NAS progress before saving a review.');
    return saveNasReview(review, Object.hasOwn(nasReviews, review.cardId) ? nasReviews[review.cardId] : null);
  }
  let db: IDBPDatabase<ReviewDatabase> | undefined;
  try {
    assertReview(review, 'review');
    const snapshot = { ...review };
    db = await openReviews();
    // Validate schema before opening the multi-store transaction.
    await transactionFor(db, 'readonly').done;
    const transaction = db.transaction(['reviews', 'activity'], 'readwrite');
    void transaction.done.catch(() => undefined);
    try {
      const stored = await transaction.objectStore('activity').get(DECK_ID);
      const activity = stored ?? emptyActivity(await transaction.objectStore('reviews').getAllKeys());
      assertActivity(activity);
      const count = Object.hasOwn(activity.counts, snapshot.cardId) ? activity.counts[snapshot.cardId] : 0;
      // defineProperty safely supports even IDs such as "__proto__".
      Object.defineProperty(activity.counts, snapshot.cardId, { value: count + 1, enumerable: true, writable: true, configurable: true });
      const day = activity.days[localDay(snapshot.reviewedAt)] ?? { cardIds: [], reviews: 0, timeMs: 0 };
      if (!day.cardIds.includes(snapshot.cardId)) day.cardIds.push(snapshot.cardId);
      day.reviews++;
      activity.days[localDay(snapshot.reviewedAt)] = day;
      assertActivity(activity);
      await transaction.objectStore('reviews').put(snapshot);
      await transaction.objectStore('activity').put(activity);
      await transaction.done;
    } catch (cause) {
      try { transaction.abort(); } catch { /* Already aborted. */ }
      throw cause;
    }
  } catch (cause) {
    throw storageError('save', cause);
  } finally {
    db?.close();
  }
}

function assertActivity(value: Activity): void {
  const integer = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every((id) => typeof id === 'string') && new Set(v).size === v.length;
  if (!record(value) || value.deckId !== DECK_ID || !integer(value.trackedSince) || !ids(value.legacyCardIds)
    || !record(value.counts) || Object.values(value.counts).some((n) => !integer(n)) || !record(value.days)
    || Object.entries(value.days).some(([day, data]) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || !record(data)
      || !ids(data.cardIds) || !integer(data.reviews) || !integer(data.timeMs))) {
    throw new Error('Invalid activity data. Existing statistics were not reset.');
  }
}

/** Lazy migration records which counts are incomplete; never invent old activity. */
export async function loadActivity(): Promise<Activity> {
  if (NAS_ENABLED) return (await loadNasState()).state.activity;
  let db: IDBPDatabase<ReviewDatabase> | undefined;
  try {
    db = await openReviews();
    const transaction = db.transaction(['reviews', 'activity'], 'readwrite');
    void transaction.done.catch(() => undefined);
    const stored = await transaction.objectStore('activity').get(DECK_ID);
    const activity = stored ?? emptyActivity(await transaction.objectStore('reviews').getAllKeys());
    assertActivity(activity);
    if (!stored) await transaction.objectStore('activity').put(activity);
    await transaction.done;
    return activity;
  } catch (cause) {
    throw storageError('load activity for', cause);
  } finally { db?.close(); }
}

/** Receipt and totals commit together so a retry cannot double-count time. */
export async function savePracticeTime(batch: TimeBatch): Promise<void> {
  if (NAS_ENABLED) return saveNasTime(batch);
  if (!batch.id || !Array.isArray(batch.slices) || batch.slices.some((slice) =>
    !/^\d{4}-\d{2}-\d{2}$/.test(slice.day) || !Number.isSafeInteger(slice.timeMs) || slice.timeMs < 0)) {
    throw new Error('Invalid practice time.');
  }
  const snapshot = structuredClone(batch);
  let db: IDBPDatabase<ReviewDatabase> | undefined;
  try {
    db = await openReviews();
    const transaction = db.transaction(['reviews', 'activity', 'timeReceipts'], 'readwrite');
    void transaction.done.catch(() => undefined);
    try {
      if (await transaction.objectStore('timeReceipts').get(snapshot.id)) { await transaction.done; return; }
      const stored = await transaction.objectStore('activity').get(DECK_ID);
      const activity = stored ?? emptyActivity(await transaction.objectStore('reviews').getAllKeys());
      assertActivity(activity);
      for (const slice of snapshot.slices) {
        const day = activity.days[slice.day] ?? { cardIds: [], reviews: 0, timeMs: 0 };
        day.timeMs += slice.timeMs;
        if (!Number.isSafeInteger(day.timeMs)) throw new Error('Practice time overflow.');
        activity.days[slice.day] = day;
      }
      await transaction.objectStore('activity').put(activity);
      await transaction.objectStore('timeReceipts').put(snapshot.id, snapshot.id);
      await transaction.done;
    } catch (cause) {
      try { transaction.abort(); } catch { /* Already aborted. */ }
      throw cause;
    }
  } catch (cause) { throw storageError('save practice time for', cause); }
  finally { db?.close(); }
}

/** One consistent transaction; exporting never changes schedules or totals. */
export async function exportProgress(): Promise<ProgressSnapshot> {
  if (NAS_ENABLED) return (await loadNasState()).state;
  const db = await openReviews();
  try {
    const tx = db.transaction(['reviews', 'activity'], 'readonly');
    void tx.done.catch(() => undefined);
    const [records, stored] = await Promise.all([
      tx.objectStore('reviews').getAll(), tx.objectStore('activity').get(DECK_ID),
    ]);
    await tx.done;
    const result: ProgressSnapshot = {
      format: 1, deckId: DECK_ID,
      reviews: Object.fromEntries(records.map((review) => [review.cardId, review])),
      activity: stored ?? emptyActivity(records.map((review) => review.cardId)),
    };
    assertSnapshot(result);
    return result;
  } finally { db.close(); }
}

/** Import once into empty storage only; never guess how to merge existing history. */
export async function importProgress(value: unknown): Promise<void> {
  assertSnapshot(value);
  const snapshot = structuredClone(value);
  if (NAS_ENABLED) return importNasProgress(snapshot);
  const db = await openReviews();
  try {
    const tx = db.transaction(['reviews', 'activity'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const activity = await tx.objectStore('activity').get(DECK_ID);
      if (await tx.objectStore('reviews').count() || (activity && (
        Object.keys(activity.counts).length || Object.keys(activity.days).length || activity.legacyCardIds.length
      ))) throw new Error('Progress already exists. Restore into an empty browser profile; existing data was not overwritten.');
      for (const review of Object.values(snapshot.reviews)) await tx.objectStore('reviews').put(review);
      await tx.objectStore('activity').put(snapshot.activity);
      await tx.done;
    } catch (cause) {
      try { tx.abort(); } catch { /* Already settled. */ }
      throw cause;
    }
  } finally { db.close(); }
}