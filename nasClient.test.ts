// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECK_ID, emptyActivity, localDay } from './activity';
import { scheduleReview } from './scheduler';
import type { ProgressSnapshot } from './syncSchema';

let client: typeof import('./nasClient');
const fetchMock = vi.fn<typeof fetch>();
function snapshot(): ProgressSnapshot {
  return { format: 1, deckId: DECK_ID, reviews: {}, activity: { ...emptyActivity(), trackedSince: 1000 } };
}
function response(data: unknown = { revision: 0, state: snapshot() }, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}
const requestBody = (index: number) => JSON.parse(String(fetchMock.mock.calls[index][1]?.body));

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_NAS_SYNC', 'false');
  fetchMock.mockReset().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchMock);
  client = await import('./nasClient');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('NAS transport boundary', () => {
  it('has no import-time probe in local mode and never stores or reads browser credentials', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    expect(client.NAS_ENABLED).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await client.nasRequest('login', { password: 'test-only-secret' });
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/login', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: '{"password":"test-only-secret"}',
    }));
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
  });

  it('loads state with a relative same-origin GET and no body, then clears its timeout', async () => {
    vi.useFakeTimers();
    expect(await client.loadNasState()).toEqual({ revision: 0, state: snapshot() });
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/state');
    expect(options).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(options?.body).toBeUndefined();
    expect(options?.headers).toBeUndefined();
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts at 20 seconds, reports an uncertain save, and cleans up the timer', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = client.nasRequest('state');
    const assertion = expect(pending).rejects.toThrow(/pending save may already have committed/);
    await vi.advanceTimersByTimeAsync(19999);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 409, 413, 500])('preserves HTTP %s and the actionable server message', async (status) => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(response({ error: { message: 'Specific server failure' } }, status));
    await expect(client.nasRequest('reviews', {})).rejects.toMatchObject({ status, message: 'Specific server failure' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('provides a fallback error for an error envelope without a message', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503));
    await expect(client.nasRequest('state')).rejects.toMatchObject({ status: 503, message: 'NAS request failed.' });
  });

  it.each(['state', 'login'])('dispatches auth expiry for %s only when it is not a failed login', async (path) => {
    const expired = vi.fn();
    window.addEventListener('nas-auth-expired', expired);
    try {
      fetchMock.mockResolvedValueOnce(response({ error: { message: 'Sign in again' } }, 401));
      await expect(client.nasRequest(path)).rejects.toMatchObject({ status: 401 });
      expect(expired).toHaveBeenCalledTimes(path === 'login' ? 0 : 1);
    } finally { window.removeEventListener('nas-auth-expired', expired); }
  });

  it.each(['network', 'invalid JSON'])('wraps %s failures and retains the original cause', async (kind) => {
    const cause = new Error(kind);
    if (kind === 'network') fetchMock.mockRejectedValueOnce(cause);
    else fetchMock.mockResolvedValueOnce({ ...response(), json: async () => { throw cause; } } as Response);
    await expect(client.nasRequest('state')).rejects.toMatchObject({ message: expect.stringContaining('NAS unavailable'), cause });
  });

  it('emits auth expiry even when a 401 response has an empty/non-JSON body', async () => {
    const expired = vi.fn();
    window.addEventListener('nas-auth-expired', expired);
    try {
      fetchMock.mockResolvedValueOnce({ ...response(undefined, 401), json: async () => { throw new SyntaxError('Empty body'); } } as Response);
      await client.nasRequest('state').catch(() => undefined);
      expect(expired).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('nas-auth-expired', expired); }
  });

  it.each([-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1, null])('rejects invalid server revision %j', async (revision) => {
    fetchMock.mockResolvedValueOnce(response({ revision, state: snapshot() }));
    await expect(client.loadNasState()).rejects.toThrow('Invalid NAS response');
  });

  it('rejects a server snapshot containing recordings', async () => {
    fetchMock.mockResolvedValueOnce(response({ revision: 1, state: { ...snapshot(), recordings: [] } }));
    await expect(client.loadNasState()).rejects.toThrow(/Recordings and extra data/);
  });
});

