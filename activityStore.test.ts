import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { loadActivity, loadReviews, savePracticeTime, saveReview } from './reviewStore';
import { DECK_ID, localDay, reviewCount } from './activity';
import { scheduleReview } from './scheduler';

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

describe('statistics storage and migration', () => {
  it('preserves v1 schedules, marks old counts partial, and does not invent time', async () => {
    const old = await openDB('shadowing-reviews-v1', 1, { upgrade(db) { db.createObjectStore('reviews', { keyPath: 'cardId' }); } });
    const review = scheduleReview('hsk:1', undefined, 'good');
    await old.put('reviews', review);
    old.close();
    const activity = await loadActivity();
    expect(await loadReviews()).toEqual({ 'hsk:1': review });
    expect(activity.legacyCardIds).toEqual(['hsk:1']);
    expect(activity.days).toEqual({});
    expect(reviewCount(activity, 'hsk:1')).toBe('At least 1');
    await saveReview(scheduleReview('hsk:1', review, 'again'));
    expect(reviewCount(await loadActivity(), 'hsk:1')).toBe('At least 2');
  });

  it('counts all ratings including Again; unique cards and repeated ratings are distinct', async () => {
    const today = new Date(2026, 9, 9, 10).getTime();
    await saveReview(scheduleReview('hsk:1', undefined, 'good', today));
    await saveReview(scheduleReview('hsk:1', undefined, 'again', today + 1));
    await saveReview(scheduleReview('hsk:2', undefined, 'hard', today + 2));
    const nextDay = new Date(2026, 9, 10, 10).getTime();
    await saveReview(scheduleReview('hsk:1', undefined, 'easy', nextDay));
    const activity = await loadActivity();
    expect(activity.counts).toEqual({ 'hsk:1': 3, 'hsk:2': 1 });
    expect(activity.days[localDay(today)]).toEqual({ cardIds: ['hsk:1', 'hsk:2'], reviews: 3, timeMs: 0 });
    expect(activity.days[localDay(nextDay)].reviews).toBe(1);
    expect(activity.legacyCardIds).toEqual([]);
    expect(reviewCount(activity, 'hsk:1')).toBe('3');
  });

  it('persists time across reloads, separates days, and safely retries a batch', async () => {
    const batch = { id: 'batch-1', slices: [{ day: '2026-10-09', timeMs: 2000 }, { day: '2026-10-10', timeMs: 3000 }] };
    await Promise.all([savePracticeTime(batch), savePracticeTime(batch)]);
    await savePracticeTime({ id: 'batch-2', slices: [{ day: '2026-10-10', timeMs: 1000 }] });
    const activity = await loadActivity();
    expect(Object.values(activity.days).reduce((sum, day) => sum + day.timeMs, 0)).toBe(6000);
    expect(activity.days['2026-10-09'].timeMs).toBe(2000);
    expect(activity.days['2026-10-10'].timeMs).toBe(4000);
    expect(activity.counts).toEqual({});
    expect(await loadActivity()).toEqual(activity);
  });

  it('serializes time and rating writes without losing either update', async () => {
    const now = Date.now();
    await Promise.all([
      saveReview(scheduleReview('hsk:1', undefined, 'good', now)),
      savePracticeTime({ id: 'time', slices: [{ day: localDay(now), timeMs: 5000 }] }),
    ]);
    expect((await loadActivity()).days[localDay(now)]).toEqual({ cardIds: ['hsk:1'], reviews: 1, timeMs: 5000 });
  });

  it('does not advance a schedule when statistics are corrupt', async () => {
    const original = scheduleReview('hsk:1', undefined, 'good');
    await saveReview(original);
    const db = await openDB('shadowing-reviews-v1');
    await db.put('activity', { deckId: DECK_ID, counts: 'corrupt' });
    db.close();
    await expect(saveReview(scheduleReview('hsk:1', original, 'again'))).rejects.toThrow('Invalid activity data');
    await expect(loadActivity()).rejects.toThrow('Invalid activity data');
    expect((await loadReviews())['hsk:1']).toEqual(original);
  });

  it('rejects invalid time and permits a later valid retry', async () => {
    await expect(savePracticeTime({ id: 'retry', slices: [{ day: 'bad', timeMs: -1 }] })).rejects.toThrow('Invalid practice time');
    await savePracticeTime({ id: 'retry', slices: [{ day: '2026-10-09', timeMs: 1000 }] });
    expect((await loadActivity()).days['2026-10-09'].timeMs).toBe(1000);
  });
});