export type Phase = 'idle' | 'playing' | 'awaiting-record' | 'requesting' | 'recording' | 'blocked' | 'error' | 'review';
export interface PracticeState { phase: Phase; label: string; message?: string }
export const initialPracticeState: PracticeState = { phase: 'idle', label: 'Ready' };

export function recordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find((type) => MediaRecorder.isTypeSupported(type));
}

/** Event-driven media lifecycle. Every cancellation invalidates late async work. */
export class PracticeSession {
  private audio: HTMLAudioElement | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingUrl: string | null = null;
  private recordTimer: ReturnType<typeof setTimeout> | undefined;
  private mediaTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private clip = 0;
  private disposed = false;
  private retryAction: (() => void) | null = null;
  private state: PracticeState = initialPracticeState;

  constructor(private onChange: (state: PracticeState) => void) {}

  private update(state: PracticeState) {
    if (!this.disposed) { this.state = state; this.onChange(state); }
  }

  private clearAudio() {
    this.clip++;
    clearTimeout(this.mediaTimer);
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.onplaying = null;
      this.audio.onwaiting = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }

  private releaseMicrophone() {
    clearTimeout(this.recordTimer);
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') {
        try { this.recorder.stop(); } catch { /* Already interrupted by browser. */ }
      }
      this.recorder = null;
    }
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    this.stream = null;
  }

  private discardRecording() {
    if (this.recordingUrl) URL.revokeObjectURL(this.recordingUrl);
    this.recordingUrl = null;
  }

  cancel(message?: string) {
    this.generation++;
    this.retryAction = null;
    this.clearAudio();
    this.releaseMicrophone();
    this.discardRecording();
    this.update({ phase: 'idle', label: 'Ready', message });
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.audio = null;
  }

  interrupt() {
    if (['idle', 'review'].includes(this.state.phase)) return;
    this.cancel('Session interrupted. Restart when ready; unfinished recordings were discarded.');
  }

  start(english: string | null, chinese: string) {
    if (this.disposed) return;
    this.cancel();
    const record = () => this.update({ phase: 'awaiting-record', label: 'Ready to record' });
    const second = () => this.play(chinese, 'Chinese · 2 of 2', record);
    const first = () => this.play(chinese, 'Chinese · 1 of 2', second);
    if (english) this.play(english, 'English · 1 of 1', first);
    else first();
  }

  private play(src: string, label: string, next: () => void) {
    if (this.disposed) return;
    this.clearAudio();
    this.audio ??= new Audio();
    const audio = this.audio;
    const generation = this.generation;
    const clip = this.clip;
    let finished = false;
    const current = () => !this.disposed && generation === this.generation && clip === this.clip && !finished;
    const fail = (message: string, blocked = false) => {
      if (!current()) return;
      finished = true;
      clearTimeout(this.mediaTimer);
      audio.pause();
      this.retryAction = () => this.play(src, label, next);
      this.update({ phase: blocked ? 'blocked' : 'error', label, message });
    };
    const watchdog = () => {
      clearTimeout(this.mediaTimer);
      this.mediaTimer = setTimeout(() => fail('Audio did not load. Retry playback or skip this card.'), 30_000);
    };
    audio.src = src;
    audio.onended = () => {
      if (!current()) return;
      finished = true;
      clearTimeout(this.mediaTimer);
      this.retryAction = null;
      next();
    };
    audio.onerror = () => fail('Audio could not be played. The file may be unavailable or unsupported.');
    audio.onplaying = () => { if (current()) clearTimeout(this.mediaTimer); };
    audio.onwaiting = () => { if (current()) watchdog(); };
    this.update({ phase: 'playing', label });
    watchdog();
    try {
      void audio.play().catch((error: unknown) => {
        const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
        fail(blocked ? 'Your browser requires a tap to continue audio.' : 'Playback failed. Retry or skip this card.', blocked);
      });
    } catch {
      fail('Playback failed. Retry or skip this card.');
    }
  }

  retry() {
    const action = this.retryAction;
    this.retryAction = null;
    action?.();
  }

  async record() {
    if (this.disposed || ['requesting', 'recording'].includes(this.state.phase)) return;
    this.clearAudio();
    this.discardRecording();
    const generation = this.generation;
    this.update({ phase: 'requesting', label: 'Waiting for microphone permission' });
    const fail = (message: string) => {
      if (this.disposed || generation !== this.generation) return;
      this.releaseMicrophone();
      this.retryAction = () => { void this.record(); };
      this.update({ phase: 'error', label: 'Recording unavailable', message });
    };
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      fail('Recording needs a supported browser and a secure context (localhost on Mac or trusted HTTPS on iPhone).');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.disposed || generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = recordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      this.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => fail('The microphone recording failed. Check your input device and retry.');
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => fail('The microphone was disconnected or permission was revoked.');
      });
      recorder.onstop = () => {
        if (this.disposed || generation !== this.generation) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || '' });
        chunks.length = 0;
        this.releaseMicrophone();
        if (!blob.size) { fail('No audio was captured. Try recording again.'); return; }
        this.recordingUrl = URL.createObjectURL(blob);
        this.play(this.recordingUrl, 'Your recording', () => {
          this.clearAudio();
          this.discardRecording();
          this.update({ phase: 'review', label: 'Rate this card' });
        });
      };
      recorder.start();
      this.update({ phase: 'recording', label: 'Recording · maximum 60 seconds' });
      this.recordTimer = setTimeout(() => this.stopRecording(), 60_000);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      fail(name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow microphone access in your browser, then retry.'
        : name === 'NotFoundError' ? 'No microphone was found. Connect one and retry.' : 'Could not start recording. Check microphone access and retry.');
    }
  }

  stopRecording() {
    if (this.recorder?.state !== 'recording') return;
    clearTimeout(this.recordTimer);
    this.update({ phase: 'requesting', label: 'Preparing recorded playback' });
    try { this.recorder.stop(); }
    catch {
      this.cancel('Recording was interrupted. Please restart.');
    }
  }

  reviewWithoutRecording() {
    this.cancel();
    this.update({ phase: 'review', label: 'Rate this card', message: 'Recording skipped for this review.' });
  }
}