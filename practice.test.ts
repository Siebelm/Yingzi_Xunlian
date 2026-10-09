// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PracticeSession, recordingMimeType, type PracticeState } from './practice';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const playResult = vi.fn<() => Promise<void>>();
const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
let played: string[];

// Events are driven explicitly: a resolved play() promise is NOT an ended event.
class MockAudio {
  static instances: MockAudio[] = [];
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  onwaiting: (() => void) | null = null;
  play = vi.fn(() => { played.push(this.src); return playResult(); });
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });

  constructor() { MockAudio.instances.push(this); }
}

function microphone() {
  const tracks = Array.from({ length: 2 }, () => ({
    onended: null as (() => void) | null,
    stop: vi.fn(),
  }));
  const stream = {
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks),
  } as unknown as MediaStream;
  return { stream, tracks };
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn<(type: string) => boolean>();
  state: RecordingState = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  chunks = [new Blob(['recorded audio'], { type: 'audio/webm' })];
  start = vi.fn(() => { this.state = 'recording'; });
  stop = vi.fn(() => {
    if (this.state === 'inactive') throw new DOMException('Already stopped', 'InvalidStateError');
    this.state = 'inactive';
    // Real MediaRecorder delivers final data and stop asynchronously. Read the
    // handlers at dispatch time so cancellation can detach them normally.
    setTimeout(() => {
      this.chunks.forEach((data) => this.ondataavailable?.({ data }));
      this.onstop?.();
    }, 0);
  });

  constructor(public stream: MediaStream, public options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/browser-default';
    MockMediaRecorder.instances.push(this);
  }
}

let session: PracticeSession;
let changes: PracticeState[];
let mic: ReturnType<typeof microphone>;
const state = () => changes.at(-1)!;
const audio = () => MockAudio.instances.at(-1)!;
const recorder = () => MockMediaRecorder.instances.at(-1)!;
const flushEvents = () => vi.advanceTimersByTimeAsync(0);

function readyToRecord() {
  session.start(null, '/chinese.mp3');
  audio().onended?.();
  audio().onended?.();
  expect(state().phase).toBe('awaiting-record');
}

async function beginRecording() {
  readyToRecord();
  await session.record();
  expect(state().phase).toBe('recording');
  return recorder();
}

async function recordedPlayback() {
  const recording = await beginRecording();
  session.stopRecording();
  await flushEvents();
  expect(state()).toEqual({ phase: 'playing', label: 'Your recording' });
  return recording;
}

function expectTracksReleased(source = mic) {
  for (const track of source.tracks) {
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(track.onended).toBeNull();
  }
}

function expectAudioCleared(target = audio()) {
  expect(target.pause).toHaveBeenCalled();
  expect(target.removeAttribute).toHaveBeenCalledWith('src');
  expect(target.load).toHaveBeenCalled();
  expect(target.src).toBe('');
  expect(target.onended).toBeNull();
  expect(target.onerror).toBeNull();
  expect(target.onplaying).toBeNull();
  expect(target.onwaiting).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  MockAudio.instances = [];
  MockMediaRecorder.instances = [];
  played = [];
  changes = [];
  mic = microphone();
  playResult.mockResolvedValue(undefined);
  getUserMedia.mockResolvedValue(mic.stream);
  MockMediaRecorder.isTypeSupported.mockImplementation((type) => type === 'audio/webm;codecs=opus');
  createObjectURL.mockImplementation((_blob) => `blob:practice-${createObjectURL.mock.calls.length}`);
  vi.stubGlobal('Audio', MockAudio);
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  session = new PracticeSession((value) => changes.push({ ...value }));
});

