import { useEffect, useMemo, useRef, useState } from 'react';
import { loadDeck } from './deck';
import PracticeCard from './PracticeCard';
import { loadReviews, saveReview } from './reviewStore';
import { getDueCards, nextDueAt, scheduleReview } from './scheduler';
import type { Deck, PracticeMode, Rating, Review, Reviews } from './types';
import { duration, localDay } from './activity';
import { useActivity } from './useActivity';
import ReviewedCards from './ReviewedCards';
import ProgressPanel from './ProgressPanel';
import { NAS_ENABLED, NasError } from './nasClient';

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [reviews, setReviews] = useState<Reviews>({});
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [level, setLevel] = useState('all');
  const [mode, setMode] = useState<PracticeMode>('sentence');
  const [showChinese, setShowChinese] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pendingReview = useRef<Review | null>(null);
  const [pendingRating, setPendingRating] = useState<Rating | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [view, setView] = useState<'practice' | 'cards'>('practice');
  const { activity, error: activityError, refresh: refreshActivity } = useActivity(!!activeId, reviewed);
  const today = activity?.days[localDay(now)];
  const totalTime = activity ? Object.values(activity.days).reduce((sum, day) => sum + day.timeMs, 0) : 0;

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    void Promise.all([loadDeck(abort.signal), loadReviews()]).then(([loadedDeck, stored]) => {
      if (abort.signal.aborted) return;
      setDeck(loadedDeck);
      setReviews(stored);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load local data.');
    });
    return () => abort.abort();
  }, [attempt]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!NAS_ENABLED || activeId) return;
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const latest = await loadReviews();
        if (!cancelled) { setReviews(latest); setNow(Date.now()); setSyncError(null); }
      } catch (cause) {
        if (!cancelled) setSyncError(cause instanceof Error ? cause.message : 'Could not refresh NAS progress.');
      } finally { running = false; }
    };
    const visible = () => { void refresh(); };
    const timer = setInterval(visible, 15_000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      cancelled = true; clearInterval(timer);
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible);
    };
  }, [activeId]);

  const cards = useMemo(() => deck?.cards.filter((card) => level === 'all' || card.level === level) ?? [], [deck, level]);
  const due = useMemo(() => getDueCards(cards, reviews, now), [cards, reviews, now]);
  const available = due.filter((card) => !skipped.has(card.id));
  const active = deck?.cards.find((card) => card.id === activeId);
  const future = nextDueAt(cards, reviews, now);
  const newCount = due.filter((card) => !reviews[card.id]).length;

  function skip() {
    if (!active || savingRef.current || pendingReview.current) return;
    const nextSkipped = new Set(skipped).add(active.id);
    setSkipped(nextSkipped);
    setSaveError(null);
    setNow(Date.now());
    setActiveId(getDueCards(cards, reviews, Date.now()).find((card) => !nextSkipped.has(card.id))?.id ?? null);
  }

  async function rate(rating: Rating) {
    if (!active || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // Re-read before saving to pick up completed reviews from another tab.
      const latest = pendingReview.current ? reviews : await loadReviews();
      const timestamp = pendingReview.current?.reviewedAt ?? Date.now();
      const review = pendingReview.current ?? scheduleReview(active.id, latest[active.id], rating, timestamp);
      if (NAS_ENABLED) { pendingReview.current = review; setPendingRating(review.rating); }
      await saveReview(review);
      pendingReview.current = null; setPendingRating(null);
      const updated = { ...latest, [active.id]: review };
      setReviews(updated);
      setNow(timestamp);
      setReviewed((value) => value + 1);
      setActiveId(getDueCards(cards, updated, timestamp).find((card) => !skipped.has(card.id))?.id ?? null);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Could not save your review.');
      if (cause instanceof NasError && [400, 409, 413].includes(cause.status)) {
        pendingReview.current = null; setPendingRating(null);
        if (cause.status === 409) {
          try { setReviews(await loadReviews()); } catch { /* Keep the actionable original error. */ }
        }
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="masthead"><h1>Shadowing</h1><span className="preview-label">{NAS_ENABLED ? 'Private NAS · online' : 'Local practice'}</span></header>
      <main>
        <ProgressPanel disabled={!!activeId || saving} onImported={() => {
          setAttempt((value) => value + 1); setSyncError(null); void refreshActivity();
        }} />
        {syncError && <p role="alert" className="notice error">{syncError}</p>}
        {error ? <section className="deck-panel" role="alert"><h2>Could not load practice</h2><p>{error}</p><button onClick={() => setAttempt((value) => value + 1)}>Retry loading</button></section>
          : !deck ? <p role="status">Loading local deck and reviews…</p> : <>
            <section className="deck-panel" aria-labelledby="deck-title">
              <h2 id="deck-title">{deck.name}</h2>
              <p className="muted">{deck.cards.length.toLocaleString()} cards · {due.length - newCount} reviews due · {newCount} new</p>
              <div hidden={!!active}>
              <dl className="activity-stats" aria-label="Deck activity">
                <div><dt>Cards reviewed today</dt><dd>{activity ? today?.cardIds.length ?? 0 : '—'}</dd></div>
                <div><dt>Practice time today</dt><dd>{activity ? duration(today?.timeMs ?? 0) : '—'}</dd></div>
                <div><dt>All-time practice time</dt><dd>{activity ? duration(totalTime) : '—'}</dd></div>
              </dl>
              <p className="fine-print">{today?.reviews ?? 0} reviewed today.
                {activity && ` Tracking since ${new Date(activity.trackedSince).toLocaleDateString()}.`}</p>
              {activityError && <div className="notice error" role="alert">Statistics may be out of date: {activityError}
                <button onClick={() => { void refreshActivity(); }}>Retry statistics</button></div>}
              <nav className="toolbar" aria-label="Deck views">
                <button aria-pressed={view === 'practice'} onClick={() => setView('practice')}>Practice</button>
                <button aria-pressed={view === 'cards'} disabled={saving} onClick={() => {
                  if (!savingRef.current) { setActiveId(null); setSaveError(null); setView('cards'); }
                }}>View Cards</button>
              </nav>
              <div className="toolbar">
                <label>Level <select value={level} disabled={!!active} onChange={(event) => { setLevel(event.target.value); setSkipped(new Set()); }}>
                  <option value="all">All levels</option>{['HSK1', 'HSK2', 'HSK3', 'HSK4', 'HSK5'].map((value) => <option key={value} value={value}>{value}</option>)}
                </select></label>
                {!active && view === 'practice' && <label>Audio <select value={mode} onChange={(event) => setMode(event.target.value as PracticeMode)}>
                  <option value="sentence">Sentence</option><option value="word">Word</option>
                </select></label>}
                <span className="muted">{reviewed} reviewed this visit</span>
              </div>
              {!active && view === 'practice' && <>
                <p className="notice">This deck has no English recordings. Practice plays Chinese twice, then lets you record and rate. No generated speech is used.</p>
                {available.length ? <button className="primary" disabled={!!syncError} onClick={() => { setSaveError(null); setNow(Date.now()); setActiveId(available[0].id); }}>Start Review</button>
                  : <p role="status">{skipped.size && due.length ? 'Remaining due cards are skipped for this session.' : 'No cards due.'}{future !== null && ` Next review: ${new Date(future).toLocaleString()}.`}</p>}
                {skipped.size > 0 && <button className="restore-skipped" onClick={() => setSkipped(new Set())}>Restore skipped cards ({skipped.size})</button>}
                <details className="deck-details"><summary>Deck and storage details</summary>
                  <p>{deck.report.missingSentenceAudio} cards lack sentence audio; {deck.report.missingImages} lack images. All cards have Chinese word audio.</p>
                  <p>Reviews start fresh; the original Anki history is not imported or changed. Due reviews come before new cards. New cards follow deck order, with no daily limit.</p>
                  <p>{NAS_ENABLED ? 'Review dates and activity are saved on your private NAS. Keep one active practice device at a time. A conflicting rating is rejected rather than overwriting another device.'
                    : 'Review dates are saved only in this browser. Clearing site data or browser storage eviction removes progress. Keep one practice tab open; simultaneous ratings in multiple tabs are not supported.'}</p>
                </details>
              </>}
              </div>
            </section>
            {view === 'cards' && <ReviewedCards cards={cards} reviews={reviews} activity={activity} now={now} />}
            {active && <PracticeCard key={`${active.id}:${mode}`} card={active} mode={mode} showChinese={showChinese}
              previous={reviews[active.id]} saving={saving} pendingRating={pendingRating} error={saveError} onShowChinese={setShowChinese}
              onModeChange={setMode} onRate={(rating) => { void rate(rating); }} onSkip={skip}
              onEnd={() => { if (!savingRef.current && !pendingReview.current) { setActiveId(null); setSaveError(null); } }} />}
          </>}
      </main>
      <footer>{NAS_ENABLED ? 'Private NAS progress sync · Recordings never uploaded' : 'Local only · No uploads or cloud sync'}</footer>
    </div>
  );
}