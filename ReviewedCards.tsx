import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import CardView from './CardView';
import { reviewCount, type Activity } from './activity';
import type { Card, Reviews } from './types';

function plainText(html: string) {
  const text = document.createElement('div');
  text.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  return text.textContent ?? '';
}

export default function ReviewedCards({ cards, reviews, activity, now }: {
  cards: Card[]; reviews: Reviews; activity: Activity | null; now: number;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const entries = useMemo(() => cards.filter((card) => Object.hasOwn(reviews, card.id))
    .map((card) => ({ card, word: plainText(card.word), meaning: plainText(card.meaning), pinyin: plainText(card.pinyin),
      sentence: plainText(card.sentence), sentenceMeaning: plainText(card.sentenceMeaning) }))
    .sort((a, b) => reviews[a.card.id].due - reviews[b.card.id].due || a.card.order - b.card.order), [cards, reviews]);
  const filtered = entries.filter(({ word, meaning, pinyin, card }) =>
    `${word} ${meaning} ${pinyin} ${card.order}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pageCount - 1);
  const selected = entries.find(({ card }) => card.id === selectedId)?.card;
  const count = (id: string) => activity ? reviewCount(activity, id) : 'Unavailable';

  return <section className="reviewed-cards deck-panel" aria-labelledby="reviewed-title">
    <h2 id="reviewed-title">Reviewed cards ({entries.length})</h2>
    <p className="muted">Read-only · earliest scheduled first · current level filter</p>
    {entries.length === 0 ? <p>No reviewed cards yet.</p> : <>
      <label className="viewer-search">Find a reviewed card
        <input type="search" value={query} placeholder="Chinese, pinyin, meaning, or card number"
          onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      </label>
      <ul className="reviewed-list">
        {filtered.slice(currentPage * 20, (currentPage + 1) * 20).map(({ card, word, sentence, sentenceMeaning }) => <li key={card.id}>
          <button aria-pressed={selectedId === card.id} onClick={() => setSelectedId(card.id)}>
            <span><strong lang="zh-Hans">{word}</strong> <span className="muted">{card.level} · #{card.order}</span></span>
            <span className="reviewed-sentence" lang="zh-Hans">{sentence}</span>
            <span>{sentenceMeaning}</span>
            <span className="muted">Next: {new Date(reviews[card.id].due).toLocaleString()}{reviews[card.id].due <= now ? ' · Due now' : ''}</span>
            <span className="muted">Reviews: {count(card.id)}</span>
          </button>
        </li>)}
      </ul>
      {!filtered.length && <p>No matching reviewed cards.</p>}
      {pageCount > 1 && <nav className="toolbar" aria-label="Reviewed card pages">
        <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous page</button>
        <span>Page {currentPage + 1} of {pageCount}</span>
        <button disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next page</button>
      </nav>}
      {selected && <section className="viewer-detail" aria-label="Selected reviewed card">
        <div className="toolbar"><h3>{selected.level} · Card {selected.order}</h3>
          <button onClick={() => setSelectedId(null)}>Close card</button></div>
        <dl className="viewer-metadata">
          <div><dt>Next scheduled</dt><dd>{new Date(reviews[selected.id].due).toLocaleString()}</dd></div>
          <div><dt>Times reviewed</dt><dd>{count(selected.id)}</dd></div>
          <div><dt>Last reviewed</dt><dd>{new Date(reviews[selected.id].reviewedAt).toLocaleString()}</dd></div>
        </dl>
        <CardView key={selected.id} card={selected} showChinese />
      </section>}
    </>}
    {activity?.legacyCardIds.length ? <p className="fine-print">“At least” includes one known earlier review plus ratings since tracking began. Older complete review counts are unavailable.</p> : null}
  </section>;
}