afterEach(() => {
  session.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('reference playback', () => {
  it('plays English exactly once and Chinese exactly twice, advancing only on ended', async () => {
    session.start('/english.mp3', '/chinese.mp3');
    expect(state()).toEqual({ phase: 'playing', label: 'English · 1 of 1' });
    await flushEvents();
    audio().onplaying?.();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(played).toEqual(['/english.mp3']);
    expect(state().label).toBe('English · 1 of 1');
    audio().onended?.();
    expect(state()).toEqual({ phase: 'playing', label: 'Chinese · 1 of 2' });
    await flushEvents();
    expect(played).toEqual(['/english.mp3', '/chinese.mp3']);
    audio().onended?.();
    expect(state()).toEqual({ phase: 'playing', label: 'Chinese · 2 of 2' });
    audio().onended?.();
    audio().onended?.(); // Duplicate completion must not advance again.
    expect(state()).toEqual({ phase: 'awaiting-record', label: 'Ready to record' });
    expect(played).toEqual(['/english.mp3', '/chinese.mp3', '/chinese.mp3']);
    expect(changes.filter((value) => value.phase === 'playing').map((value) => value.label))
      .toEqual(['English · 1 of 1', 'Chinese · 1 of 2', 'Chinese · 2 of 2']);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts with Chinese when English is missing', () => {
    readyToRecord();
    expect(played).toEqual(['/chinese.mp3', '/chinese.mp3']);
    expect(changes.some((value) => value.label.startsWith('English'))).toBe(false);
  });

  it.each([0, 1, 2])('retries autoplay rejection at exact reference stage %i', async (stage) => {
    const labels = ['English · 1 of 1', 'Chinese · 1 of 2', 'Chinese · 2 of 2'];
    if (stage === 0) playResult.mockRejectedValueOnce(new DOMException('Tap required', 'NotAllowedError'));
    session.start('/english.mp3', '/chinese.mp3');
    for (let index = 1; index <= stage; index++) {
      if (index === stage) playResult.mockRejectedValueOnce(new DOMException('Tap required', 'NotAllowedError'));
      audio().onended?.();
    }
    await flushEvents();
    expect(state()).toMatchObject({ phase: 'blocked', label: labels[stage], message: expect.stringMatching(/tap/) });
    const beforeRetry = [...played];
    audio().onended?.();
    expect(played).toEqual(beforeRetry);
    session.retry();
    expect(state()).toEqual({ phase: 'playing', label: labels[stage] });
    expect(played).toEqual([...beforeRetry, beforeRetry.at(-1)]);
    session.retry();
    expect(played).toHaveLength(beforeRetry.length + 1);
    for (let index = stage; index < 3; index++) audio().onended?.();
    expect(state().phase).toBe('awaiting-record');
    expect(played).toEqual([
      '/english.mp3', ...(stage === 0 ? ['/english.mp3'] : []),
      '/chinese.mp3', ...(stage === 1 ? ['/chinese.mp3'] : []),
      '/chinese.mp3', ...(stage === 2 ? ['/chinese.mp3'] : []),
    ]);
  });

  it.each(['media event', 'rejected promise', 'synchronous throw'])('retries a playback failure: %s', async (kind) => {
    session.start('/english.mp3', '/chinese.mp3');
    audio().onended?.();
    if (kind === 'rejected promise') playResult.mockRejectedValueOnce(new Error('decoder failed'));
    if (kind === 'synchronous throw') playResult.mockImplementationOnce(() => { throw new Error('decoder failed'); });
    audio().onended?.();
    if (kind === 'media event') audio().onerror?.();
    await flushEvents();
    expect(state()).toMatchObject({ phase: 'error', label: 'Chinese · 2 of 2' });
    expect(audio().pause).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    session.retry();
    expect(state()).toEqual({ phase: 'playing', label: 'Chinese · 2 of 2' });
    expect(played).toEqual(['/english.mp3', '/chinese.mp3', '/chinese.mp3', '/chinese.mp3']);
    audio().onended?.();
    expect(state().phase).toBe('awaiting-record');
  });

  it('times out loading/stalling at 30 seconds, while playing clears the watchdog', async () => {
    session.start(null, '/chinese.mp3');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(state().phase).toBe('playing');
    await vi.advanceTimersByTimeAsync(1);
    expect(state()).toMatchObject({ phase: 'error', message: expect.stringMatching(/did not load/) });
    session.retry();
    audio().onplaying?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state().phase).toBe('playing');
    audio().onwaiting?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state().phase).toBe('error');
    expect(played).toEqual(['/chinese.mp3', '/chinese.mp3']);
  });
});

