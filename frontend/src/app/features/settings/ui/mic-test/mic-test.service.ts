import { Injectable, signal } from '@angular/core';

export type MicTestError = 'permission-denied' | 'no-device' | 'device-unplugged' | 'unavailable' | '';

@Injectable({ providedIn: 'root' })
export class MicTestService {
  readonly running = signal(false);
  readonly error = signal<MicTestError>('');
  readonly level = signal(0);
  readonly peak = signal(0);
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private frame = 0;
  private monitor = false;
  private samples = new Float32Array(0);

  async start(deviceId = ''): Promise<void> {
    this.stop();
    this.error.set('');
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      this.error.set('unavailable');
      return;
    }
    try {
      const audio: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : {};
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      this.context = new AudioContext();
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      if (this.monitor) this.source.connect(this.context.destination);
      this.stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', this.onTrackEnded, { once: true });
      });
      this.running.set(true);
      this.measure();
    } catch (error) {
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
    this.monitor = enabled;
    if (!this.source || !this.context) return;
    try {
      this.source.disconnect();
      if (this.analyser) this.source.connect(this.analyser);
      if (enabled) this.source.connect(this.context.destination);
    } catch { /* The optional monitor output may not be supported by every webview. */ }
  }

  stop(): void {
    this.error.set('');
    this.release();
  }

  markUnplugged(): void {
    if (!this.running()) return;
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
    this.level.set(Math.max(0, Math.min(1, rms * 3.2)));
    this.peak.set(Math.max(0, Math.min(1, peak)));
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
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close();
    this.running.set(false);
    this.level.set(0);
    this.peak.set(0);
  }
}
