import { Injectable, signal } from '@angular/core';

export type MicTestError = 'permission-denied' | 'no-device' | 'device-unplugged' | 'unavailable' | '';

export interface MicTestOptions {
  fftSize?: 1024 | 2048;
  onFrame?: (samples: Float32Array, rms: number, sampleRate: number) => void;
}

@Injectable({ providedIn: 'root' })
export class MicTestService {
  readonly running = signal(false);
  readonly error = signal<MicTestError>('');
  readonly level = signal(0);
  readonly peak = signal(0);
  readonly monitorEnabled = signal(false);
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private frame = 0;
  private startRequest = 0;
  private onFrame: MicTestOptions['onFrame'] = undefined;
  private samples = new Float32Array(0);

  async start(deviceId = '', options: MicTestOptions = {}): Promise<void> {
    this.stop();
    this.error.set('');
    const request = ++this.startRequest;
    this.onFrame = options.onFrame;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      this.error.set('unavailable');
      this.onFrame = undefined;
      return;
    }
    try {
      const audio: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (deviceId) audio.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      if (request !== this.startRequest) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const context = new AudioContext();
      this.context = context;
      await context.resume();
      if (request !== this.startRequest || this.context !== context) return;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      this.source = source;
      this.analyser = analyser;
      analyser.fftSize = options.fftSize ?? 1024;
      this.samples = new Float32Array(analyser.fftSize);
      source.connect(analyser);
      // Some engines only pull samples through nodes that reach the destination, so route the analyser to a muted sink.
      const sink = context.createGain();
      this.sink = sink;
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(context.destination);
      if (this.monitorEnabled()) source.connect(context.destination);
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', this.onTrackEnded, { once: true });
      });
      this.running.set(true);
      this.measure();
    } catch (error) {
      if (request !== this.startRequest) return;
      const name = (error as DOMException)?.name;
      this.error.set(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'permission-denied'
        : name === 'NotFoundError' || name === 'DevicesNotFoundError'
          ? 'no-device'
          : name === 'OverconstrainedError' && deviceId
            ? 'device-unplugged'
            : 'unavailable');
      this.release();
    }
  }

  setMonitor(enabled: boolean): void {
    this.monitorEnabled.set(enabled);
    if (!this.source || !this.context) return;
    try {
      this.source.disconnect();
      if (this.analyser) this.source.connect(this.analyser);
      if (enabled) this.source.connect(this.context.destination);
    } catch { /* The optional monitor output may not be supported by every webview. */ }
  }

  stop(): void {
    this.startRequest += 1;
    this.error.set('');
    this.release();
  }

  markUnplugged(): void {
    if (!this.running()) return;
    this.startRequest += 1;
    this.error.set('device-unplugged');
    this.release();
  }

  private readonly onTrackEnded = (): void => this.markUnplugged();

  private measure(): void {
    if (!this.analyser || !this.running()) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    let peak = 0;
    for (const sample of this.samples) {
      const absolute = Math.abs(sample);
      sum += sample * sample;
      peak = Math.max(peak, absolute);
    }
    const rms = Math.sqrt(sum / this.samples.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -90;
    this.level.set(Math.max(0, Math.min(1, (db + 60) / 60)));
    this.peak.set(Math.max(0, Math.min(1, peak)));
    this.onFrame?.(this.samples, rms, this.context?.sampleRate ?? 44100);
    this.frame = requestAnimationFrame(() => this.measure());
  }

  private release(): void {
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.sink?.disconnect();
    this.sink = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close();
    this.onFrame = undefined;
    this.running.set(false);
    this.level.set(0);
    this.peak.set(0);
  }
}