describe('idempotent NAS review operations', () => {
  it.each(['network', 'invalid state', 'server 500'])('retries the exact ID/body after %s, ignoring changed caller data', async (kind) => {
    const review = scheduleReview('one', undefined, 'good', 1000);
    const expected = scheduleReview('one', undefined, 'again', 0);
    if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('Lost committed response'));
    else if (kind === 'invalid state') fetchMock.mockResolvedValueOnce(response({ revision: 1, state: {} }));
    else fetchMock.mockResolvedValueOnce(response({ error: { message: 'Try again' } }, 500));
    await expect(client.saveNasReview(review, expected)).rejects.toThrow();
    const first = String(fetchMock.mock.calls[0][1]?.body);
    expect(requestBody(0)).toEqual({ id: expect.any(String), expected, review, day: localDay(1000) });
    review.rating = 'easy'; expected.lapses = 99;
    await client.saveNasReview(review, null);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(first);
    await client.recoverNasReviews();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.saveNasReview(review, null);
    expect(requestBody(2).id).not.toBe(requestBody(0).id);
    expect(requestBody(2).review.rating).toBe('easy');
  });

  it.each([400, 409, 413])('clears definitively rejected HTTP %s requests before reloading and creating a new operation', async (status) => {
    const review = scheduleReview('one', undefined, 'good', 1000);
    fetchMock.mockResolvedValueOnce(response({ error: { message: 'Conflict or invalid request' } }, status));
    await expect(client.saveNasReview(review, null)).rejects.toMatchObject({ status });
    await client.recoverNasReviews();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const newer = scheduleReview('one', review, 'easy', 2000);
    const state = snapshot(); state.reviews.one = newer;
    fetchMock.mockResolvedValueOnce(response({ revision: 2, state }));
    const loaded = await client.loadNasState();
    const replacement = scheduleReview('one', loaded.state.reviews.one, 'hard', 3000);
    await client.saveNasReview(replacement, loaded.state.reviews.one);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/reviews', '/api/state', '/api/reviews']);
    expect(requestBody(2)).toMatchObject({ expected: newer, review: replacement });
    expect(requestBody(2).id).not.toBe(requestBody(0).id);
  });

  it('retains independent pending reviews and recovers the exact operations after reauthentication', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 401)).mockRejectedValueOnce(new Error('Offline'));
    await expect(client.saveNasReview(scheduleReview('one', undefined, 'good', 1000), null)).rejects.toThrow();
    await expect(client.saveNasReview(scheduleReview('two', undefined, 'hard', 2000), null)).rejects.toThrow();
    await client.nasRequest('login', { password: 'test-only' });
    await client.recoverNasReviews();
    expect(fetchMock.mock.calls[3][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    expect(fetchMock.mock.calls[4][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    await client.recoverNasReviews();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('retains a failed recovery so a later sign-in can settle it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Offline')).mockRejectedValueOnce(new Error('Still offline'));
    await expect(client.saveNasReview(scheduleReview('one', undefined, 'good', 1000), null)).rejects.toThrow();
    await expect(client.recoverNasReviews()).rejects.toThrow();
    await client.recoverNasReviews();
    expect(new Set(fetchMock.mock.calls.map(([, options]) => options?.body)).size).toBe(1);
  });

  it('sends the caller time receipt ID and slices unchanged on retry', async () => {
    const batch = { id: 'stable-time-receipt', slices: [{ day: '2026-10-09', timeMs: 1000 }, { day: '2026-10-10', timeMs: 2000 }] };
    fetchMock.mockRejectedValueOnce(new Error('Lost reply'));
    await expect(client.saveNasTime(batch)).rejects.toThrow();
    await client.saveNasTime(batch);
    expect(requestBody(0)).toEqual(batch);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
  });
});

describe('uncertain NAS imports', () => {
  it('allows only the same snapshot until uncertainty settles and preserves its operation ID', async () => {
    const state = snapshot();
    fetchMock.mockRejectedValueOnce(new Error('Lost reply'));
    await expect(client.importNasProgress(state)).rejects.toThrow();
    const other = snapshot(); other.activity.trackedSince++;
    await expect(client.importNasProgress(other)).rejects.toThrow(/Retry the same file/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.importNasProgress(structuredClone(state));
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    await client.importNasProgress(other);
    expect(requestBody(2).id).not.toBe(requestBody(0).id);
  });

  it('clones pending import data before callers can mutate it', async () => {
    const state = snapshot();
    const original = structuredClone(state);
    fetchMock.mockRejectedValueOnce(new Error('Lost reply'));
    await expect(client.importNasProgress(state)).rejects.toThrow();
    state.activity.counts.changed = 1;
    await expect(client.importNasProgress(state)).rejects.toThrow(/uncertain result/);
    await client.importNasProgress(original);
    expect(requestBody(1).state).toEqual(original);
  });

  it.each([400, 409, 413])('permits a different file after definitive import rejection %s', async (status) => {
    fetchMock.mockResolvedValueOnce(response({}, status));
    await expect(client.importNasProgress(snapshot())).rejects.toThrow();
    const other = snapshot(); other.activity.trackedSince++;
    await client.importNasProgress(other);
    expect(requestBody(1).state).toEqual(other);
    expect(requestBody(1).id).not.toBe(requestBody(0).id);
  });

  it('validates an import before any network request', async () => {
    await expect(client.importNasProgress({ ...snapshot(), recording: 'private' } as ProgressSnapshot)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});