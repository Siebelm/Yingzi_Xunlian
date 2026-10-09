import { localDay, type TimeBatch } from './activity';
import type { Review } from './types';
import { assertSnapshot, type ProgressSnapshot } from './syncSchema';

/** Separate build mode: local builds never probe or send data to a server. */
export const NAS_ENABLED = import.meta.env.VITE_NAS_SYNC === 'true';
export class NasError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export interface NasState { revision: number; state: ProgressSnapshot }

export async function nasRequest(path: string, body?: unknown): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const response = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: abort.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.status === 401 && path !== 'login') window.dispatchEvent(new Event('nas-auth-expired'));
    const data = await response.json().catch((cause: unknown) => {
      if (!response.ok) throw new NasError('NAS request failed. Check the server or sign in again.', response.status);
      throw cause;
    });
    if (!response.ok) {
      throw new NasError(typeof data?.error?.message === 'string' ? data.error.message : 'NAS request failed.', response.status);
    }
    return data;
  } catch (cause) {
    if (cause instanceof NasError) throw cause;
    throw new Error('NAS unavailable. Check your connection. A pending save may already have committed; retry it without changing the rating.', { cause });
  } finally { clearTimeout(timer); }
}

function stateResponse(value: unknown): NasState {
  const result = value as NasState;
  if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('Invalid NAS response.');
  assertSnapshot(result.state);
  return result;
}
export async function loadNasState(): Promise<NasState> {
  return stateResponse(await nasRequest('state'));
}

// Retain the exact operation through uncertain responses. Never replay it with a new ID.
const pendingReviews = new Map<string, { id: string; expected: Review | null; review: Review; day: string }>();
export async function saveNasReview(review: Review, expected: Review | null): Promise<void> {
  let operation = pendingReviews.get(review.cardId);
  if (!operation) {
    operation = { id: crypto.randomUUID(), expected: structuredClone(expected), review: { ...review }, day: localDay(review.reviewedAt) };
    pendingReviews.set(review.cardId, operation);
  }
  try {
    stateResponse(await nasRequest('reviews', operation));
    pendingReviews.delete(review.cardId);
  } catch (cause) {
    // A definitive rejection cannot have committed. Network failures retain the exact request.
    if (cause instanceof NasError && [400, 409, 413].includes(cause.status)) pendingReviews.delete(review.cardId);
    throw cause;
  }
}
export async function saveNasTime(batch: TimeBatch): Promise<void> {
  stateResponse(await nasRequest('time', batch));
}
/** Session expiry remounts the app; settle unchanged in-memory requests before reloading schedules. */
export async function recoverNasReviews(): Promise<void> {
  for (const operation of [...pendingReviews.values()]) await saveNasReview(operation.review, operation.expected);
}
let pendingImport: { id: string; state: ProgressSnapshot } | undefined;
export async function importNasProgress(state: ProgressSnapshot): Promise<void> {
  assertSnapshot(state);
  if (pendingImport && JSON.stringify(pendingImport.state) !== JSON.stringify(state)) {
    throw new Error('An earlier import has an uncertain result. Retry the same file or reload to inspect NAS progress first.');
  }
  pendingImport ??= { id: crypto.randomUUID(), state: structuredClone(state) };
  try {
    stateResponse(await nasRequest('import', pendingImport));
    pendingImport = undefined;
  } catch (cause) {
    if (cause instanceof NasError && [400, 409, 413].includes(cause.status)) pendingImport = undefined;
    throw cause;
  }
}