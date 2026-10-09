// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import App from './App';
import { loadDeck, mediaUrl } from './deck';
import type { PracticeState } from './practice';
import { loadReviews, saveReview } from './reviewStore';
import type { Card, Deck } from './types';
import { emptyActivity, localDay } from './activity';
import { loadActivity, savePracticeTime } from './reviewStore';
import { scheduleReview } from './scheduler';

const { controllers } = vi.hoisted(() => ({
  controllers: [] as {
    emit: (state: PracticeState) => void;
    start: Mock<(english: string | null, chinese: string) => void>;
    dispose: Mock<() => void>;
  }[],
}));

vi.mock('./deck', async (importOriginal) => ({
  ...await importOriginal<typeof import('./deck')>(), loadDeck: vi.fn(),
}));
vi.mock('./reviewStore', () => ({ loadReviews: vi.fn(), saveReview: vi.fn(), loadActivity: vi.fn(), savePracticeTime: vi.fn() }));
vi.mock('./practice', async (importOriginal) => ({
  ...await importOriginal<typeof import('./practice')>(),
  // Only the media boundary is fake; App, PracticeCard, CardView and scheduler are real.
  PracticeSession: class {
    constructor(public emit: (state: PracticeState) => void) { controllers.push(this); }
    start = vi.fn((_english: string | null, _chinese: string) => {
      this.emit({ phase: 'playing', label: 'Chinese · 1 of 2' });
    });
    dispose = vi.fn<() => void>();
    interrupt = vi.fn();
    retry = vi.fn();
    record = vi.fn();
    stopRecording = vi.fn();
    cancel = vi.fn(() => this.emit({ phase: 'idle', label: 'Ready' }));
    reviewWithoutRecording = vi.fn(() => this.emit({ phase: 'review', label: 'Rate this card' }));
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(): Deck {
  const first: Card = {
    id: 'hsk:1', order: 1, level: 'HSK1', word: '好', homograph: '好（第四声）',
    pinyin: 'hǎo', meaning: 'good', partOfSpeech: 'adjective', sentence: '你好。',
    sentencePinyin: 'nǐ hǎo', sentenceMeaning: 'Hello.',
    wordAudio: `media/${'a'.repeat(64)}.mp3`, sentenceAudio: `media/${'b'.repeat(64)}.mp3`,
    englishAudio: null, images: [`media/${'c'.repeat(64)}.jpg`],
  };
  return {
    version: 1, id: 'mandarin-hsk-1-5', name: 'Local test deck',
    cards: [first, { ...first, id: 'hsk:2', order: 2, word: '水', meaning: 'water',
      sentenceAudio: `media/${'d'.repeat(64)}.mp3` }],
    report: { cards: 2, missingEnglishAudio: 2, missingWordAudio: 0,
      missingSentenceAudio: 0, missingImages: 0, mediaFiles: 4, sourceSha256: 'e'.repeat(64) },
  };
}

const ratings = /^(Again|Hard|Good|Easy)/;
const current = () => controllers[controllers.length - 1];

async function start() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Start Review' }));
  return user;
}

async function readyToRate(user: ReturnType<typeof userEvent.setup>) {
  act(() => current().emit({ phase: 'awaiting-record', label: 'Ready to record' }));
  await user.click(screen.getByRole('button', { name: 'Rate without recording' }));
  expect(screen.getAllByRole('button', { name: ratings })).toHaveLength(4);
}

beforeEach(() => {
  vi.resetAllMocks();
  controllers.length = 0;
  vi.mocked(loadDeck).mockResolvedValue(fixture());
  vi.mocked(loadReviews).mockResolvedValue({});
  vi.mocked(saveReview).mockResolvedValue(undefined);
  vi.mocked(loadActivity).mockResolvedValue(emptyActivity());
  vi.mocked(savePracticeTime).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('loading and explicit start', () => {
  it('shows loading, then waits for an explicit start without English audio', async () => {
    const pending = deferred<Deck>();
    vi.mocked(loadDeck).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole('status').textContent).toContain('Loading local deck and reviews');
    expect(controllers).toHaveLength(0);
    await act(async () => pending.resolve(fixture()));
    expect(screen.getByRole('heading', { name: 'Local test deck' })).toBeTruthy();
    expect(screen.getByText(/This deck has no English recordings/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Practice session' })).toBeNull();
    expect(controllers).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Start Review' }));
    expect(screen.getByRole('region', { name: 'Practice session' })).toBeTruthy();
    expect(current().start).toHaveBeenCalledExactlyOnceWith(null, mediaUrl(fixture().cards[0].sentenceAudio!));
    expect(screen.queryByRole('button', { name: ratings })).toBeNull();
  });

  it.each(['deck', 'reviews'] as const)('shows a %s loading error and supports retry', async (source) => {
    const error = new Error(`Cannot load ${source}`);
    if (source === 'deck') vi.mocked(loadDeck).mockRejectedValueOnce(error);
    else vi.mocked(loadReviews).mockRejectedValueOnce(error);
    const user = userEvent.setup();
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain(error.message);
    expect(screen.queryByRole('button', { name: 'Start Review' })).toBeNull();
    expect(controllers).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(await screen.findByRole('button', { name: 'Start Review' })).toBeTruthy();
    expect(loadDeck).toHaveBeenCalledTimes(2);
    expect(loadReviews).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('practice choices and visibility', () => {
  it('collapses the deck panel during practice and restores it on end', async () => {
    const user = await start();
    expect(screen.getByRole('heading', { name: 'Local test deck' })).toBeTruthy();
    expect(screen.getByText('2 cards · 0 reviews due · 2 new')).toBeTruthy();
    expect(screen.queryByRole('definition')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Deck views' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Level' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.getByRole('navigation', { name: 'Deck views' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Level' })).toBeTruthy();
    expect(screen.getAllByRole('definition')).toHaveLength(3);
  });

  it.each(['word', 'skip'] as const)('requires an explicit %s choice when sentence audio is missing', async (choice) => {
    const deck = fixture();
    deck.cards[0].sentenceAudio = null;
    deck.report.missingSentenceAudio = 1;
    vi.mocked(loadDeck).mockResolvedValue(deck);
    const user = await start();
    const previous = current();
    expect(screen.getByRole('status').textContent).toContain('Choose word audio or skip this card.');
    expect(previous.start).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: ratings })).toBeNull();
    if (choice === 'word') {
      await user.click(screen.getByRole('button', { name: 'Use word audio' }));
      expect((screen.getByRole('combobox', { name: 'Practice audio' }) as HTMLSelectElement).value).toBe('word');
      expect(current().start).toHaveBeenCalledExactlyOnceWith(null, mediaUrl(deck.cards[0].wordAudio!));
      expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    } else {
      await user.click(screen.getByRole('button', { name: 'Skip for this session' }));
      expect(screen.getByText('HSK1 · Card 2')).toBeTruthy();
      expect(current().start).toHaveBeenCalledExactlyOnceWith(null, mediaUrl(deck.cards[1].sentenceAudio!));
    }
    expect(previous.start).not.toHaveBeenCalled();
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('toggles target fields without removing English/image or restarting playback', async () => {
    const user = await start();
    const controller = current();
    const toggle = screen.getByRole('checkbox', { name: 'Show Chinese & pinyin' });
    await user.click(toggle);
    for (const text of ['好', '好（第四声）', 'hǎo', '你好。', 'nǐ hǎo']) expect(screen.queryByText(text)).toBeNull();
    for (const text of ['good', 'adjective', 'Hello.']) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
    await user.click(toggle);
    for (const text of ['好', '好（第四声）', 'hǎo', '你好。', 'nǐ hǎo']) expect(screen.getByText(text)).toBeTruthy();
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.dispose).not.toHaveBeenCalled();
  });

  it('switches audio only on selection and disposes the previous controller', async () => {
    const user = await start();
    const previous = current();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Practice audio' }), 'word');
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(current().start).toHaveBeenCalledExactlyOnceWith(null, mediaUrl(fixture().cards[0].wordAudio!));
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('never exposes rating buttons before the controller reaches review', async () => {
    const user = await start();
    for (const phase of ['idle', 'playing', 'awaiting-record', 'requesting', 'recording', 'blocked', 'error'] as const) {
      act(() => current().emit({ phase, label: `Test ${phase}` }));
      expect(screen.queryByRole('group', { name: 'Next review' }), phase).toBeNull();
      expect(screen.queryByRole('button', { name: ratings }), phase).toBeNull();
    }
    await readyToRate(user);
    expect(screen.getByRole('group', { name: 'Next review' })).toBeTruthy();
    expect(saveReview).not.toHaveBeenCalled();
  });
});

describe('saving reviews', () => {
  it('keeps the current card and shows an error on save failure, allowing a retry', async () => {
    vi.mocked(saveReview).mockRejectedValueOnce(new Error('Local storage is full'));
    const user = await start();
    const previous = current();
    await readyToRate(user);
    await user.click(screen.getByRole('button', { name: /^Good/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Local storage is full');
    expect(alert.textContent).toContain('Your card has not advanced; retry the rating.');
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    expect(screen.getByText('0 reviewed this visit')).toBeTruthy();
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Next review' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: /^Good/ }));
    expect(await screen.findByText('HSK1 · Card 2')).toBeTruthy();
    expect(saveReview).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('1 reviewed this visit')).toBeTruthy();
  });

  it('advances only AFTER save resolves and disposes the previous card controller', async () => {
    const pending = deferred<void>();
    vi.mocked(saveReview).mockReturnValueOnce(pending.promise);
    const user = await start();
    const previous = current();
    await readyToRate(user);
    await user.click(screen.getByRole('button', { name: /^Good/ }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    expect(saveReview).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'hsk:1', rating: 'good' }));
    expect(screen.getByText('Saving review locally…')).toBeTruthy();
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    expect(screen.queryByText('HSK1 · Card 2')).toBeNull();
    expect(screen.getByText('0 reviewed this visit')).toBeTruthy();
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Next review' }).hasAttribute('disabled')).toBe(true);
    for (const name of ['Skip for this session', 'End session']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => pending.resolve(undefined));
    expect(await screen.findByText('HSK1 · Card 2')).toBeTruthy();
    expect(screen.getByText('1 reviewed this visit')).toBeTruthy();
    expect(screen.queryByText('Saving review locally…')).toBeNull();
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(current().start).toHaveBeenCalledExactlyOnceWith(null, mediaUrl(fixture().cards[1].sentenceAudio!));
    expect(screen.queryByRole('button', { name: ratings })).toBeNull();
  });

  it('does not duplicate saves on a double-click rating', async () => {
    const pending = deferred<void>();
    vi.mocked(saveReview).mockReturnValueOnce(pending.promise);
    const user = await start();
    await readyToRate(user);
    await user.dblClick(screen.getByRole('button', { name: /^Good/ }));
    await waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    expect(loadReviews).toHaveBeenCalledTimes(2); // Initial load plus one rating re-read.
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    await act(async () => pending.resolve(undefined));
    expect(await screen.findByText('HSK1 · Card 2')).toBeTruthy();
    expect(screen.getByText('1 reviewed this visit')).toBeTruthy();
    expect(saveReview).toHaveBeenCalledTimes(1);
  });
});

describe('skipping and cleanup', () => {
  it('opens the viewer after ending practice without rating, and disposes active media', async () => {
    const user = await start();
    const controller = current();
    await user.click(screen.getByRole('button', { name: 'End session' }));
    await user.click(screen.getByRole('button', { name: 'View Cards' }));
    expect(screen.queryByRole('region', { name: 'Practice session' })).toBeNull();
    expect(screen.getByText('No reviewed cards yet.')).toBeTruthy();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('shows saved daily totals and a reviewed card without starting playback', async () => {
    const now = Date.now();
    const activity = emptyActivity();
    activity.counts['hsk:1'] = 8;
    activity.days[localDay(now)] = { cardIds: ['hsk:1'], reviews: 3, timeMs: 65_000 };
    activity.days['2020-01-01'] = { cardIds: [], reviews: 0, timeMs: 3600_000 };
    vi.mocked(loadActivity).mockResolvedValue(activity);
    vi.mocked(loadReviews).mockResolvedValue({ 'hsk:1': scheduleReview('hsk:1', undefined, 'good', now) });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('1m 5s')).toBeTruthy();
    expect(screen.getByText('1h 1m 5s')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'View Cards' }));
    expect(screen.getByText('Reviews: 8')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Reviewed cards (1)' })).toBeTruthy();
    expect(controllers).toHaveLength(0);
    expect(saveReview).not.toHaveBeenCalled();
    expect(savePracticeTime).not.toHaveBeenCalled();
  });

  it('skips without persistence, disposes on card change, and can restore skipped cards', async () => {
    const user = await start();
    const first = current();
    await user.click(screen.getByRole('button', { name: 'Skip for this session' }));
    expect(screen.getByText('HSK1 · Card 2')).toBeTruthy();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    const second = current();
    await user.click(screen.getByRole('button', { name: 'Skip for this session' }));
    expect(screen.getByRole('status').textContent).toContain('Remaining due cards are skipped for this session.');
    expect(screen.queryByRole('region', { name: 'Practice session' })).toBeNull();
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 reviewed this visit')).toBeTruthy();
    expect(saveReview).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Restore skipped cards (2)' }));
    await user.click(screen.getByRole('button', { name: 'Start Review' }));
    expect(screen.getByText('HSK1 · Card 1')).toBeTruthy();
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('disposes the active controller on end without saving', async () => {
    const user = await start();
    const controller = current();
    await user.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.queryByRole('region', { name: 'Practice session' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Review' })).toBeTruthy();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
    expect(saveReview).not.toHaveBeenCalled();
  });

  it('disposes the active controller when the app unmounts', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Start Review' }));
    const controller = current();
    unmount();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
    expect(saveReview).not.toHaveBeenCalled();
  });
});