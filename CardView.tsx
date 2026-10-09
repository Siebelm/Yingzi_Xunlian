import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { mediaUrl } from './deck';
import type { Card } from './types';

export function cleanCardHtml(html: string): string {
  return DOMPurify.sanitize(html.replace(/\[sound:[^\]]+\]/g, ''), {
    ALLOWED_TAGS: ['b', 'strong', 'em', 'i', 'u', 'br', 'div', 'p', 'span', 'ruby', 'rt', 'rp', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: [],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

function Field({ html, className, lang }: { html: string; className?: string; lang?: string }) {
  const safe = useMemo(() => cleanCardHtml(html), [html]);
  return <div className={className} lang={lang} dangerouslySetInnerHTML={{ __html: safe }} />;
}

function CardImage({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="notice">Card image could not be loaded.</p> : (
    <img className="card-image" src={mediaUrl(path)} alt="Illustration from the Anki card" onError={() => setFailed(true)} />
  );
}

export default function CardView({ card, showChinese }: { card: Card; showChinese: boolean }) {
  return (
    <article className="card-content" aria-label="Practice card">
      {showChinese ? <>
        <Field html={card.word} className="hanzi" lang="zh-Hans" />
        <Field html={card.homograph} className="muted" lang="zh-Hans" />
        <Field html={card.pinyin} className="pinyin" lang="zh-Latn" />
      </> : <p className="hidden-text">Chinese text and pinyin hidden</p>}
      <Field html={card.meaning} />
      <Field html={card.partOfSpeech} className="muted" />
      <div className="sentence-block">
        {showChinese && <>
          <Field html={card.sentence} className="sentence" lang="zh-Hans" />
          <Field html={card.sentencePinyin} className="pinyin" lang="zh-Latn" />
        </>}
        <Field html={card.sentenceMeaning} />
      </div>
      {card.images.length ? card.images.map((path) => <CardImage key={path} path={path} />) : <p className="muted">No image in this card.</p>}
    </article>
  );
}