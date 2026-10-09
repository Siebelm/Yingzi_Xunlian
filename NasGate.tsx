import { useEffect, useState, type ReactNode } from 'react';
import { NAS_ENABLED, nasRequest, recoverNasReviews } from './nasClient';

export default function NasGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(!NAS_ENABLED);
  const [checking, setChecking] = useState(NAS_ENABLED);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!NAS_ENABLED) return;
    let alive = true;
    void nasRequest('session').then(async (value) => {
      const signedIn = (value as { authenticated: boolean }).authenticated === true;
      if (signedIn) await recoverNasReviews();
      if (alive) setAuthenticated(signedIn);
    }).catch((cause: Error) => { if (alive) setError(cause.message); })
      .finally(() => { if (alive) setChecking(false); });
    const expired = () => { setAuthenticated(false); setError('Your NAS session ended. Sign in again.'); };
    window.addEventListener('nas-auth-expired', expired);
    return () => { alive = false; window.removeEventListener('nas-auth-expired', expired); };
  }, []);
  if (authenticated) return children;
  return <main className="app-shell"><section className="deck-panel">
    <h1>Private NAS practice</h1>
    <p>Sign in to share review schedules and activity. Recordings never leave this device.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (checking) return;
      setChecking(true); setError(null);
      const secret = password;
      setPassword('');
      void nasRequest('login', { password: secret }).then(recoverNasReviews).then(() => setAuthenticated(true))
        .catch((cause: Error) => setError(cause.message)).finally(() => setChecking(false));
    }}>
      <label className="viewer-search">NAS password<input type="password" autoComplete="current-password" required
        value={password} disabled={checking} onChange={(event) => setPassword(event.target.value)} /></label>
      <div className="toolbar"><button className="primary" disabled={checking}>{checking ? 'Connecting…' : 'Sign in'}</button></div>
    </form>
    {error && <p role="alert" className="notice error">{error}</p>}
  </section></main>;
}