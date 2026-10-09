import { describe, expect, it } from 'vitest';
import { emptyActivity } from './activity';
import { scheduleReview } from './scheduler';
import { assertReview, assertSnapshot, assertTimeBatch, validDay, type ProgressSnapshot } from './syncSchema';

function snapshot(): ProgressSnapshot {
  return {
    format: 1, deckId: 'mandarin-hsk-1-5',
    reviews: { one: scheduleReview('one', undefined, 'good', 1000) },
    activity: { ...emptyActivity(['legacy']), trackedSince: 1000, counts: { one: 1 },
      days: { '2026-10-09': { cardIds: ['one'], reviews: 1, timeMs: 500 } } },
  };
}

describe('strict progress snapshot boundary', () => {
  it('accepts a JSON roundtrip without mutating schedules or partial legacy counts', () => {
    const value = snapshot();
    const before = JSON.stringify(value);
    assertSnapshot(value);
    assertSnapshot(JSON.parse(before));
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each(['root', 'review', 'activity', 'day'])('rejects unknown recording fields at %s', (where) => {
    const value = snapshot();
    const targets: Record<string, object> = { root: value, review: value.reviews.one,
      activity: value.activity, day: value.activity.days['2026-10-09'] };
    Object.assign(targets[where], { recording: 'data:audio/webm;base64,private' });
    expect(() => assertSnapshot(value)).toThrow(/Recordings and extra data/);
  });

  it.each(['format', 'deckId', 'reviews', 'activity'])('rejects a missing %s field', (field) => {
    const value = { ...snapshot() } as Record<string, unknown>;
    delete value[field];
    expect(() => assertSnapshot(value)).toThrow();
  });

  it.each([null, [], '', 42, true])('rejects a non-object snapshot: %j', (value) => {
    expect(() => assertSnapshot(value)).toThrow();
  });

  const corruptions: [string, (value: ProgressSnapshot) => void][] = [
    ['format', (s) => Object.assign(s, { format: 2 })],
    ['wrong deck', (s) => Object.assign(s, { deckId: 'other' })],
    ['activity deck mismatch', (s) => { s.activity.deckId = 'other'; }],
    ['array reviews', (s) => Object.assign(s, { reviews: [] })],
    ['key mismatch', (s) => { s.reviews.one.cardId = 'two'; }],
    ['invalid trackedSince', (s) => { s.activity.trackedSince = -1; }],
    ['out of range trackedSince', (s) => { s.activity.trackedSince = 8640000000000001; }],
    ['duplicate legacy IDs', (s) => { s.activity.legacyCardIds = ['one', 'one']; }],
    ['blank legacy ID', (s) => { s.activity.legacyCardIds = [' ']; }],
    ['negative count', (s) => { s.activity.counts.one = -1; }],
    ['unsafe count', (s) => { s.activity.counts.one = Number.MAX_SAFE_INTEGER + 1; }],
    ['blank count key', (s) => { s.activity.counts[''] = 1; }],
    ['array counts', (s) => Object.assign(s.activity, { counts: [] })],
    ['array days', (s) => Object.assign(s.activity, { days: [] })],
    ['impossible calendar date', (s) => { s.activity.days['2026-02-30'] = s.activity.days['2026-10-09']; }],
    ['duplicate daily IDs', (s) => { s.activity.days['2026-10-09'].cardIds = ['one', 'one']; }],
    ['daily reviews below unique cards', (s) => { s.activity.days['2026-10-09'].reviews = 0; }],
    ['fractional time', (s) => { s.activity.days['2026-10-09'].timeMs = 0.5; }],
    ['NaN time', (s) => { s.activity.days['2026-10-09'].timeMs = NaN; }],
    ['too many legacy IDs', (s) => { s.activity.legacyCardIds = Array.from({ length: 10001 }, (_, i) => String(i)); }],
    ['too many reviews', (s) => { s.reviews = Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [String(i), scheduleReview(String(i), undefined, 'good', 0)])); }],
  ];
  it.each(corruptions)('rejects %s', (_name, corrupt) => {
    const value = snapshot();
    corrupt(value);
    expect(() => assertSnapshot(value)).toThrow();
  });

  it.each(['due', 'intervalDays', 'repetitions', 'lapses', 'reviewedAt'])('requires safe nonnegative integer %s', (field) => {
    for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(() => assertReview({ ...snapshot().reviews.one, [field]: invalid })).toThrow();
    }
  });

  it.each(['', ' ', 'x'.repeat(201)])('rejects invalid card ID %j', (cardId) => {
    expect(() => assertReview({ ...snapshot().reviews.one, cardId })).toThrow();
  });

  it('rejects unknown ratings and out-of-range date timestamps', () => {
    const review = snapshot().reviews.one;
    expect(() => assertReview({ ...review, rating: 'perfect' })).toThrow();
    for (const field of ['due', 'reviewedAt']) {
      expect(() => assertReview({ ...review, [field]: 8640000000000001 })).toThrow();
    }
  });

  it('accepts safe special object keys as own review/count entries', () => {
    const value = snapshot();
    value.reviews = Object.fromEntries([['__proto__', scheduleReview('__proto__', undefined, 'again', 0)]]);
    value.activity.counts = JSON.parse('{"__proto__":1}');
    expect(() => assertSnapshot(value)).not.toThrow();
    expect(Object.hasOwn(value.reviews, '__proto__')).toBe(true);
  });
});

describe('calendar and time receipts', () => {
  it.each(['2024-02-29', '2026-10-09', '2000-02-29'])('accepts calendar day %s', (day) => expect(validDay(day)).toBe(true));
  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-1-01', '2026-10-09T00:00:00Z', '', null])(
    'rejects calendar day %j', (day) => expect(validDay(day)).toBe(false),
  );
  it('accepts a receipt with zero or multiple day slices without changing the ID', () => {
    const batch = { id: 'receipt-1', slices: [{ day: '2026-10-09', timeMs: 0 }, { day: '2026-10-10', timeMs: 1000 }] };
    const before = structuredClone(batch);
    assertTimeBatch(batch);
    assertTimeBatch({ id: 'empty', slices: [] });
    expect(batch).toEqual(before);
  });
  it.each([
    { id: '', slices: [] }, { id: ' ', slices: [] }, { id: 'receipt', slices: null },
    { id: 'receipt', slices: [], recording: 'private' },
    { id: 'receipt', slices: [{ day: '2026-02-30', timeMs: 1 }] },
    { id: 'receipt', slices: [{ day: '2026-10-09', timeMs: -1 }] },
    { id: 'receipt', slices: [{ day: '2026-10-09', timeMs: 1, audio: 'private' }] },
  ])('rejects malformed time batch %#', (batch) => expect(() => assertTimeBatch(batch)).toThrow());
});