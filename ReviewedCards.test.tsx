// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import ReviewedCards from './ReviewedCards';
import { emptyActivity } from './activity';
import { scheduleReview } from './scheduler';
import type { Card } from './types';

afterEach(cleanup);
function card(id: number): Card {
  return { id: `hsk:${id}`, order: id, level: 'HSK1', word: `字${id}`, meaning: `meaning ${id}`,
    pinyin: `pinyin ${id}`, homograph: '', partOfSpeech: 'noun', sentence: '句子', sentencePinyin: '',
    sentenceMeaning: 'sentence meaning', images: [], wordAudio: null, sentenceAudio: null, englishAudio: null };
}

it('lists only reviewed cards, shows due dates and counts, and opens the full read-only card', async () => {
  const review = scheduleReview('hsk:1', undefined, 'good', Date.now());
  const activity = emptyActivity();
  activity.counts['hsk:1'] = 7;
  const user = userEvent.setup();
  render(<ReviewedCards cards={[card(1), card(2)]} reviews={{ 'hsk:1': review }} activity={activity} now={Date.now()} />);
  expect(screen.getByRole('heading', { name: 'Reviewed cards (1)' })).toBeTruthy();
  expect(screen.queryByText('字2')).toBeNull();
  expect(screen.getByText('Reviews: 7')).toBeTruthy();
  const entry = screen.getByRole('listitem');
  expect(within(entry).getByText('句子')).toBeTruthy();
  expect(within(entry).getByText('sentence meaning')).toBeTruthy();
  expect(within(entry).queryByText('meaning 1')).toBeNull();
  await user.click(screen.getByRole('button', { name: /字1/ }));
  const detail = screen.getByRole('region', { name: 'Selected reviewed card' });
  expect(within(detail).getByText(new Date(review.due).toLocaleString())).toBeTruthy();
  expect(within(detail).getByText('7')).toBeTruthy();
  expect(within(detail).getByText('sentence meaning')).toBeTruthy();
  expect(within(detail).queryByRole('button', { name: /Record|Again|Good|Rate/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Close card' }));
  expect(screen.queryByRole('region', { name: 'Selected reviewed card' })).toBeNull();
});

it('searches safely, paginates reviewed cards, and flags incomplete old counts', async () => {
  const cards = Array.from({ length: 25 }, (_, index) => card(index + 1));
  const reviews = Object.fromEntries(cards.map((c) => [c.id, scheduleReview(c.id, undefined, 'again', 1000)]));
  const activity = emptyActivity(['hsk:25']);
  const user = userEvent.setup();
  render(<ReviewedCards cards={cards} reviews={reviews} activity={activity} now={Date.now()} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(20);
  await user.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  expect(screen.getByText('Reviews: At least 1')).toBeTruthy();
  await user.type(screen.getByRole('searchbox'), 'meaning 25');
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('字25')).toBeTruthy();
  expect(screen.getByText(/Due now/)).toBeTruthy();
  await user.clear(screen.getByRole('searchbox'));
  await user.type(screen.getByRole('searchbox'), '<script>');
  expect(screen.getByText('No matching reviewed cards.')).toBeTruthy();
});

it('has an empty state for an unreviewed deck', () => {
  render(<ReviewedCards cards={[card(1)]} reviews={{}} activity={emptyActivity()} now={Date.now()} />);
  expect(screen.getByText('No reviewed cards yet.')).toBeTruthy();
});