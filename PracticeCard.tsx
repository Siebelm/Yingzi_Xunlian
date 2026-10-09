import { useEffect, useRef, useState } from 'react';
import CardView from './CardView';
import { audioFor, mediaUrl } from './deck';
import { initialPracticeState, PracticeSession } from './practice';
import { scheduleReview } from './scheduler';
import type { Card, PracticeMode, Rating, Review } from './types';
import { NAS_ENABLED } from './nasClient';

interface Props {
  card: Card;
  mode: PracticeMode;
  showChinese: boolean;
  previous?: Review;
  saving: boolean;
  pendingRating?: Rating | null;
  error: string | null;
  onShowChinese: (show: boolean) => void;
  onModeChange: (mode: PracticeMode) => void;
  onRate: (rating: Rating) => void;
  onSkip: () => void;
  onEnd: () => void;
}

const ratings: { value: Rating; label: string }[] = [
  { value: 'again', label: 'Again' }, { value: 'hard', label: 'Hard' },
  { value: 'good', label: 'Good' }, { value: 'easy', label: 'Easy' },
];

export default function PracticeCard(props: Props) {
  const { card, mode, saving, previous, showChinese } = props;
  const [state, setState] = useState(initialPracticeState);
  const session = useRef<PracticeSession | null>(null);
  const target = audioFor(card, mode);

  useEffect(() => {
    const controller = new PracticeSession(setState);
    session.current = controller;
    if (target) controller.start(card.englishAudio ? mediaUrl(card.englishAudio) : null, mediaUrl(target));
    const interrupt = () => { if (document.hidden) controller.interrupt(); };
    const pagehide = () => controller.interrupt();
    document.addEventListener('visibilitychange', interrupt);
    window.addEventListener('pagehide', pagehide);
    return () => {
      document.removeEventListener('visibilitychange', interrupt);
      window.removeEventListener('pagehide', pagehide);
      controller.dispose();
      session.current = null;
    };
  }, [card.id, card.englishAudio, target]);

  function restart() {
    if (target) session.current?.start(card.englishAudio ? mediaUrl(card.englishAudio) : null, mediaUrl(target));
  }

  return (
    <section className="practice-panel" aria-label="Practice session">
      <div className="card-toolbar">
        <span className="muted">{card.level} · Card {card.order}</span>
        <label className="check-label"><input type="checkbox" checked={showChinese} onChange={(e) => props.onShowChinese(e.target.checked)} /> Show Chinese &amp; pinyin</label>
      </div>
      <CardView card={card} showChinese={showChinese} />
      <div className="session-controls">
        <div className="toolbar">
          <label>Audio <select aria-label="Practice audio" value={mode} disabled={saving} onChange={(e) => props.onModeChange(e.target.value as PracticeMode)}>
            <option value="sentence">Sentence</option><option value="word">Word</option>
          </select></label>
          {!card.englishAudio && <span className="muted">English audio unavailable</span>}
        </div>
        {!target ? <div className="notice" role="status">
          No {mode} audio in this card. {card.wordAudio && mode === 'sentence' ? 'Choose word audio or skip this card.' : 'Skip this card to continue.'}
          {card.wordAudio && mode === 'sentence' && <button onClick={() => props.onModeChange('word')}>Use word audio</button>}
        </div> : <>
          <div className="playback-status" role="status" aria-live="polite">
            <strong>{state.label}</strong>
            {state.message && <p>{state.message}</p>}
          </div>
          <div className="actions">
            {state.phase === 'idle' && <button className="primary" disabled={saving} onClick={restart}>Start audio</button>}
            {(state.phase === 'blocked' || state.phase === 'error') && <button className="primary" disabled={saving} onClick={() => session.current?.retry()}>{state.phase === 'blocked' ? 'Continue audio' : 'Retry'}</button>}
            {state.phase === 'awaiting-record' && <button className="primary" onClick={() => { void session.current?.record(); }}>Record</button>}
            {state.phase === 'recording' && <button className="record-stop" onClick={() => session.current?.stopRecording()}>Stop &amp; play back</button>}
            {['awaiting-record', 'error'].includes(state.phase) && <button disabled={saving} onClick={() => session.current?.reviewWithoutRecording()}>Rate without recording</button>}
            {state.phase !== 'idle' && <button disabled={saving} onClick={() => session.current?.cancel()}>Reset audio</button>}
          </div>
          {state.phase === 'review' && <fieldset className="ratings" disabled={saving || !!props.pendingRating}>
            <legend>Next review</legend>
            {ratings.map(({ value, label }) => {
              const review = scheduleReview(card.id, previous, value);
              return <button key={value} onClick={() => props.onRate(value)}>
                {label}<small>{value === 'again' ? '10 min' : `${review.intervalDays} ${review.intervalDays === 1 ? 'day' : 'days'}`}</small>
              </button>;
            })}
          </fieldset>}
        </>}
        {saving && <p role="status">{NAS_ENABLED ? 'Saving review to NAS…' : 'Saving review locally…'}</p>}
        {props.error && <p className="notice error" role="alert">{props.error} Your card has not advanced; retry the rating.</p>}
        {props.pendingRating && !saving && <button onClick={() => props.onRate(props.pendingRating!)}>Retry pending {props.pendingRating} save</button>}
        <div className="session-navigation">
          <button disabled={saving || !!props.pendingRating} onClick={props.onSkip}>Skip for this session</button>
          <button disabled={saving || !!props.pendingRating} onClick={props.onEnd}>End session</button>
        </div>
        <p className="fine-print">Recordings are discarded after playback. Switching cards or leaving the app stops recording.</p>
      </div>
    </section>
  );
}