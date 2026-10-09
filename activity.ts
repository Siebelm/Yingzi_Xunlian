/** Calendar days use the device's local timezone, not UTC or fixed 24-hour days. */
export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export interface DailyActivity {
  cardIds: string[];
  reviews: number;
  timeMs: number;
}

export interface Activity {
  deckId: string;
  trackedSince: number;
  legacyCardIds: string[];
  counts: Record<string, number>;
  days: Record<string, DailyActivity>;
}

export interface TimeSlice { day: string; timeMs: number }
export interface TimeBatch { id: string; slices: TimeSlice[] }
export const DECK_ID = 'mandarin-hsk-1-5';

export function emptyActivity(legacyCardIds: string[] = []): Activity {
  return { deckId: DECK_ID, trackedSince: Date.now(), legacyCardIds, counts: {}, days: {} };
}

export function reviewCount(activity: Activity, cardId: string): string {
  const tracked = Object.hasOwn(activity.counts, cardId) ? activity.counts[cardId] : 0;
  return activity.legacyCardIds.includes(cardId) ? `At least ${tracked + 1}` : String(tracked);
}

export function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : `${minutes}m ${seconds % 60}s`;
}

/** Split a wall-clock span at local midnight (also handles DST-length days). */
export function splitTime(start: number, end: number): TimeSlice[] {
  const slices: TimeSlice[] = [];
  while (start < end) {
    const midnight = new Date(start);
    midnight.setHours(24, 0, 0, 0);
    const until = Math.min(end, midnight.getTime());
    slices.push({ day: localDay(start), timeMs: until - start });
    start = until;
  }
  return slices;
}

/** Counts visible practice only. Ignore long timer gaps (sleep/suspended tabs). */
export class PracticeClock {
  private last: { wall: number; monotonic: number } | null = null;
  sample(active: boolean, wall = Date.now(), monotonic = performance.now()): TimeSlice[] {
    const previous = this.last;
    this.last = active ? { wall, monotonic } : null;
    if (!previous) return [];
    const elapsed = Math.floor(monotonic - previous.monotonic);
    const wallElapsed = wall - previous.wall;
    if (elapsed <= 0 || elapsed > 15_000 || Math.abs(wallElapsed - elapsed) > 2_000) return [];
    return splitTime(wall - elapsed, wall);
  }
}