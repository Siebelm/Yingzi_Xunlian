// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useActivity } from './useActivity';
import { emptyActivity } from './activity';
import { loadActivity, savePracticeTime } from './reviewStore';

vi.mock('./reviewStore', () => ({ loadActivity: vi.fn(), savePracticeTime: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(loadActivity).mockResolvedValue(emptyActivity());
  vi.mocked(savePracticeTime).mockResolvedValue(undefined);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(async () => { cleanup(); await Promise.resolve(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('saves once per visible interval across StrictMode setup and excludes hidden/viewer time', async () => {
  const { rerender } = renderHook(({ active }) => useActivity(active, 0), {
    initialProps: { active: true }, wrapper: StrictMode,
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(savePracticeTime).toHaveBeenCalledTimes(1);
  expect(vi.mocked(savePracticeTime).mock.calls[0][0].slices[0].timeMs).toBe(5000);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(10_000); });
  expect(savePracticeTime).toHaveBeenCalledTimes(1);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(5000); });
  expect(savePracticeTime).toHaveBeenCalledTimes(2);
  rerender({ active: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(savePracticeTime).toHaveBeenCalledTimes(2);
});

it('keeps failed time batches for retry with the same ID and reports the error', async () => {
  vi.mocked(savePracticeTime).mockRejectedValueOnce(new Error('Storage full'));
  const { result } = renderHook(() => useActivity(true, 0));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.error).toBe('Storage full');
  const batch = vi.mocked(savePracticeTime).mock.calls[0][0];
  await act(async () => { await result.current.refresh(); });
  expect(vi.mocked(savePracticeTime).mock.calls[1][0]).toEqual(batch);
  expect(result.current.error).toBeNull();
});

it('flushes a partial interval on end and refreshes counts after a completed rating', async () => {
  const { rerender } = renderHook(({ active, completed }) => useActivity(active, completed), {
    initialProps: { active: true, completed: 0 },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(2300); });
  rerender({ active: false, completed: 1 });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(savePracticeTime).toHaveBeenCalledTimes(1);
  expect(vi.mocked(savePracticeTime).mock.calls[0][0].slices[0].timeMs).toBe(2300);
  expect(loadActivity).toHaveBeenCalled();
});