import type { Card, Rating, Review, Reviews } from './types';

const DAY_MS = 24 * 60 * 60 * 1_000;
const AGAIN_MS = 10 * 60 * 1_000;

/**
 * A deliberately simple SRS, not Anki-compatible. Days are fixed 24-hour
 * durations, not calendar days. Again resets the passing streak, so the next
 * pass uses the first-pass intervals (Hard 1, Good 3, Easy 5 days).
 */
export function scheduleReview(
  cardId: string,
  previous: Review | undefined,
  rating: Rating,
  now: number = Date.now(),
): Review {
  let intervalDays = 0;
  if (rating !== 'again') {
    const minimum = { hard: 1, good: 3, easy: 5 }[rating];
    const multiplier = { hard: 1.2, good: 2, easy: 3 }[rating];
    intervalDays = !previous || previous.repetitions === 0
      ? minimum
      : Math.max(minimum, Math.ceil(previous.intervalDays * multiplier));
  }

  return {
    cardId,
    due: now + (rating === 'again' ? AGAIN_MS : intervalDays * DAY_MS),
    intervalDays,
    repetitions: rating === 'again' ? 0 : (previous?.repetitions ?? 0) + 1,
    lapses: (previous?.lapses ?? 0) + (rating === 'again' ? 1 : 0),
    reviewedAt: now,
    rating,
  };
}

function reviewFor(card: Card, reviews: Reviews): Review | undefined {
  return Object.hasOwn(reviews, card.id) ? reviews[card.id] : undefined;
}

function compareCardOrder(a: Card, b: Card): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Due reviewed cards first, then new cards; ties use order, then card ID. */
export function getDueCards(cards: Card[], reviews: Reviews, now: number): Card[] {
  return cards.filter((card) => {
    const review = reviewFor(card, reviews);
    return !review || review.due <= now;
  }).sort((a, b) => {
    const aReview = reviewFor(a, reviews);
    const bReview = reviewFor(b, reviews);
    if (aReview && bReview) {
      return aReview.due - bReview.due || compareCardOrder(a, b);
    }
    if (aReview) return -1;
    if (bReview) return 1;
    return compareCardOrder(a, b);
  });
}

/** Earliest strictly future review for these cards; new/orphan reviews don't count. */
export function nextDueAt(cards: Card[], reviews: Reviews, now: number): number | null {
  let earliest: number | null = null;
  for (const card of cards) {
    const review = reviewFor(card, reviews);
    if (review && review.due > now && (earliest === null || review.due < earliest)) {
      earliest = review.due;
    }
  }
  return earliest;
}