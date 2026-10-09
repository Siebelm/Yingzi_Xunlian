import { useRef, useState } from 'react';
import { exportProgress, importProgress } from './reviewStore';
import { NAS_ENABLED, nasRequest } from './nasClient';
import { assertSnapshot, type ProgressSnapshot } from './syncSchema';

export default function ProgressPanel({ disabled, onImported }: { disabled: boolean; onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ProgressSnapshot | null>(null);
  async function perform(action: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Progress operation failed.'); }
    finally { running.current = false; setBusy(false); }
  }
  return <details className="deck-details progress-panel"><summary>Progress backup{NAS_ENABLED ? ' & NAS sync' : ''}</summary>
    <p>{NAS_ENABLED ? 'Online-only NAS mode. Ratings save to your private NAS; use one active practice device at a time. Import your existing backup before starting practice.'
      : 'Local-only mode. Export here before moving to the NAS address; a new address cannot read this browser’s progress.'}</p>
    <p>Backups contain schedules and activity only, never recordings or deck media. Import is allowed only into empty storage, not merged with existing progress.</p>
    <fieldset disabled={disabled || busy} className="progress-controls">
      <button onClick={() => { void perform(async () => {
        const snapshot = await exportProgress();
        const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `shadowing-progress-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setMessage('Backup download requested. Keep the file private and verify it before moving devices.');
      }); }}>Export progress</button>
      <label className="viewer-search">Choose progress backup<input type="file" accept="application/json,.json" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; setCandidate(null);
        if (!file) return;
        void perform(async () => {
          if (file.size > 7 * 1024 * 1024) throw new Error('Backup is too large (maximum 7 MiB).');
          const value: unknown = JSON.parse(await file.text()); assertSnapshot(value); setCandidate(value);
        });
      }} /></label>
      {candidate && <div className="notice">
        <p>{Object.keys(candidate.reviews).length} reviewed cards · tracked since {new Date(candidate.activity.trackedSince).toLocaleDateString()}.</p>
        <button onClick={() => { void perform(async () => {
          await importProgress(candidate); setCandidate(null); setMessage('Progress imported.'); onImported();
        }); }}>Import into empty {NAS_ENABLED ? 'NAS' : 'browser'}</button>
        <button onClick={() => setCandidate(null)}>Cancel import</button>
      </div>}
      {NAS_ENABLED && <div className="toolbar">
        <button onClick={onImported}>Refresh NAS progress</button>
        <button onClick={() => { void perform(async () => {
          await nasRequest('logout', {}); window.dispatchEvent(new Event('nas-auth-expired'));
        }); }}>Sign out</button>
      </div>}
    </fieldset>
    {disabled && <p>End the practice session before managing backups or signing out.</p>}
    {busy && <p role="status">Updating progress…</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
  </details>;
}