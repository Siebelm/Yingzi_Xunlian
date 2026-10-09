// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import NasGate from './NasGate';
import { loadDeck } from './deck';
import { DECK_ID, emptyActivity } from './activity';
import { recoverNasReviews } from './nasClient';
import { scheduleReview } from './scheduler';
import type { Card, Deck, Review } from './types';
import type { ProgressSnapshot } from './syncSchema';

vi.mock('./nasClient', async (original) => ({ ...await original<typeof import('./nasClient')>(), NAS_ENABLED: true }));
vi.mock('./deck', async (original) => ({ ...await original<typeof import('./deck')>(), loadDeck: vi.fn() }));
vi.mock('./practice', async (original) => ({
  ...await original<typeof import('./practice')>(),
  // Fake only media; App, gate, PracticeCard, scheduler, reviewStore, activity,
  // and NAS operation retention remain integrated.
  PracticeSession: class {
    constructor(private emit: (state: { phase: 'review'; label: string }) => void) {}
    start() { this.emit({ phase: 'review', label: 'Ready to rate (mock media)' }); }
    dispose() {}
    interrupt() {}
    cancel() {}
  },
}));
const fetchMock = vi.fn<typeof fetch>();
let state: ProgressSnapshot;
let reviewReply: (operation: { id: string; expected: Review | null; review: Review }) => Promise<Response>;
function reply(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) } as Response;
}
const stateReply = () => reply({ revision: 1, state });
const reviewCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/reviews');
const stateCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/state');
const body = (index: number) => JSON.parse(String(reviewCalls()[index][1]?.body));
function fixture(): Deck {
  const card: Card = { id: 'one', order: 1, level: 'HSK1', word: '好', homograph: '', pinyin: 'hǎo', meaning: 'good',
    partOfSpeech: 'adjective', sentence: '你好。', sentencePinyin: 'nǐ hǎo', sentenceMeaning: 'Hello.',
    wordAudio: `media/${'a'.repeat(64)}.mp3`, sentenceAudio: `media/${'b'.repeat(64)}.mp3`, englishAudio: null, images: [] };
  return { version: 1, id: DECK_ID, name: 'NAS test deck', cards: [card, { ...card, id: 'two', order: 2, word: '水' }],
    report: { cards: 2, missingEnglishAudio: 2, missingWordAudio: 0, missingSentenceAudio: 0,
      missingImages: 2, mediaFiles: 2, sourceSha256: 'e'.repeat(64) } };
}
async function start(gated = false) {
  const user = userEvent.setup();
  render(gated ? <NasGate><App /></NasGate> : <App />);
  await user.click(await screen.findByRole('button', { name: 'Start Review' }));
  await screen.findByRole('group', { name: 'Next review' });
  return user;
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.spyOn(indexedDB, 'open');
  vi.spyOn(Storage.prototype, 'setItem');
  vi.spyOn(Storage.prototype, 'getItem');
  vi.mocked(loadDeck).mockReset().mockResolvedValue(fixture());
  state = { format: 1, deckId: DECK_ID, reviews: {}, activity: emptyActivity() };
  reviewReply = async (operation) => { state.reviews[operation.review.cardId] = operation.review; return stateReply(); };
  fetchMock.mockReset().mockImplementation(async (url, options) => {
    if (url === '/api/state' || url === '/api/time') return stateReply();
    if (url === '/api/session' || url === '/api/login') return reply({ authenticated: true });
    if (url === '/api/reviews') return reviewReply(JSON.parse(String(options?.body)));
    throw new Error(`Unexpected network call: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => { cleanup(); });
  // Empty the module's in-memory retry queue without touching real storage.
  fetchMock.mockResolvedValue(stateReply());
  await recoverNasReviews();
  expect(indexedDB.open).not.toHaveBeenCalled();
  expect(Storage.prototype.setItem).not.toHaveBeenCalled();
  expect(Storage.prototype.getItem).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('NAS practice integration without local persistence', () => {
  it('locks the rating/card after a lost response and retries the identical operation only', async () => {
    let attempts = 0;
    reviewReply = async (operation) => {
      state.reviews.one = operation.review; // Simulate a commit whose response was lost.
      if (++attempts === 1) throw new TypeError('Lost response');
      return stateReply();
    };
    const user = await start();
    await user.click(screen.getByRole('button', { name: /^Good/ }));
    const retry = await screen.findByRole('button', { name: 'Retry pending good save' });
    expect(screen.getByRole('alert').textContent).toContain('pending save may already have committed');
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    expect(screen.getByText('0 reviewed this visit')).toBeTruthy();
    for (const name of [/^Again/, /^Hard/, /^Good/, /^Easy/, 'End session', 'Skip for this session']) {
      const button = screen.getByRole('button', { name });
      expect(button.matches(':disabled')).toBe(true);
      await user.click(button);
    }
    expect(reviewCalls()).toHaveLength(1);
    const reads = stateCalls().length;
    await user.click(retry);
    await screen.findByText('HSK1 · Card 2');
    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1][1]?.body).toBe(reviewCalls()[0][1]?.body);
    expect(body(1).review.rating).toBe('good');
    expect(body(1).review.reviewedAt).toBe(body(0).review.reviewedAt);
    // Only statistics may refresh after success; no GET is allowed between retries.
    const calls = fetchMock.mock.calls;
    const first = calls.findIndex(([url]) => url === '/api/reviews');
    const second = calls.findIndex(([url], index) => index > first && url === '/api/reviews');
    expect(calls.slice(first + 1, second).filter(([url]) => url === '/api/state')).toHaveLength(0);
    expect(stateCalls().length).toBeGreaterThanOrEqual(reads);
    expect(screen.getByText('1 reviewed this visit')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry pending/ })).toBeNull();
  });

  it('retains the card on 409, reloads schedules, and uses a new operation and current expected review', async () => {
    const external = scheduleReview('one', undefined, 'easy', Date.now());
    let attempts = 0;
    reviewReply = async (operation) => {
      if (++attempts === 1) {
        state.reviews.one = external;
        return reply({ error: { message: 'Another device reviewed this card. Reload and retry.' } }, 409);
      }
      state.reviews.one = operation.review;
      return stateReply();
    };
    const user = await start();
    const reads = stateCalls().length;
    await user.click(screen.getByRole('button', { name: /^Good/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Another device reviewed');
    await waitFor(() => expect(screen.getByRole('group', { name: 'Next review' }).hasAttribute('disabled')).toBe(false));
    expect(stateCalls().length).toBeGreaterThanOrEqual(reads + 2);
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    expect(screen.getByText('0 reviewed this visit')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry pending/ })).toBeNull();
    const nextInterval = scheduleReview('one', external, 'hard').intervalDays;
    expect(screen.getByRole('button', { name: /^Hard/ }).textContent).toContain(`${nextInterval} days`);
    await user.click(screen.getByRole('button', { name: /^Hard/ }));
    await screen.findByText('HSK1 · Card 2');
    expect(body(1).id).not.toBe(body(0).id);
    expect(body(0).expected).toBeNull();
    expect(body(1).expected).toEqual(external);
    expect(body(1).review.rating).toBe('hard');
    expect(body(1).review.intervalDays).toBe(nextInterval);
  });

  it('keeps the conflict actionable if the immediate schedule reload also fails', async () => {
    let conflict = false;
    reviewReply = async () => { conflict = true; return reply({ error: { message: 'Review conflict' } }, 409); };
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/state' && conflict) return Promise.reject(new Error('Reload offline'));
      return original(url, options);
    });
    const user = await start();
    await user.click(screen.getByRole('button', { name: /^Good/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Review conflict');
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('group', { name: 'Next review' }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('button', { name: /Retry pending/ })).toBeNull();
    expect(state.reviews).toEqual({});
  });

  it('disables duplicate ratings and backup operations while the NAS save is in flight', async () => {
    let finish!: (response: Response) => void;
    reviewReply = () => new Promise((resolve) => { finish = resolve; });
    const user = await start();
    await user.click(screen.getByText('Progress backup & NAS sync'));
    await user.dblClick(screen.getByRole('button', { name: /^Good/ }));
    await waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(screen.getByText('Saving review to NAS…')).toBeTruthy();
    for (const name of ['Export progress', 'Sign out', 'Refresh NAS progress', 'End session']) {
      expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true);
    }
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    await act(async () => finish(stateReply()));
    await screen.findByText('HSK1 · Card 2');
    expect(reviewCalls()).toHaveLength(1);
  });

  it('recovers an expired-session pending review after login before remounting and loading schedules', async () => {
    let attempts = 0;
    reviewReply = async (operation) => {
      if (++attempts === 1) return reply({ error: { message: 'Session expired' } }, 401);
      state.reviews.one = operation.review;
      return stateReply();
    };
    const user = await start(true);
    await user.click(screen.getByRole('button', { name: /^Good/ }));
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('region', { name: 'Practice session' })).toBeNull();
    await user.type(screen.getByLabelText('NAS password'), 'test-reauth');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Start Review' });
    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1][1]?.body).toBe(reviewCalls()[0][1]?.body);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    const login = urls.lastIndexOf('/api/login');
    expect(urls[login + 1]).toBe('/api/reviews');
    expect(urls.slice(login + 2)).toContain('/api/state');
    await user.click(screen.getByRole('button', { name: 'Start Review' }));
    await screen.findByText('HSK1 · Card 2');
  });

  it('refreshes on idle focus, blocks practice after refresh failure, and does not refresh reviews mid-practice', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Start Review' });
    fetchMock.mockRejectedValueOnce(new Error('Offline'));
    act(() => window.dispatchEvent(new Event('focus')));
    expect((await screen.findByRole('alert')).textContent).toContain('NAS unavailable');
    expect(screen.getByRole('button', { name: 'Start Review' }).matches(':disabled')).toBe(true);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Review' }).matches(':disabled')).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start Review' }));
    await screen.findByRole('group', { name: 'Next review' });
    const reads = stateCalls().length;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(stateCalls()).toHaveLength(reads);
    expect(reviewCalls()).toHaveLength(0);
  });
});