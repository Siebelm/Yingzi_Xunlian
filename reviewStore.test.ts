import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReviews, saveReview } from './reviewStore';
import type { Review } from './types';

const DB_NAME = 'shadowing-reviews-v1';
const STORE = 'reviews';

function review(cardId = 'card'): Review {
  return {
    cardId, due: 1_800_259_200_000, intervalDays: 3, repetitions: 1,
    lapses: 0, reviewedAt: 1_800_000_000_000, rating: 'good',
  };
}

// Native IDB helpers intentionally bypass production validation to simulate corruption.
function openRaw(version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawPut(value: unknown): Promise<void> {
  const db = await openRaw();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore(STORE).put(value);
    });
  } finally {
    db.close();
  }
}

async function rawRecords(): Promise<unknown[]> {
  const db = await openRaw();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local review persistence', () => {
  it('loads an empty new database', async () => {
    expect(await loadReviews()).toEqual({});
  });

  it('round-trips metadata and upserts one card without replacing other cards', async () => {
    const first = review();
    const other = review('other');
    await saveReview(first);
    await saveReview(other);
    expect(await loadReviews()).toEqual({ card: first, other });
    const updated: Review = { ...first, rating: 'again', intervalDays: 0, repetitions: 0, lapses: 1, due: first.reviewedAt + 600_000 };
    await saveReview(updated);
    expect(await loadReviews()).toEqual({ card: updated, other });
    expect(await rawRecords()).toHaveLength(2);
  });

  it('snapshots values before asynchronous storage work and supports concurrent saves', async () => {
    const mutable = review();
    const expected = { ...mutable };
    const pending = saveReview(mutable);
    mutable.lapses = 99;
    await Promise.all([pending, saveReview(review('other'))]);
    expect((await loadReviews()).card).toEqual(expected);
  });

  it('round-trips prototype-like IDs as own properties', async () => {
    await saveReview(review('__proto__'));
    await saveReview(review('constructor'));
    const records = await loadReviews();
    expect(Object.hasOwn(records, '__proto__')).toBe(true);
    expect(records['__proto__']).toEqual(review('__proto__'));
    expect(records['constructor']).toEqual(review('constructor'));
    expect(Object.getPrototypeOf(records)).toBe(Object.prototype);
  });

  const invalidReviews: [string, unknown][] = [
    ['null', null], ['array', []], ['missing fields', { cardId: 'card' }],
    ['blank ID', { ...review(), cardId: ' ' }],
    ['numeric ID', { ...review(), cardId: 1 }],
    ['rating', { ...review(), rating: 'great' }],
    ['string timestamp', { ...review(), due: 'tomorrow' }],
    ['NaN', { ...review(), due: NaN }],
    ['infinite timestamp', { ...review(), reviewedAt: Infinity }],
    ['negative timestamp', { ...review(), reviewedAt: -1 }],
    ['fractional interval', { ...review(), intervalDays: 1.5 }],
    ['negative repetitions', { ...review(), repetitions: -1 }],
    ['negative lapses', { ...review(), lapses: -1 }],
    ['unsafe integer', { ...review(), due: Number.MAX_SAFE_INTEGER + 1 }],
    ['recording', { ...review(), recording: new Blob(['audio']) }],
  ];

  it.each(invalidReviews)('rejects invalid input: %s, preserving existing data', async (_name, invalid) => {
    await saveReview(review());
    await expect(saveReview(invalid as Review)).rejects.toThrow(/Invalid review/);
    expect(await loadReviews()).toEqual({ card: review() });
  });

  it.each(invalidReviews.filter(([, value]) =>
    typeof value === 'object' && value !== null && 'cardId' in value,
  ))('rejects corrupted persisted data: %s, without clearing or partial success', async (_name, invalid) => {
    await saveReview(review('valid'));
    // The keyPath requires a usable ID; all other malformed fields are preserved.
    const corrupted = { ...(invalid as object), cardId: 'corrupt' };
    // Blank/numeric ID cases must remain invalid after supplying an IDB string key.
    if (_name === 'blank ID') corrupted.cardId = ' ';
    if (_name === 'numeric ID') Object.assign(corrupted, { cardId: 1 });
    await rawPut(corrupted);
    await expect(loadReviews()).rejects.toThrow(/Invalid persisted review/);
    await expect(loadReviews()).rejects.toThrow(/Existing data was not reset/);
    expect(await rawRecords()).toEqual(expect.arrayContaining([review('valid'), corrupted]));
    expect(await rawRecords()).toHaveLength(2);
  });

  it('rejects a missing store rather than silently rebuilding it', async () => {
    const db = await openRaw();
    db.close();
    await expect(loadReviews()).rejects.toThrow(/schema.*missing/);
    await expect(saveReview(review())).rejects.toThrow(/schema.*missing/);
    const unchanged = await openRaw();
    expect(unchanged.objectStoreNames.contains(STORE)).toBe(false);
    unchanged.close();
  });

  it('rejects an incorrect key schema without resetting it', async () => {
    const db = await openRaw(1, (database) => database.createObjectStore(STORE));
    db.close();
    await expect(loadReviews()).rejects.toThrow(/schema.*cardId/);
    await expect(saveReview(review())).rejects.toThrow(/schema.*cardId/);
  });

  it('reports unavailable IndexedDB instead of falling back to empty data', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(loadReviews()).rejects.toThrow(/IndexedDB is unavailable/);
    await expect(saveReview(review())).rejects.toThrow(/storage permissions/);
  });

  it('reports permission/open failures with actionable context', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError');
    });
    await expect(loadReviews()).rejects.toThrow(/Storage access denied.*storage permissions/);
    await expect(saveReview(review())).rejects.toThrow(/Unable to save local reviews/);
  });

  it('reports asynchronous version errors without deleting newer data', async () => {
    const db = await openRaw(3, (database) => database.createObjectStore(STORE, { keyPath: 'cardId' }));
    db.close();
    await expect(loadReviews()).rejects.toThrow(/Unable to load local reviews/);
    await expect(saveReview(review())).rejects.toThrow(/Existing data was not reset/);
    const unchanged = await openRaw(3);
    expect(unchanged.version).toBe(3);
    expect(unchanged.objectStoreNames.contains(STORE)).toBe(true);
    unchanged.close();
  });
});