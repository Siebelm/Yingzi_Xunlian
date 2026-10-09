import { describe, expect, it } from 'vitest';
import { duration, emptyActivity, localDay, PracticeClock, reviewCount, splitTime } from './activity';

describe('activity calculations', () => {
  it('uses local calendar dates and splits sessions at midnight', () => {
    const start = new Date(2026, 9, 9, 23, 59, 58).getTime();
    expect(localDay(start)).toBe('2026-10-09');
    expect(splitTime(start, start + 5000)).toEqual([
      { day: '2026-10-09', timeMs: 2000 }, { day: '2026-10-10', timeMs: 3000 },
    ]);
    expect(splitTime(start, start)).toEqual([]);
  });

  it('formats time including totals longer than a day without wrapping', () => {
    expect(duration(0)).toBe('0m 0s');
    expect(duration(61_999)).toBe('1m 1s');
    expect(duration(25 * 3600_000 + 62_000)).toBe('25h 1m 2s');
  });

  it('never equates a passing streak or lapses to a lifetime review count', () => {
    const activity = emptyActivity(['old']);
    activity.counts = { old: 3, fresh: 4 };
    expect(reviewCount(activity, 'old')).toBe('At least 4');
    expect(reviewCount(activity, 'fresh')).toBe('4');
    expect(reviewCount(activity, 'new')).toBe('0');
  });

  it('counts visible practice, flushes on pause, excludes hidden/viewer time', () => {
    const clock = new PracticeClock();
    const start = new Date(2026, 9, 9, 10).getTime();
    expect(clock.sample(true, start, 0)).toEqual([]);
    expect(clock.sample(true, start + 5000, 5000)[0].timeMs).toBe(5000);
    expect(clock.sample(false, start + 6000, 6000)[0].timeMs).toBe(1000);
    expect(clock.sample(false, start + 16_000, 16_000)).toEqual([]);
    expect(clock.sample(true, start + 30_000, 30_000)).toEqual([]);
    expect(clock.sample(false, start + 32_000, 32_000)[0].timeMs).toBe(2000);
    expect(clock.sample(false, start + 32_000, 32_000)).toEqual([]);
  });

  it('excludes suspension and clock jumps rather than adding hours of inactivity', () => {
    const clock = new PracticeClock();
    clock.sample(true, 100_000, 0);
    expect(clock.sample(true, 200_000, 100_000)).toEqual([]);
    expect(clock.sample(true, 205_000, 105_000)[0].timeMs).toBe(5000);
    expect(clock.sample(true, 100_000, 110_000)).toEqual([]);
  });
});