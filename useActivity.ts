import { useCallback, useEffect, useRef, useState } from 'react';
import { PracticeClock, type Activity, type TimeBatch } from './activity';
import { loadActivity, savePracticeTime } from './reviewStore';

export function useActivity(active: boolean, completedReviews: number) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<TimeBatch[]>([]);
  const running = useRef(false);
  const alive = useRef(false);
  const refreshAgain = useRef(false);

  const refresh = useCallback(async () => {
    if (running.current) { refreshAgain.current = true; return; }
    running.current = true;
    try {
      do {
        refreshAgain.current = false;
        while (pending.current.length) {
          await savePracticeTime(pending.current[0]);
          pending.current.shift();
        }
        const stored = await loadActivity();
        if (alive.current) { setActivity(stored); setError(null); }
      } while (refreshAgain.current || pending.current.length);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not save practice statistics.');
    } finally { running.current = false; }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => { void refresh(); }, [completedReviews, refresh]);

  useEffect(() => {
    const clock = new PracticeClock();
    const sample = (enabled: boolean) => {
      const slices = clock.sample(enabled);
      if (slices.length) pending.current.push({ id: crypto.randomUUID(), slices });
      void refresh();
    };
    const visibility = () => sample(active && !document.hidden);
    const pagehide = () => sample(false);
    clock.sample(active && !document.hidden);
    const timer = setInterval(visibility, 5_000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      sample(false);
    };
  }, [active, refresh]);

  return { activity, error, refresh };
}