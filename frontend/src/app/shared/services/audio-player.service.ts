import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export interface StemSources {
  vocals: string;
  instrumental: string;
}

@Injectable({ providedIn: 'root' })
export class AudioPlayerService {
  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly vocalsVolume = signal(1);
  readonly instrumentalVolume = signal(1);
  readonly trackEnded = new Subject<void>();

  private context: AudioContext | null = null;
  private vocalsAudio: HTMLAudioElement | null = null;
  private instrumentalAudio: HTMLAudioElement | null = null;
  private vocalsGain: GainNode | null = null;
  private instrumentalGain: GainNode | null = null;
  private vocalsSource: MediaElementAudioSourceNode | null = null;
  private instrumentalSource: MediaElementAudioSourceNode | null = null;

  async loadStems(sources: StemSources): Promise<void> {
    this.release();
    const context = this.getContext();
    const vocalsAudio = this.createAudio(sources.vocals);
    const instrumentalAudio = this.createAudio(sources.instrumental);

    this.vocalsAudio = vocalsAudio;
    this.instrumentalAudio = instrumentalAudio;
    this.vocalsGain = context.createGain();
    this.instrumentalGain = context.createGain();
    this.vocalsSource = context.createMediaElementSource(vocalsAudio);
    this.instrumentalSource = context.createMediaElementSource(instrumentalAudio);

    this.vocalsGain.gain.value = this.vocalsVolume();
    this.instrumentalGain.gain.value = this.instrumentalVolume();
    this.vocalsSource.connect(this.vocalsGain).connect(context.destination);
    this.instrumentalSource.connect(this.instrumentalGain).connect(context.destination);
    this.instrumentalAudio.addEventListener('ended', () => {
      this.isPlaying.set(false);
      this.trackEnded.next();
    }, { once: true });

    await Promise.all([
      this.waitForMetadata(vocalsAudio),
      this.waitForMetadata(instrumentalAudio)
    ]);
    this.duration.set(Math.max(vocalsAudio.duration, instrumentalAudio.duration));
    this.currentTime.set(0);
    this.attachTimeUpdates();
  }

  async play(): Promise<void> {
    if (!this.vocalsAudio || !this.instrumentalAudio) {
      return;
    }
    await this.getContext().resume();
    await Promise.all([this.vocalsAudio.play(), this.instrumentalAudio.play()]);
    this.isPlaying.set(true);
  }

  pause(): void {
    this.vocalsAudio?.pause();
    this.instrumentalAudio?.pause();
    this.isPlaying.set(false);
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(seconds, this.duration()));
    if (this.vocalsAudio) {
      this.vocalsAudio.currentTime = target;
    }
    if (this.instrumentalAudio) {
      this.instrumentalAudio.currentTime = target;
    }
    this.currentTime.set(target);
  }

  setVocalsVolume(volume: number): void {
    const value = this.clampVolume(volume);
    this.vocalsVolume.set(value);
    if (this.vocalsGain) {
      this.vocalsGain.gain.value = value;
    }
  }

  setInstrumentalVolume(volume: number): void {
    const value = this.clampVolume(volume);
    this.instrumentalVolume.set(value);
    if (this.instrumentalGain) {
      this.instrumentalGain.gain.value = value;
    }
  }

  release(): void {
    this.pause();
    this.vocalsAudio?.remove();
    this.instrumentalAudio?.remove();
    this.vocalsAudio = null;
    this.instrumentalAudio = null;
    this.vocalsSource = null;
    this.instrumentalSource = null;
    this.vocalsGain = null;
    this.instrumentalGain = null;
    this.currentTime.set(0);
    this.duration.set(0);
  }

  private getContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }

  private createAudio(source: string): HTMLAudioElement {
    const audio = new Audio(source);
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    return audio;
  }

  private waitForMetadata(audio: HTMLAudioElement): Promise<void> {
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
      audio.addEventListener('error', () => reject(audio.error), { once: true });
    });
  }

  private attachTimeUpdates(): void {
    const update = (): void => {
      const vocalsTime = this.vocalsAudio?.currentTime ?? 0;
      const instrumentalTime = this.instrumentalAudio?.currentTime ?? 0;
      this.currentTime.set((vocalsTime + instrumentalTime) / 2);
    };
    this.vocalsAudio?.addEventListener('timeupdate', update);
    this.instrumentalAudio?.addEventListener('timeupdate', update);
  }

  private clampVolume(volume: number): number {
    return Math.max(0, Math.min(1, volume));
  }
}
