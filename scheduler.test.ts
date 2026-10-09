import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDueCards, nextDueAt, scheduleReview } from './scheduler';
import type { Card, Rating, Review, Reviews } from './types';

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

function card(id: string, order: number): Card {
  return {
    id, order, level: '', word: '', homograph: '', pinyin: '', meaning: '',
    partOfSpeech: '', sentence: '', sentencePinyin: '', sentenceMeaning: '',
    wordAudio: null, sentenceAudio: null, englishAudio: null, images: [],
  };
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    cardId: 'card', due: NOW, intervalDays: 4, repetitions: 2,
    lapses: 3, reviewedAt: NOW - DAY_MS, rating: 'good', ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('scheduleReview (simple SRS, not Anki)', () => {
  it.each<[Rating, number, number, number]>([
    ['again', 0, 0, 1], ['hard', 1, 1, 0], ['good', 3, 1, 0], ['easy', 5, 1, 0],
  ])('schedules the first %s', (rating, intervalDays, repetitions, lapses) => {
    expect(scheduleReview('new', undefined, rating, NOW)).toEqual({
      cardId: 'new', due: NOW + (rating === 'again' ? 600_000 : intervalDays * DAY_MS),
      intervalDays, repetitions, lapses, reviewedAt: NOW, rating,
    });
  });

  it.each<[Rating, number]>([['hard', 5], ['good', 8], ['easy', 12]])(
    'multiplies/rounds the interval for subsequent %s and preserves lapses',
    (rating, intervalDays) => {
      const previous = Object.freeze(review());
      expect(scheduleReview('card', previous, rating, NOW)).toEqual({
        cardId: 'card', due: NOW + intervalDays * DAY_MS, intervalDays,
        repetitions: 3, lapses: 3, reviewedAt: NOW, rating,
      });
      expect(previous).toEqual(review());
    },
  );

  it.each<[Rating, number]>([['hard', 1], ['good', 3], ['easy', 5]])(
    'applies the subsequent %s minimum', (rating, minimum) => {
      expect(scheduleReview('card', review({ intervalDays: 0 }), rating, NOW).intervalDays).toBe(minimum);
    },
  );

  it('resets repetitions/interval on Again and increments every lapse', () => {
    const first = scheduleReview('card', review(), 'again', NOW);
    expect(first).toEqual({
      cardId: 'card', due: NOW + 600_000, intervalDays: 0, repetitions: 0,
      lapses: 4, reviewedAt: NOW, rating: 'again',
    });
    const second = scheduleReview('card', first, 'again', NOW + 600_000);
    expect(second.lapses).toBe(5);
    expect(second.repetitions).toBe(0);
    expect(second.due).toBe(NOW + 1_200_000);
  });

  it.each<[Rating, number]>([['hard', 1], ['good', 3], ['easy', 5]])(
    'uses the first-pass interval for %s after Again', (rating, intervalDays) => {
      const failed = scheduleReview('card', review(), 'again', NOW);
      expect(scheduleReview('card', failed, rating, NOW + 600_000)).toMatchObject({
        intervalDays, repetitions: 1, lapses: 4,
        due: NOW + 600_000 + intervalDays * DAY_MS,
      });
    },
  );

  it('defaults to Date.now and uses fixed 24-hour milliseconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(scheduleReview('card', undefined, 'hard')).toMatchObject({
      reviewedAt: NOW, due: NOW + DAY_MS,
    });
  });
});

describe('due selection', () => {
  const cards = [
    card('new-z', 2), card('late', 0), card('new-a', 2), card('future', 0),
    card('tie-z', 3), card('early', 10), card('new-first', 1), card('tie-a', 3),
  ];
  const reviews: Reviews = Object.fromEntries([
    review({ cardId: 'early', due: NOW - 100 }),
    review({ cardId: 'late', due: NOW }),
    review({ cardId: 'tie-z', due: NOW }),
    review({ cardId: 'tie-a', due: NOW }),
    review({ cardId: 'future', due: NOW + 1 }),
    review({ cardId: 'orphan', due: NOW - 200 }),
  ].map((item) => [item.cardId, item]));

  it('orders due timestamps before new cards, with deterministic order/ID ties', () => {
    const original = [...cards];
    const expected = ['early', 'late', 'tie-a', 'tie-z', 'new-first', 'new-a', 'new-z'];
    expect(getDueCards(cards, reviews, NOW).map((item) => item.id)).toEqual(expected);
    expect(getDueCards([...cards].reverse(), reviews, NOW).map((item) => item.id)).toEqual(expected);
    expect(cards).toEqual(original);
  });

  it('includes the exact due boundary, excludes one millisecond before it', () => {
    const single = [card('late', 0)];
    expect(getDueCards(single, reviews, NOW - 1)).toEqual([]);
    expect(getDueCards(single, reviews, NOW)).toEqual(single);
    expect(getDueCards(single, reviews, NOW + 1)).toEqual(single);
  });

  it('returns only the earliest strictly future due time for the given cards', () => {
    const futureReviews = {
      ...reviews,
      later: review({ cardId: 'later', due: NOW + 100 }),
      orphan: review({ cardId: 'orphan', due: NOW + 0.5 }),
    };
    expect(nextDueAt([...cards, card('later', 0)], futureReviews, NOW)).toBe(NOW + 1);
    expect(nextDueAt(cards, reviews, NOW + 1)).toBeNull();
    expect(nextDueAt([card('late', 0)], reviews, NOW - 1)).toBe(NOW);
    expect(nextDueAt([card('late', 0)], reviews, NOW)).toBeNull();
  });

  it('handles empty collections, new cards, and prototype-like IDs', () => {
    const newCards = [card('__proto__', 2), card('constructor', 1)];
    expect(getDueCards([], reviews, NOW)).toEqual([]);
    expect(nextDueAt([], reviews, NOW)).toBeNull();
    expect(nextDueAt(newCards, {}, NOW)).toBeNull();
    expect(getDueCards(newCards, {}, NOW)).toEqual([...newCards].reverse());
  });
});