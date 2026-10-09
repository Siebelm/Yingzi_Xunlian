// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CardView, { cleanCardHtml } from './CardView';
import { mediaUrl } from './deck';
import type { Card } from './types';

const image = `media/${'a'.repeat(64)}.jpg`;
const card: Card = {
  id: 'hsk:1', order: 1, level: 'HSK1',
  word: '<b>好</b>', homograph: '好（第四声）', pinyin: 'hǎo',
  meaning: '<b>good</b><br>well', partOfSpeech: 'adjective',
  sentence: '你好。', sentencePinyin: 'nǐ hǎo', sentenceMeaning: 'Hello.',
  wordAudio: `media/${'b'.repeat(64)}.mp3`, sentenceAudio: null,
  englishAudio: null, images: [image],
};

afterEach(() => cleanup());

describe('card HTML safety', () => {
  const unsafe = '<script>window.cardAttack = true</script>'
    + '<style>@import url("https://example.invalid/style.css");</style>'
    + '<link rel="stylesheet" href="https://example.invalid/style.css">'
    + '<div style="background:url(https://example.invalid/pixel)" onclick="alert(1)" data-remote="yes" aria-label="untrusted">'
    + '<b onmouseover="alert(1)">Safe bold</b><br>Safe text'
    + '<img src="https://example.invalid/pixel" onerror="alert(1)">'
    + '<a href="javascript:alert(1)">Link text</a>[sound:remote.mp3]</div>';

  it('strips executable content, events, images, remote styles and sound markers, preserving b/br/text', () => {
    const root = document.createElement('div');
    root.innerHTML = cleanCardHtml(unsafe);
    expect(root.querySelector('b')?.textContent).toBe('Safe bold');
    expect(root.querySelectorAll('br')).toHaveLength(1);
    expect(root.textContent).toBe('Safe boldSafe textLink text');
    expect(root.querySelector('script, style, link, img, a, iframe')).toBeNull();
    for (const element of root.querySelectorAll('*')) expect(element.attributes.length).toBe(0);
    expect(root.innerHTML).not.toMatch(/https?:|javascript:|\[sound:|cardAttack/);
  });

  it.each(['word', 'homograph', 'pinyin', 'meaning', 'partOfSpeech', 'sentence', 'sentencePinyin', 'sentenceMeaning'] as const)(
    'sanitizes the rendered %s field, not just the helper output', (field) => {
      render(<CardView card={{ ...card, [field]: unsafe }} showChinese />);
      const article = screen.getByRole('article', { name: 'Practice card' });
      expect(screen.getByText('Safe bold').tagName).toBe('B');
      expect(article.textContent).toContain('Safe textLink text');
      expect(article.querySelector('script, style, link, [style], [onclick], [onmouseover], [onerror], [data-remote]')).toBeNull();
      expect(article.innerHTML).not.toMatch(/example\.invalid|\[sound:|cardAttack/);
      expect(article.querySelectorAll('img')).toHaveLength(1);
      expect(screen.getByRole('img').getAttribute('src')).toBe(mediaUrl(image));
    },
  );
});

describe('full card display', () => {
  it('shows all original fields and removes Chinese, pinyin and homograph on hide, retaining English and image', () => {
    const { rerender } = render(<CardView card={card} showChinese />);
    const targetFields = ['好', '好（第四声）', 'hǎo', '你好。', 'nǐ hǎo'];
    for (const text of [...targetFields, 'good', 'adjective', 'Hello.']) expect(screen.getByText(text)).toBeTruthy();
    const article = screen.getByRole('article');
    expect(article.textContent).toContain('well');
    expect(screen.getByText('good').tagName).toBe('B');
    expect(article.querySelector('br')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Illustration from the Anki card' }).getAttribute('src')).toBe(mediaUrl(image));

    rerender(<CardView card={card} showChinese={false} />);
    expect(screen.getByText('Chinese text and pinyin hidden')).toBeTruthy();
    for (const text of targetFields) expect(screen.queryByText(text)).toBeNull();
    expect(article.querySelector('[lang="zh-Hans"], [lang="zh-Latn"]')).toBeNull();
    for (const text of ['good', 'adjective', 'Hello.']) expect(screen.getByText(text)).toBeTruthy();
    expect(article.textContent).toContain('well');
    expect(screen.getByRole('img').getAttribute('src')).toBe(mediaUrl(image));

    rerender(<CardView card={card} showChinese />);
    for (const text of targetFields) expect(screen.getByText(text)).toBeTruthy();
  });

  it('displays a missing-image notice', () => {
    render(<CardView card={{ ...card, images: [] }} showChinese />);
    expect(screen.getByText('No image in this card.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('replaces a failed image with a visible notice', () => {
    render(<CardView card={card} showChinese />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText('Card image could not be loaded.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});