export type PracticeMode = 'sentence' | 'word';
export type Rating = 'again' | 'hard' | 'good' | 'easy';

export interface Card {
  id: string;
  order: number;
  level: string;
  word: string;
  homograph: string;
  pinyin: string;
  meaning: string;
  partOfSpeech: string;
  sentence: string;
  sentencePinyin: string;
  sentenceMeaning: string;
  wordAudio: string | null;
  sentenceAudio: string | null;
  englishAudio: string | null;
  images: string[];
}

export interface Deck {
  version: 1;
  id: string;
  name: string;
  cards: Card[];
  report: {
    cards: number;
    missingEnglishAudio: number;
    missingWordAudio: number;
    missingSentenceAudio: number;
    missingImages: number;
    mediaFiles: number;
    sourceSha256: string;
  };
}

export interface Review {
  cardId: string;
  due: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
  reviewedAt: number;
  rating: Rating;
}

export type Reviews = Record<string, Review>;