import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export interface ReplayGainInfo {
  trackGain?: string | null;
  trackPeak?: string | null;
  albumGain?: string | null;
  albumPeak?: string | null;
}

export interface StemSources {
  vocals: string;
  instrumental: string;
  replayGain?: ReplayGainInfo;
}

export type ReplayGainMode = 'track' | 'album';

const RG_ENABLED_KEY = 'kanta.replayGain.enabled';
const RG_MODE_KEY = 'kanta.replayGain.mode';

const storage = {
  get: (key: string): string | null => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // storage unavailable
    }
  },
};

const parseNumber = (value: string | null | undefined): number | null => {
  const parsed = value ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

// Gain in dB from the file tags -> linear factor, capped so the peak never exceeds full scale.
export const replayGainFactor = (
  info: ReplayGainInfo | undefined,
  mode: ReplayGainMode,
): number => {
  if (!info) return 1;
  const gain = parseNumber(mode === 'album' ? (info.albumGain ?? info.trackGain) : (info.trackGain ?? info.albumGain));
  if (gain === null) return 1;
  const peak = parseNumber(mode === 'album' ? (info.albumPeak ?? info.trackPeak) : (info.trackPeak ?? info.albumPeak));
  const factor = 10 ** (gain / 20);
  return peak && peak > 0 ? Math.min(factor, 1 / peak) : factor;
};

@Injectable({ providedIn: 'root' })
export class AudioPlayerService {
  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly vocalsVolume = signal(1);
  readonly instrumentalVolume = signal(1);
  readonly trackEnded = new Subject<void>();
  readonly trackNavigation = new Subject<'next' | 'previous'>();
  readonly replayGainEnabled = signal(storage.get(RG_ENABLED_KEY) !== 'false');
  readonly replayGainMode = signal<ReplayGainMode>(
    storage.get(RG_MODE_KEY) === 'album' ? 'album' : 'track',
  );
  private masterGain: GainNode | null = null;
  private replayGain: ReplayGainInfo | undefined;

  private context: AudioContext | null = null;
  private vocalsAudio: HTMLAudioElement | null = null;
  private instrumentalAudio: HTMLAudioElement | null = null;
  private vocalsGain: GainNode | null = null;
  private instrumentalGain: GainNode | null = null;
  private vocalsSource: MediaElementAudioSourceNode | null = null;
  private instrumentalSource: MediaElementAudioSourceNode | null = null;
  private outputDeviceId = '';
  private wakeLock: WakeLockSentinel | null = null;
  private wakeLockPending = false;

  constructor() {
    if (typeof navigator === 'undefined') return;
    if ('mediaSession' in navigator) {
      const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
        ['play', () => {
          void this.play().catch((error) => console.error('Media playback failed:', error));
        }],
        ['pause', () => this.pause()],
        ['nexttrack', () => this.trackNavigation.next('next')],
        ['previoustrack', () => this.trackNavigation.next('previous')],
      ];
      for (const [action, handler] of actions) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch (error) {
          console.warn(`Media control ${action} is unavailable:`, error);
        }
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.isPlaying()) void this.acquireWakeLock();
      });
    }
  }

  get hasStems(): boolean {
    return !!this.vocalsAudio && !!this.instrumentalAudio;
  }

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
    this.masterGain = context.createGain();
    this.replayGain = sources.replayGain;
    this.applyReplayGain();
    this.masterGain.connect(context.destination);
    this.vocalsSource.connect(this.vocalsGain).connect(this.masterGain);
    this.instrumentalSource.connect(this.instrumentalGain).connect(this.masterGain);
    this.instrumentalAudio.addEventListener('ended', () => {
      this.pause();
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    void this.acquireWakeLock();
  }

  pause(): void {
    this.vocalsAudio?.pause();
    this.instrumentalAudio?.pause();
    this.isPlaying.set(false);
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock) void lock.release().catch((error) => console.warn('Could not release screen wake lock:', error));
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator) || this.wakeLock || this.wakeLockPending) return;
    this.wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!this.isPlaying()) {
        await lock.release();
        return;
      }
      this.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch (error) {
      console.warn('Could not keep the screen awake:', error);
    } finally {
      this.wakeLockPending = false;
    }
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

  setReplayGainEnabled(enabled: boolean): void {
    this.replayGainEnabled.set(enabled);
    storage.set(RG_ENABLED_KEY, String(enabled));
    this.applyReplayGain();
  }

  setReplayGainMode(mode: ReplayGainMode): void {
    this.replayGainMode.set(mode);
    storage.set(RG_MODE_KEY, mode);
    this.applyReplayGain();
  }

  private applyReplayGain(): void {
    if (!this.masterGain) return;
    const factor = this.replayGainEnabled() ? replayGainFactor(this.replayGain, this.replayGainMode()) : 1;
    this.masterGain.gain.value = factor;
  }

  setOutputDevice(id: string): void {
    this.outputDeviceId = id;
    this.applyOutputDevice();
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
    this.masterGain = null;
    this.replayGain = undefined;
    this.currentTime.set(0);
    this.duration.set(0);
  }

  private getContext(): AudioContext {
    this.context ??= new AudioContext();
    const context = this.context as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };
    if (this.outputDeviceId && context.setSinkId) void context.setSinkId(this.outputDeviceId).catch(() => undefined);
    return this.context;
  }

  private createAudio(source: string): HTMLAudioElement {
    const audio = new Audio(source);
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    const mediaElement = audio as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
    if (this.outputDeviceId && mediaElement.setSinkId) void mediaElement.setSinkId(this.outputDeviceId).catch(() => undefined);
    return audio;
  }

  private applyOutputDevice(): void {
    for (const audio of [this.vocalsAudio, this.instrumentalAudio]) {
      const mediaElement = audio as (HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> }) | null;
      if (mediaElement?.setSinkId) void mediaElement.setSinkId(this.outputDeviceId).catch(() => undefined);
    }
    const context = this.context as (AudioContext & { setSinkId?: (deviceId: string) => Promise<void> }) | null;
    if (context?.setSinkId) void context.setSinkId(this.outputDeviceId).catch(() => undefined);
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
