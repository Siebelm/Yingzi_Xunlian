// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgressPanel from './ProgressPanel';
import { DECK_ID, emptyActivity } from './activity';
import { scheduleReview } from './scheduler';

const mocks = vi.hoisted(() => ({ enabled: false, export: vi.fn(), import: vi.fn(), request: vi.fn() }));
vi.mock('./reviewStore', () => ({ exportProgress: mocks.export, importProgress: mocks.import }));
vi.mock('./nasClient', () => ({ get NAS_ENABLED() { return mocks.enabled; }, nasRequest: mocks.request }));
const snapshot = () => ({ format: 1, deckId: DECK_ID, reviews: { one: scheduleReview('one', undefined, 'good', 1000) },
  activity: { ...emptyActivity(['legacy']), trackedSince: 1000 } });
function backup(text = JSON.stringify(snapshot())) {
  const file = new File([text], 'progress.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(text) });
  return file;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(disabled = false) {
  const user = userEvent.setup();
  const imported = vi.fn();
  const view = render(<ProgressPanel disabled={disabled} onImported={imported} />);
  await user.click(screen.getByText(/^Progress backup/));
  return { user, imported, ...view };
}
beforeEach(() => {
  mocks.enabled = false;
  mocks.export.mockReset().mockResolvedValue(snapshot());
  mocks.import.mockReset().mockResolvedValue(undefined);
  mocks.request.mockReset().mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('backup preview and explicit confirmation', () => {
  it.each([false, true])('previews without importing; cancel is read-only (NAS=%s)', async (nas) => {
    mocks.enabled = nas;
    const { user, imported } = await setup();
    const input = screen.getByLabelText('Choose progress backup');
    await user.upload(input, backup());
    expect(await screen.findByText(/1 reviewed cards · tracked since/)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Import into empty ${nas ? 'NAS' : 'browser'}` })).toBeTruthy();
    expect(mocks.import).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(screen.queryByText(/1 reviewed cards/)).toBeNull();
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it('imports only on confirmation and notifies the parent only after commit', async () => {
    const pending = deferred<void>();
    mocks.import.mockReturnValueOnce(pending.promise);
    const { user, imported } = await setup();
    await user.upload(screen.getByLabelText('Choose progress backup'), backup());
    await user.dblClick(await screen.findByRole('button', { name: 'Import into empty browser' }));
    expect(mocks.import).toHaveBeenCalledExactlyOnceWith(snapshot());
    expect(imported).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Updating progress…');
    expect(screen.getByRole('button', { name: 'Cancel import' }).closest('fieldset')?.disabled).toBe(true);
    await act(async () => pending.resolve(undefined));
    expect(imported).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Progress imported.');
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull();
  });

  it('retains a failed import candidate for an explicit retry and displays the error', async () => {
    mocks.import.mockRejectedValueOnce(new Error('Existing progress was not overwritten'));
    const { user, imported } = await setup();
    await user.upload(screen.getByLabelText('Choose progress backup'), backup());
    await user.click(await screen.findByRole('button', { name: 'Import into empty browser' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Existing progress was not overwritten');
    expect(imported).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Import into empty browser' }));
    expect(imported).toHaveBeenCalledTimes(1);
    expect(mocks.import.mock.calls[1]).toEqual(mocks.import.mock.calls[0]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['invalid JSON', 'recording field', 'oversized', 'file read error'])('rejects %s before importing and clears the previous preview', async (kind) => {
    const { user, imported } = await setup();
    const input = screen.getByLabelText('Choose progress backup');
    await user.upload(input, backup());
    await screen.findByRole('button', { name: 'Cancel import' });
    const file = kind === 'invalid JSON' ? backup('{') : kind === 'recording field' ? backup(JSON.stringify({ ...snapshot(), recording: 'private' })) : backup();
    if (kind === 'oversized') Object.defineProperty(file, 'size', { value: 7 * 1024 * 1024 + 1 });
    if (kind === 'file read error') vi.mocked(file.text).mockRejectedValueOnce(new Error('Unable to read file'));
    await user.upload(input, file);
    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
    if (kind === 'oversized') { expect(file.text).not.toHaveBeenCalled(); expect(screen.getByRole('alert').textContent).toContain('maximum 7 MiB'); }
    expect(screen.queryByRole('button', { name: /Import into empty/ })).toBeNull();
    expect(mocks.import).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
  });

  it('does nothing when the file picker is cancelled', async () => {
    await setup();
    fireEvent.change(screen.getByLabelText('Choose progress backup'), { target: { files: [] } });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables export, upload, confirm, cancel, refresh and sign out during practice', async () => {
    mocks.enabled = true;
    const { user, imported, rerender } = await setup();
    await user.upload(screen.getByLabelText('Choose progress backup'), backup());
    await screen.findByRole('button', { name: 'Cancel import' });
    rerender(<ProgressPanel disabled onImported={imported} />);
    expect(screen.getByText(/End the practice session/)).toBeTruthy();
    for (const button of screen.getAllByRole('button')) {
      expect(button.matches(':disabled')).toBe(true);
      await user.click(button);
    }
    const file = backup();
    await user.upload(screen.getByLabelText('Choose progress backup'), file);
    expect(file.text).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.import).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
  });
});

describe('safe downloads and NAS controls', () => {
  it('downloads JSON through a temporary blob URL, removes the anchor, and revokes the URL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    const create = vi.fn((_blob: Blob) => 'blob:http://localhost/test-backup');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicked: { href: string; download: string; connected: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, connected: this.isConnected });
    });
    const imported = vi.fn();
    render(<ProgressPanel disabled={false} onImported={imported} />);
    fireEvent.click(screen.getByText('Progress backup'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export progress' })); });
    expect(create).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0][0];
    expect(blob.type).toBe('application/json');
    expect(blob.size).toBe(new Blob([JSON.stringify(snapshot(), null, 2)]).size);
    expect(clicked).toEqual([{ href: 'blob:http://localhost/test-backup', download: 'shadowing-progress-2026-10-09.json', connected: true }]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Backup download requested');
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59999);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:http://localhost/test-backup');
    expect(mocks.import).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
  });

  it('shows export failure and re-enables controls', async () => {
    mocks.export.mockRejectedValueOnce(new Error('Cannot read progress'));
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Export progress' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Cannot read progress');
    expect(screen.getByRole('button', { name: 'Export progress' }).matches(':disabled')).toBe(false);
  });

  it('hides NAS controls and makes no probes in local mode', async () => {
    await setup();
    expect(screen.getByText(/Local-only mode/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh NAS progress' })).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('refreshes explicitly and emits expiry only after logout succeeds', async () => {
    mocks.enabled = true;
    const pending = deferred<unknown>();
    mocks.request.mockReturnValueOnce(pending.promise);
    const expired = vi.fn();
    window.addEventListener('nas-auth-expired', expired);
    try {
      const { user, imported } = await setup();
      await user.click(screen.getByRole('button', { name: 'Refresh NAS progress' }));
      expect(imported).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith('logout', {});
      expect(expired).not.toHaveBeenCalled();
      await act(async () => pending.resolve({}));
      expect(expired).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('nas-auth-expired', expired); }
  });

  it('shows logout errors without falsely ending the session', async () => {
    mocks.enabled = true;
    mocks.request.mockRejectedValueOnce(new Error('Logout unavailable'));
    const expired = vi.fn();
    window.addEventListener('nas-auth-expired', expired);
    try {
      const { user } = await setup();
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Logout unavailable');
      expect(expired).not.toHaveBeenCalled();
    } finally { window.removeEventListener('nas-auth-expired', expired); }
  });
});