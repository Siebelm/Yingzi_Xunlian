// @vitest-environment jsdom

import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioFor, loadDeck, mediaUrl, parseDeck } from './deck';
import type { Card, Deck } from './types';

const mp3 = `media/${'a'.repeat(64)}.mp3`;
const jpg = `media/${'b'.repeat(64)}.jpg`;

function fixture(): Deck {
  return {
    version: 1, id: 'mandarin-hsk-1-5', name: 'Local test deck',
    cards: [{
      id: 'hsk:1', order: 1, level: 'HSK1', word: '<b>好</b>', homograph: '',
      pinyin: 'hǎo', meaning: 'good', partOfSpeech: 'adjective', sentence: '你好。',
      sentencePinyin: 'nǐ hǎo', sentenceMeaning: 'Hello.',
      wordAudio: mp3, sentenceAudio: mp3, englishAudio: null, images: [jpg],
    }],
    report: { cards: 1, missingEnglishAudio: 1, missingWordAudio: 0,
      missingSentenceAudio: 0, missingImages: 0, mediaFiles: 2, sourceSha256: 'c'.repeat(64) },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const unsafePaths = [
  `https://example.invalid/${mp3}`, `//example.invalid/${jpg}`,
  `../${mp3}`, `media/../${mp3}`, `media/%2e%2e/${mp3}`,
  `media\\${'a'.repeat(64)}.mp3`, `/deck/${mp3}`,
  `file:///tmp/${mp3}`, 'data:audio/mp3;base64,YQ==', 'javascript:alert(1)',
  `${mp3}?remote=1`, `${jpg}#fragment`, ` ${mp3}`, `${mp3}\n`,
  `media/${'a'.repeat(63)}.mp3`, `media/${'g'.repeat(64)}.jpg`,
  `media/${'A'.repeat(64)}.mp3`, `media/${'a'.repeat(64)}.svg`, '',
];

describe('mediaUrl', () => {
  it.each([mp3, jpg])('allows a hashed local media path: %s', (path) => {
    expect(mediaUrl(path)).toBe(`${import.meta.env.BASE_URL}deck/${path}`);
  });

  it.each(unsafePaths)('rejects unsafe or malformed path: %j', (path) => {
    expect(() => mediaUrl(path)).toThrow('Invalid local media path.');
  });
});

describe('parseDeck', () => {
  it('allows a valid fixture, original HTML and explicitly absent optional media', () => {
    const deck = fixture();
    expect(parseDeck(deck)).toEqual(deck);
    deck.cards[0].sentenceAudio = null;
    deck.cards[0].images = [];
    expect(parseDeck(deck).cards[0].word).toBe('<b>好</b>');
  });

  it.each([null, undefined, false, 'deck', [], {}, { ...fixture(), version: 2 },
    { ...fixture(), id: 'external-deck' }, { ...fixture(), name: 42 },
    { ...fixture(), cards: [] }, { ...fixture(), cards: {} }])('rejects invalid deck data: %j', (value) => {
    expect(() => parseDeck(value)).toThrow();
  });

  it.each<[keyof Card, unknown]>([
    ['id', 'other:1'], ['id', 1], ['order', NaN], ['order', Infinity], ['order', '1'],
    ['level', null], ['images', null], ['images', [mp3]], ['images', [42]],
    ['wordAudio', jpg], ['sentenceAudio', undefined], ['englishAudio', 42],
    ...(['word', 'homograph', 'pinyin', 'meaning', 'partOfSpeech', 'sentence', 'sentencePinyin', 'sentenceMeaning'] as const)
      .map((field): [keyof Card, unknown] => [field, null]),
  ])('rejects invalid card field %s = %j', (field, value) => {
    const deck = fixture();
    Object.assign(deck.cards[0], { [field]: value });
    expect(() => parseDeck(deck)).toThrow('Invalid card or media reference');
  });

  it.each([null, 'card', 42])('rejects a non-object card: %j', (value) => {
    expect(() => parseDeck({ ...fixture(), cards: [value] })).toThrow();
  });

  it('rejects duplicate card IDs', () => {
    const deck = fixture();
    deck.cards.push({ ...deck.cards[0], order: 2 });
    deck.report.cards = 2;
    expect(() => parseDeck(deck)).toThrow('Invalid card or media reference');
  });

  it.each([undefined, null, {}, { cards: 2 }, { cards: '1' }])('rejects a missing or mismatched report: %j', (report) => {
    expect(() => parseDeck({ ...fixture(), report })).toThrow('Invalid import report');
  });

  it.each(unsafePaths)('rejects unsafe references in every media field: %j', (path) => {
    for (const field of ['wordAudio', 'sentenceAudio', 'englishAudio', 'images'] as const) {
      const deck = fixture();
      Object.assign(deck.cards[0], { [field]: field === 'images' ? [path] : path });
      expect(() => parseDeck(deck), field).toThrow('Invalid card or media reference');
    }
  });
});

describe('audio selection and loading', () => {
  it('selects the requested mode and never silently falls back to word audio', () => {
    const card: Card = { ...fixture().cards[0], sentenceAudio: `media/${'d'.repeat(64)}.mp3` };
    expect(audioFor(card, 'sentence')).toBe(card.sentenceAudio);
    expect(audioFor(card, 'word')).toBe(mp3);
    expect(audioFor({ ...card, sentenceAudio: null }, 'sentence')).toBeNull();
  });

  it('fetches and validates the local JSON using the caller’s abort signal', async () => {
    const deck = fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(deck), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(loadDeck(controller.signal)).resolves.toEqual(deck);
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}deck/deck.json`, { signal: controller.signal });
  });

  it.each<ResponseInit>([
    { status: 404, headers: { 'content-type': 'application/json' } },
    { status: 200, headers: { 'content-type': 'text/html' } },
    { status: 200, headers: {} },
  ])('rejects an unsuccessful or non-JSON response: %j', async (options) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', options)));
    await expect(loadDeck()).rejects.toThrow('Local deck is not prepared');
  });

  it('does not accept malformed deck data merely because the response is JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } })));
    await expect(loadDeck()).rejects.toThrow('Unsupported or empty deck');
  });
});