import 'fake-indexeddb/auto';
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECK_ID, emptyActivity, localDay } from './activity';
import { exportProgress, importProgress, loadActivity, loadReviews, saveReview } from './reviewStore';
import { scheduleReview } from './scheduler';
import type { ProgressSnapshot } from './syncSchema';

vi.mock('./nasClient', async (original) => ({ ...await original<typeof import('./nasClient')>(), NAS_ENABLED: false }));
const name = 'shadowing-reviews-v1';
function snapshot(id = 'one'): ProgressSnapshot {
  return { format: 1, deckId: DECK_ID,
    reviews: { [id]: scheduleReview(id, undefined, 'good', 1000) },
    activity: { ...emptyActivity(['legacy']), trackedSince: 1000, counts: { [id]: 2 },
      days: { '2026-10-09': { cardIds: [id], reviews: 2, timeMs: 1234 } } } };
}
async function raw() {
  const db = await openDB(name);
  try { return { reviews: await db.getAll('reviews'), activity: await db.getAll('activity'), receipts: await db.getAll('timeReceipts') }; }
  finally { db.close(); }
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Local backups must not probe a server'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('read-only consistent export', () => {
  it('exports an empty profile without persisting synthetic activity', async () => {
    const value = await exportProgress();
    expect(value.reviews).toEqual({});
    expect(value.activity.legacyCardIds).toEqual([]);
    expect(await raw()).toEqual({ reviews: [], activity: [], receipts: [] });
  });

  it('preserves v1 schedules and marks legacy counts without writing invented history', async () => {
    const old = await openDB(name, 1, { upgrade(db) { db.createObjectStore('reviews', { keyPath: 'cardId' }); } });
    const review = scheduleReview('legacy', undefined, 'easy', 1000);
    await old.put('reviews', review); old.close();
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const value = await exportProgress();
    expect(value.reviews).toEqual({ legacy: review });
    expect(value.activity).toMatchObject({ legacyCardIds: ['legacy'], counts: {}, days: {} });
    expect(put).not.toHaveBeenCalled();
    expect(await raw()).toEqual({ reviews: [review], activity: [], receipts: [] });
  });

  it('reads both stores in one readonly transaction and leaves all stored data unchanged', async () => {
    await importProgress(snapshot());
    const before = await raw();
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    expect(await exportProgress()).toEqual(snapshot());
    const calls = transaction.mock.calls.filter(([stores]) => Array.isArray(stores) && stores.includes('reviews'));
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual([['reviews', 'activity'], 'readonly']);
    expect(await raw()).toEqual(before);
  });

  it('does not expose a mixed schedule/activity version during a concurrent rating', async () => {
    await loadActivity();
    const review = scheduleReview('one', undefined, 'good', 1000);
    const [value] = await Promise.all([exportProgress(), saveReview(review)]);
    const count = value.activity.counts.one ?? 0;
    expect(count).toBe(Object.hasOwn(value.reviews, 'one') ? 1 : 0);
    expect(value.activity.days[localDay(1000)]?.reviews ?? 0).toBe(count);
    expect((await exportProgress()).reviews.one).toEqual(review);
  });

  it('rejects corrupt persisted recording fields without repairing or deleting them', async () => {
    await exportProgress();
    const db = await openDB(name);
    const corrupt = { ...snapshot().reviews.one, recording: 'private audio' };
    await db.put('reviews', corrupt); db.close();
    const before = await raw();
    await expect(exportProgress()).rejects.toThrow(/Recordings and extra data/);
    expect(await raw()).toEqual(before);
  });
});

describe('empty-only atomic local import', () => {
  it('roundtrips reviews, partial counts and activity; return values cannot mutate storage', async () => {
    const value = snapshot('__proto__');
    const before = structuredClone(value);
    const importing = importProgress(value);
    value.activity.days['2026-10-09'].timeMs = 999;
    await importing;
    const exported = await exportProgress();
    expect(exported).toEqual(before);
    expect(Object.hasOwn(exported.reviews, '__proto__')).toBe(true);
    exported.activity.counts.__proto__ = 100;
    expect(await exportProgress()).toEqual(before);
  });

  it('allows an initialized but empty activity record', async () => {
    await loadActivity();
    await importProgress(snapshot());
    expect(await exportProgress()).toEqual(snapshot());
  });

  it.each(['reviews', 'counts', 'days', 'legacy'] as const)('refuses existing %s without changing any store', async (kind) => {
    await exportProgress();
    const db = await openDB(name);
    const activity = emptyActivity();
    if (kind === 'reviews') await db.put('reviews', snapshot().reviews.one);
    if (kind === 'counts') activity.counts.old = 0;
    if (kind === 'days') activity.days['2026-10-08'] = { cardIds: [], reviews: 0, timeMs: 1 };
    if (kind === 'legacy') activity.legacyCardIds = ['old'];
    await db.put('activity', activity);
    await db.put('timeReceipts', 'existing-receipt', 'existing-receipt'); db.close();
    const before = await raw();
    await expect(importProgress(snapshot('new'))).rejects.toThrow(/Progress already exists/);
    expect(await raw()).toEqual(before);
  });

  it.each([false, true])('rejects malformed import non-destructively (existing=%s)', async (existing) => {
    if (existing) await importProgress(snapshot());
    else await exportProgress();
    const before = await raw();
    const value = snapshot('new');
    Object.assign(value.activity.days['2026-10-09'], { recording: 'private' });
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await expect(importProgress(value)).rejects.toThrow(/Recordings and extra data/);
    expect(put).not.toHaveBeenCalled();
    expect(await raw()).toEqual(before);
  });

  it('rolls back already-issued review writes if the activity write fails', async () => {
    await exportProgress();
    const before = await raw();
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'activity') throw new DOMException('Simulated quota exhaustion', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(importProgress(snapshot())).rejects.toThrow(/quota exhaustion/);
    expect(await raw()).toEqual(before);
    vi.restoreAllMocks();
    await importProgress(snapshot());
    expect(await loadReviews()).toEqual(snapshot().reviews);
  });

  it('serializes simultaneous imports so only one wins, never mixing their data', async () => {
    await exportProgress();
    const candidates = [snapshot('one'), snapshot('two')];
    const outcomes = await Promise.allSettled(candidates.map(importProgress));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes.findIndex((result) => result.status === 'fulfilled');
    expect(await exportProgress()).toEqual(candidates[winner]);
  });
});