describe('recording and immediate local playback', () => {
  it('requests audio, starts/stops once, plays the blob immediately, and reviews only after ended', async () => {
    const recording = await beginRecording();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(recording.stream).toBe(mic.stream);
    expect(recording.start).toHaveBeenCalledTimes(1);
    expect(recording.state).toBe('recording');
    expectAudioCleared();
    await session.record();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    session.stopRecording();
    session.stopRecording();
    expect(recording.stop).toHaveBeenCalledTimes(1);
    expect(state()).toEqual({ phase: 'requesting', label: 'Preparing recorded playback' });
    expect(createObjectURL).not.toHaveBeenCalled();
    await flushEvents();
    expectTracksReleased();
    expect(recording.ondataavailable).toBeNull();
    expect(recording.onstop).toBeNull();
    expect(recording.onerror).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(recording.chunks[0].size);
    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(played).toEqual(['/chinese.mp3', '/chinese.mp3', 'blob:practice-1']);
    expect(state()).toEqual({ phase: 'playing', label: 'Your recording' });
    audio().onplaying?.();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(changes.some((value) => value.phase === 'review')).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    audio().onended?.();
    expect(state()).toEqual({ phase: 'review', label: 'Rate this card' });
    expectAudioCleared();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:practice-1');
    session.dispose();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['autoplay', 'media error'])('retries recorded playback after %s without recording again or revoking early', async (failure) => {
    await beginRecording();
    if (failure === 'autoplay') playResult.mockRejectedValueOnce(new DOMException('Tap required', 'NotAllowedError'));
    session.stopRecording();
    await flushEvents();
    if (failure === 'media error') audio().onerror?.();
    expect(state()).toMatchObject({ phase: failure === 'autoplay' ? 'blocked' : 'error', label: 'Your recording' });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    session.retry();
    expect(state()).toEqual({ phase: 'playing', label: 'Your recording' });
    expect(played.slice(-2)).toEqual(['blob:practice-1', 'blob:practice-1']);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    audio().onended?.();
    expect(state().phase).toBe('review');
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:practice-1');
  });

  it('automatically stops at exactly 60 seconds and uses the normal playback/review flow', async () => {
    const recording = await beginRecording();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(recording.stop).not.toHaveBeenCalled();
    expect(state().phase).toBe('recording');
    await vi.advanceTimersByTimeAsync(1);
    expect(recording.stop).toHaveBeenCalledTimes(1);
    // A timer scheduled by another timer may dispatch on the next fake tick.
    await vi.advanceTimersByTimeAsync(1);
    expectTracksReleased();
    expect(state()).toEqual({ phase: 'playing', label: 'Your recording' });
    expect(changes.some((value) => value.phase === 'review')).toBe(false);
    audio().onended?.();
    expect(state().phase).toBe('review');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['no chunks', 'zero-size chunks'])('rejects an empty recording: %s', async (kind) => {
    const recording = await beginRecording();
    recording.chunks = kind === 'no chunks' ? [] : [new Blob([]), new Blob([])];
    session.stopRecording();
    await flushEvents();
    expectTracksReleased();
    expect(state()).toMatchObject({ phase: 'error', message: expect.stringMatching(/No audio was captured/) });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(played).toEqual(['/chinese.mp3', '/chinese.mp3']);
    const replacement = microphone();
    getUserMedia.mockResolvedValueOnce(replacement.stream);
    session.retry();
    await flushEvents();
    expect(state().phase).toBe('recording');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it.each(['recorder error', 'microphone disconnect'])('releases tracks and permits retry after %s', async (failure) => {
    const recording = await beginRecording();
    if (failure === 'recorder error') recording.onerror?.();
    else mic.tracks[0].onended?.();
    expect(state()).toMatchObject({
      phase: 'error', label: 'Recording unavailable',
      message: expect.stringMatching(failure === 'recorder error' ? /recording failed/ : /disconnected/),
    });
    expectTracksReleased();
    expect(recording.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(recording.onstop).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    getUserMedia.mockResolvedValueOnce(microphone().stream);
    session.retry();
    await flushEvents();
    expect(state().phase).toBe('recording');
    expect(MockMediaRecorder.instances).toHaveLength(2);
  });

  it('cancels and releases tracks when recorder.stop throws', async () => {
    const recording = await beginRecording();
    recording.stop.mockImplementationOnce(() => { throw new Error('interrupted'); });
    session.stopRecording();
    await flushEvents();
    expect(state()).toMatchObject({ phase: 'idle', message: expect.stringMatching(/interrupted/) });
    expectTracksReleased();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('MIME negotiation', () => {
  const choices: [string, string[], string | undefined][] = [
    ['Safari MP4 preferred', ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'], 'audio/mp4'],
    ['WebM Opus', ['audio/webm;codecs=opus', 'audio/webm'], 'audio/webm;codecs=opus'],
    ['plain WebM', ['audio/webm'], 'audio/webm'],
    ['Ogg fallback', ['audio/ogg;codecs=opus'], 'audio/ogg;codecs=opus'],
    ['browser default', [], undefined],
  ];
  it.each(choices)('selects and constructs the recorder with %s', async (_name, supported, expected) => {
    MockMediaRecorder.isTypeSupported.mockImplementation((type) => supported.includes(type));
    expect(recordingMimeType()).toBe(expected);
    const recording = await beginRecording();
    expect(recording.options).toEqual(expected ? { mimeType: expected } : undefined);
    session.stopRecording();
    await flushEvents();
    expect(createObjectURL.mock.calls[0][0].type).toBe(expected ?? 'audio/browser-default');
  });

  it('uses browser defaults when isTypeSupported is absent', async () => {
    class WithoutProbe extends MockMediaRecorder {}
    Object.defineProperty(WithoutProbe, 'isTypeSupported', { value: undefined });
    vi.stubGlobal('MediaRecorder', WithoutProbe);
    expect(recordingMimeType()).toBeUndefined();
    const recording = await beginRecording();
    expect(recording.options).toBeUndefined();
  });

  it('returns undefined when MediaRecorder is unavailable', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(recordingMimeType()).toBeUndefined();
  });

  it('uses the first nonempty chunk MIME when the recorder exposes none', async () => {
    const recording = await beginRecording();
    recording.mimeType = '';
    recording.chunks = [new Blob([]), new Blob(['one'], { type: 'audio/mp4' }), new Blob(['two'])];
    session.stopRecording();
    await flushEvents();
    expect(createObjectURL.mock.calls[0][0].type).toBe('audio/mp4');
    expect(createObjectURL.mock.calls[0][0].size).toBe(6);
  });
});

describe('permission and support failures', () => {
  it.each([
    ['NotAllowedError', /permission was denied/],
    ['NotFoundError', /No microphone was found/],
    ['NotReadableError', /Could not start recording/],
  ])('reports %s and retries permission without starting a recorder prematurely', async (name, message) => {
    readyToRecord();
    getUserMedia.mockRejectedValueOnce(new DOMException('Unavailable', name));
    await session.record();
    expect(state()).toMatchObject({ phase: 'error', message: expect.stringMatching(message) });
    expect(MockMediaRecorder.instances).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
    session.retry();
    await flushEvents();
    expect(state().phase).toBe('recording');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    session.cancel();
    expectTracksReleased();
  });

  it.each(['insecure context', 'missing mediaDevices', 'missing getUserMedia', 'missing MediaRecorder'])
    ('reports unsupported recording: %s', async (missing) => {
      if (missing === 'insecure context') vi.stubGlobal('isSecureContext', false);
      if (missing === 'missing mediaDevices') vi.stubGlobal('navigator', {});
      if (missing === 'missing getUserMedia') vi.stubGlobal('navigator', { mediaDevices: {} });
      if (missing === 'missing MediaRecorder') vi.stubGlobal('MediaRecorder', undefined);
      readyToRecord();
      await session.record();
      expect(state()).toMatchObject({ phase: 'error', message: expect.stringMatching(/supported browser.*secure context/) });
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(MockMediaRecorder.instances).toHaveLength(0);
    });

  it('releases an acquired stream if recorder construction fails', async () => {
    vi.stubGlobal('MediaRecorder', class {
      constructor() { throw new Error('unsupported device'); }
    });
    readyToRecord();
    await session.record();
    expect(state()).toMatchObject({ phase: 'error', message: expect.stringMatching(/Could not start recording/) });
    expectTracksReleased();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('ignores duplicate record requests while permission is pending', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(permission.promise);
    readyToRecord();
    const pending = session.record();
    expect(state().phase).toBe('requesting');
    await session.record();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    permission.resolve(mic.stream);
    await pending;
    expect(MockMediaRecorder.instances).toHaveLength(1);
  });

  it.each(['cancel', 'interrupt', 'dispose', 'restart'] as const)
    ('releases late permission grants after %s without resurrecting the session', async (action) => {
      const permission = deferred<MediaStream>();
      getUserMedia.mockReturnValueOnce(permission.promise);
      readyToRecord();
      const pending = session.record();
      if (action === 'restart') session.start('/new-english.mp3', '/new-chinese.mp3');
      else session[action]();
      const snapshot = [...changes];
      const previousPlayback = [...played];
      permission.resolve(mic.stream);
      await pending;
      expectTracksReleased();
      expect(changes).toEqual(snapshot);
      expect(played).toEqual(previousPlayback);
      expect(MockMediaRecorder.instances).toHaveLength(0);
      expect(createObjectURL).not.toHaveBeenCalled();
    });

  it('ignores a late permission rejection after cancellation', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(permission.promise);
    readyToRecord();
    const pending = session.record();
    session.cancel();
    const snapshot = [...changes];
    permission.reject(new DOMException('Denied', 'NotAllowedError'));
    await pending;
    session.retry();
    expect(changes).toEqual(snapshot);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe('interruption, cancellation and disposal', () => {
  // The application owns visibility listeners; test the controller's public
  // interrupt() entry point, not document visibilitychange wiring.
  it.each(['reference', 'awaiting-record', 'blocked', 'recording', 'preparing', 'recorded playback'] as const)
    ('interrupts a hidden-session scenario during %s', async (stage) => {
      if (stage === 'reference' || stage === 'blocked') {
        if (stage === 'blocked') playResult.mockRejectedValueOnce(new DOMException('Tap', 'NotAllowedError'));
        session.start('/english.mp3', '/chinese.mp3');
        await flushEvents();
      } else if (stage === 'awaiting-record') readyToRecord();
      else if (stage === 'recorded playback') await recordedPlayback();
      else {
        await beginRecording();
        if (stage === 'preparing') session.stopRecording();
      }
      const playbackCount = played.length;
      session.interrupt();
      expect(state()).toMatchObject({ phase: 'idle', message: expect.stringMatching(/Session interrupted.*discarded/) });
      expectAudioCleared();
      if (['recording', 'preparing', 'recorded playback'].includes(stage)) expectTracksReleased();
      if (stage === 'recorded playback') expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:practice-1');
      else expect(createObjectURL).not.toHaveBeenCalled();
      const snapshot = [...changes];
      session.retry();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(changes).toEqual(snapshot);
      expect(played).toHaveLength(playbackCount);
      expect(vi.getTimerCount()).toBe(0);
    });

  it('does not interrupt idle or completed review states', () => {
    session.interrupt();
    expect(changes).toEqual([]);
    session.reviewWithoutRecording();
    const snapshot = [...changes];
    session.interrupt();
    expect(changes).toEqual(snapshot);
    expect(state().phase).toBe('review');
  });

  it.each(['cancel', 'dispose', 'restart', 'skip review'] as const)
    ('revokes a recorded blob exactly once on %s', async (action) => {
      await recordedPlayback();
      const oldEnded = audio().onended!;
      const snapshot = [...changes];
      if (action === 'restart') session.start('/next.mp3', '/next-chinese.mp3');
      else if (action === 'skip review') session.reviewWithoutRecording();
      else session[action]();
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:practice-1');
      expectTracksReleased();
      if (action === 'dispose') expect(changes).toEqual(snapshot);
      if (action !== 'restart') expectAudioCleared();
      const afterAction = [...changes];
      oldEnded();
      expect(changes).toEqual(afterAction);
      session.dispose();
      session.dispose();
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    });

  it('disposes an active recorder without emitting state or creating a blob', async () => {
    const recording = await beginRecording();
    const snapshot = [...changes];
    session.dispose();
    session.dispose();
    expectTracksReleased();
    expectAudioCleared();
    expect(recording.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    session.start('/ignored.mp3', '/ignored-chinese.mp3');
    await session.record();
    session.retry();
    expect(changes).toEqual(snapshot);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(played).toEqual(['/chinese.mp3', '/chinese.mp3']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stale asynchronous playback', () => {
  it.each(['cancel', 'interrupt', 'dispose', 'restart'] as const)
    ('ignores stale play rejections and captured media events after %s', async (action) => {
      const playback = deferred<void>();
      playResult.mockReturnValueOnce(playback.promise);
      session.start('/old.mp3', '/old-chinese.mp3');
      const oldEvents = [audio().onended!, audio().onerror!, audio().onplaying!, audio().onwaiting!];
      if (action === 'restart') session.start('/new.mp3', '/new-chinese.mp3');
      else session[action]();
      const snapshot = [...changes];
      const previousPlayback = [...played];
      const timers = vi.getTimerCount();
      oldEvents.forEach((event) => event());
      playback.reject(new DOMException('Late autoplay failure', 'NotAllowedError'));
      await flushEvents();
      session.retry();
      expect(changes).toEqual(snapshot);
      expect(played).toEqual(previousPlayback);
      expect(vi.getTimerCount()).toBe(timers);
      if (action === 'restart') {
        audio().onended?.();
        expect(state()).toEqual({ phase: 'playing', label: 'Chinese · 1 of 2' });
        expect(played.at(-1)).toBe('/new-chinese.mp3');
      }
    });

  it('ignores a stale play resolution after cancellation', async () => {
    const playback = deferred<void>();
    playResult.mockReturnValueOnce(playback.promise);
    session.start('/old.mp3', '/chinese.mp3');
    session.cancel();
    const snapshot = [...changes];
    playback.resolve(undefined);
    await flushEvents();
    expect(changes).toEqual(snapshot);
    expectAudioCleared();
    expect(played).toEqual(['/old.mp3']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores previous-clip events/rejection without clearing the current clip watchdog', async () => {
    const playback = deferred<void>();
    playResult.mockReturnValueOnce(playback.promise);
    session.start('/english.mp3', '/chinese.mp3');
    const oldEvents = [audio().onended!, audio().onerror!, audio().onplaying!, audio().onwaiting!];
    oldEvents[0]();
    const snapshot = [...changes];
    oldEvents.forEach((event) => event());
    playback.reject(new Error('old decoder error'));
    await flushEvents();
    expect(changes).toEqual(snapshot);
    expect(played).toEqual(['/english.mp3', '/chinese.mp3']);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state()).toMatchObject({ phase: 'error', label: 'Chinese · 1 of 2' });
  });
});