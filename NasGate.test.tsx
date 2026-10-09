// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NasGate from './NasGate';

const nas = vi.hoisted(() => ({ enabled: true, request: vi.fn(), recover: vi.fn() }));
vi.mock('./nasClient', () => ({ get NAS_ENABLED() { return nas.enabled; }, nasRequest: nas.request, recoverNasReviews: nas.recover }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const child = <div>Authenticated practice content</div>;
beforeEach(() => {
  nas.enabled = true;
  nas.request.mockReset().mockResolvedValue({ authenticated: false });
  nas.recover.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('NAS authentication gate', () => {
  it('renders immediately in local mode without session probes, recovery, or expiry listeners', () => {
    nas.enabled = false;
    render(<NasGate>{child}</NasGate>);
    expect(screen.getByText('Authenticated practice content')).toBeTruthy();
    expect(nas.request).not.toHaveBeenCalled();
    expect(nas.recover).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event('nas-auth-expired')));
    expect(screen.getByText('Authenticated practice content')).toBeTruthy();
    expect(screen.queryByLabelText('NAS password')).toBeNull();
  });

  it('disables login while checking and settles pending reviews before exposing children', async () => {
    const session = deferred<{ authenticated: boolean }>();
    const recovery = deferred<void>();
    nas.request.mockReturnValueOnce(session.promise);
    nas.recover.mockReturnValueOnce(recovery.promise);
    render(<NasGate>{child}</NasGate>);
    expect((screen.getByLabelText('NAS password') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => session.resolve({ authenticated: true }));
    expect(nas.recover).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Authenticated practice content')).toBeNull();
    await act(async () => recovery.resolve(undefined));
    expect(screen.getByText('Authenticated practice content')).toBeTruthy();
    expect(nas.request).toHaveBeenCalledExactlyOnceWith('session');
  });

  it('submits the password only to login, clears it immediately, and waits for recovery', async () => {
    const user = userEvent.setup();
    const login = deferred<unknown>();
    const recovery = deferred<void>();
    nas.request.mockResolvedValueOnce({ authenticated: false }).mockReturnValueOnce(login.promise);
    nas.recover.mockReturnValueOnce(recovery.promise);
    const set = vi.spyOn(Storage.prototype, 'setItem');
    render(<NasGate>{child}</NasGate>);
    await screen.findByRole('button', { name: 'Sign in' });
    const input = screen.getByLabelText('NAS password') as HTMLInputElement;
    await user.type(input, 'test-only-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(nas.request).toHaveBeenLastCalledWith('login', { password: 'test-only-password' });
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    expect(nas.recover).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    await act(async () => login.resolve({ authenticated: true }));
    expect(nas.recover).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Authenticated practice content')).toBeNull();
    await act(async () => recovery.resolve(undefined));
    expect(screen.getByText('Authenticated practice content')).toBeTruthy();
  });

  it('removes authenticated children on expiry and recovers before remounting after login', async () => {
    nas.request.mockResolvedValueOnce({ authenticated: true });
    const user = userEvent.setup();
    render(<NasGate>{child}</NasGate>);
    await screen.findByText('Authenticated practice content');
    act(() => window.dispatchEvent(new Event('nas-auth-expired')));
    expect(screen.queryByText('Authenticated practice content')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Your NAS session ended');
    await user.type(screen.getByLabelText('NAS password'), 'reauth-only');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Authenticated practice content');
    expect(nas.recover).toHaveBeenCalledTimes(2);
    expect(nas.request).toHaveBeenLastCalledWith('login', { password: 'reauth-only' });
  });

  it.each(['session', 'login', 'recovery'])('shows %s failures without exposing practice and permits retry', async (stage) => {
    const user = userEvent.setup();
    if (stage === 'session') nas.request.mockRejectedValueOnce(new Error('Session unavailable'));
    if (stage === 'recovery') {
      nas.request.mockResolvedValueOnce({ authenticated: true });
      nas.recover.mockRejectedValueOnce(new Error('Recovery unavailable'));
    }
    if (stage === 'login') nas.request.mockResolvedValueOnce({ authenticated: false }).mockRejectedValueOnce(new Error('Invalid password'));
    render(<NasGate>{child}</NasGate>);
    await screen.findByRole('button', { name: 'Sign in' });
    if (stage === 'login') {
      await user.type(screen.getByLabelText('NAS password'), 'wrong');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
    }
    expect((await screen.findByRole('alert')).textContent).toMatch(/unavailable|Invalid password/);
    expect(screen.queryByText('Authenticated practice content')).toBeNull();
    expect((screen.getByLabelText('NAS password') as HTMLInputElement).value).toBe('');
    await user.type(screen.getByLabelText('NAS password'), 'retry');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Authenticated practice content');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not duplicate an in-flight login on double click', async () => {
    const user = userEvent.setup();
    const login = deferred<unknown>();
    nas.request.mockResolvedValueOnce({ authenticated: false }).mockReturnValueOnce(login.promise);
    render(<NasGate>{child}</NasGate>);
    await screen.findByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText('NAS password'), 'test-only');
    await user.dblClick(screen.getByRole('button', { name: 'Sign in' }));
    expect(nas.request).toHaveBeenCalledTimes(2);
    await act(async () => login.resolve({}));
  });

  it('removes the expiry listener and ignores a late session response after unmount', async () => {
    const session = deferred<{ authenticated: boolean }>();
    nas.request.mockReturnValueOnce(session.promise);
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<NasGate>{child}</NasGate>);
    unmount();
    expect(remove).toHaveBeenCalledWith('nas-auth-expired', expect.any(Function));
    await act(async () => session.resolve({ authenticated: false }));
    expect(screen.queryByText('Authenticated practice content')).toBeNull();
  });
});