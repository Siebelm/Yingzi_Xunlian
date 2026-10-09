import type { Card, Deck } from './types';

const mediaPattern = /^media\/[a-f0-9]{64}\.(mp3|jpg)$/;
const htmlFields = ['word', 'homograph', 'pinyin', 'meaning', 'partOfSpeech', 'sentence', 'sentencePinyin', 'sentenceMeaning'] as const;

export function parseDeck(value: unknown): Deck {
  if (!value || typeof value !== 'object') throw new Error('Invalid deck file.');
  const deck = value as Deck;
  if (deck.version !== 1 || deck.id !== 'mandarin-hsk-1-5' || typeof deck.name !== 'string' || !Array.isArray(deck.cards) || !deck.cards.length) {
    throw new Error('Unsupported or empty deck. Run the local deck conversion again.');
  }
  const ids = new Set<string>();
  for (const card of deck.cards) {
    if (!card || typeof card !== 'object' || typeof card.id !== 'string' || !/^hsk:\d+$/.test(card.id) || ids.has(card.id)
      || !Number.isFinite(card.order) || typeof card.level !== 'string'
      || htmlFields.some((field) => typeof card[field] !== 'string')
      || !Array.isArray(card.images) || card.images.some((src) => typeof src !== 'string' || !/^media\/[a-f0-9]{64}\.jpg$/.test(src))
      || (['wordAudio', 'sentenceAudio', 'englishAudio'] as const).some((key) => card[key] !== null && (typeof card[key] !== 'string' || !/^media\/[a-f0-9]{64}\.mp3$/.test(card[key])))) {
      throw new Error('Invalid card or media reference in deck.');
    }
    ids.add(card.id);
  }
  if (!deck.report || deck.report.cards !== deck.cards.length) throw new Error('Invalid import report.');
  return deck;
}

export async function loadDeck(signal?: AbortSignal): Promise<Deck> {
  const response = await fetch(`${import.meta.env.BASE_URL}deck/deck.json`, { signal });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Local deck is not prepared. Run the prepare:deck script, then reload.');
  }
  return parseDeck(await response.json());
}

export function mediaUrl(path: string): string {
  if (!mediaPattern.test(path)) throw new Error('Invalid local media path.');
  return `${import.meta.env.BASE_URL}deck/${path}`;
}

export function audioFor(card: Card, mode: 'sentence' | 'word'): string | null {
  return mode === 'sentence' ? card.sentenceAudio : card.wordAudio;
}