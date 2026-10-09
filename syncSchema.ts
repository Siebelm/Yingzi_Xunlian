import type { Review, Reviews } from './types';
import type { Activity, TimeBatch } from './activity';

export interface ProgressSnapshot {
  format: 1;
  deckId: 'mandarin-hsk-1-5';
  reviews: Reviews;
  activity: Activity;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Invalid progress fields. Recordings and extra data are not accepted.');
  }
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() !== '';
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10000 && value.every(id) && new Set(value).size === value.length;
}
export function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function assertReview(value: unknown): asserts value is Review {
  exact(value, ['cardId', 'due', 'intervalDays', 'repetitions', 'lapses', 'reviewedAt', 'rating']);
  if (!id(value.cardId) || !['again', 'hard', 'good', 'easy'].includes(value.rating as string)
    || ['due', 'intervalDays', 'repetitions', 'lapses', 'reviewedAt'].some((key) => !integer(value[key]))
    || (value.due as number) > 8640000000000000 || (value.reviewedAt as number) > 8640000000000000) {
    throw new Error('Invalid review data.');
  }
}
export function assertSnapshot(value: unknown): asserts value is ProgressSnapshot {
  exact(value, ['format', 'deckId', 'reviews', 'activity']);
  if (value.format !== 1 || value.deckId !== 'mandarin-hsk-1-5' || !record(value.reviews)
    || Object.keys(value.reviews).length > 10000) throw new Error('Invalid progress format or deck.');
  for (const [key, review] of Object.entries(value.reviews)) {
    assertReview(review);
    if (key !== review.cardId) throw new Error('Review key does not match card ID.');
  }
  const activity = value.activity;
  exact(activity, ['deckId', 'trackedSince', 'legacyCardIds', 'counts', 'days']);
  if (activity.deckId !== value.deckId || !integer(activity.trackedSince) || activity.trackedSince > 8640000000000000 || !ids(activity.legacyCardIds)
    || !record(activity.counts) || !record(activity.days) || Object.keys(activity.days).length > 40000
    || Object.keys(activity.counts).length > 10000
    || Object.entries(activity.counts).some(([key, n]) => !id(key) || !integer(n))) throw new Error('Invalid activity data.');
  for (const [day, data] of Object.entries(activity.days)) {
    exact(data, ['cardIds', 'reviews', 'timeMs']);
    if (!validDay(day) || !ids(data.cardIds) || !integer(data.reviews) || !integer(data.timeMs)
      || data.reviews < data.cardIds.length) throw new Error('Invalid daily activity data.');
  }
}
export function assertTimeBatch(value: unknown): asserts value is TimeBatch {
  exact(value, ['id', 'slices']);
  if (!id(value.id) || !Array.isArray(value.slices) || value.slices.length > 10000) throw new Error('Invalid practice time.');
  for (const slice of value.slices) {
    exact(slice, ['day', 'timeMs']);
    if (!validDay(slice.day) || !integer(slice.timeMs)) throw new Error('Invalid practice time.');
  }
}