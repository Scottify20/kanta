import { computed, Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import SignalsmithStretch from 'signalsmith-stretch';
import type { SignalsmithStretchNode, StretchSchedule } from 'signalsmith-stretch';

export interface ReplayGainInfo {
  trackGain?: string | number | null;
  trackPeak?: string | number | null;
  albumGain?: string | number | null;
  albumPeak?: string | number | null;
}

export interface StemSources {
  vocals: string;
  instrumental: string;
  master?: string | null;
  replayGain?: ReplayGainInfo;
}

export interface PlaybackIssue {
  kind: 'error' | 'info';
  message: string;
}

export type ReplayGainMode = 'track' | 'album';

const RG_ENABLED_KEY = 'kanta.replayGain.enabled';
const RG_MODE_KEY = 'kanta.replayGain.mode';
const VOLUME_BOOST_KEY = 'kanta.volumeBoostDb';
const CROSSFADE_SECONDS = 0.03;
export const MAX_VOLUME_BOOST_DB = 6;

export function clampSemitoneShift(value: number): number {
  return Number.isFinite(value) ? Math.max(-6, Math.min(6, value)) : 0;
}

export function clampVolumeBoostDb(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_VOLUME_BOOST_DB, value)) : 0;
}

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

const parseNumber = (value: string | number | null | undefined): number | null => {
  const parsed = value != null ? Number.parseFloat(String(value)) : Number.NaN;
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
  readonly playbackStarted = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly vocalsVolume = signal(1);
  readonly instrumentalVolume = signal(1);
  private readonly _semitoneShift = signal(0);
  readonly semitoneShift = this._semitoneShift.asReadonly();
  private readonly _isKeyShiftEnabled = signal(true);
  readonly isKeyShiftEnabled = this._isKeyShiftEnabled.asReadonly();
  readonly effectiveSemitones = computed(() =>
    this.isKeyShiftEnabled() ? this.semitoneShift() : 0,
  );
  readonly trackEnded = new Subject<void>();
  readonly trackNavigation = new Subject<'next' | 'previous'>();
  readonly playbackIssues = new Subject<PlaybackIssue>();
  readonly replayGainEnabled = signal(storage.get(RG_ENABLED_KEY) !== 'false');
  readonly replayGainMode = signal<ReplayGainMode>(
    storage.get(RG_MODE_KEY) === 'album' ? 'album' : 'track',
  );
  readonly volumeBoostDb = signal(clampVolumeBoostDb(Number(storage.get(VOLUME_BOOST_KEY) ?? 0)));
  private masterGain: GainNode | null = null;
  private peakLimiter: DynamicsCompressorNode | null = null;
  private replayGain: ReplayGainInfo | undefined;

  private context: AudioContext | null = null;
  private vocalsAudio: HTMLAudioElement | null = null;
  private instrumentalAudio: HTMLAudioElement | null = null;
  private masterAudio: HTMLAudioElement | null = null;
  private vocalsGain: GainNode | null = null;
  private instrumentalGain: GainNode | null = null;
  private stemsMixGain: GainNode | null = null;
  private masterBypassGain: GainNode | null = null;
  private vocalsSource: MediaElementAudioSourceNode | null = null;
  private instrumentalSource: MediaElementAudioSourceNode | null = null;
  private masterSource: MediaElementAudioSourceNode | null = null;
  private vocalsStretch: SignalsmithStretchNode | null = null;
  private instrumentalStretch: SignalsmithStretchNode | null = null;
  private loadedMasterSource: string | null = null;
  private usingMasterBypass = false;
  private pitchShiftRequest = 0;
  private loadRequest = 0;
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

  hasLoadedSources(sources: Pick<StemSources, 'vocals' | 'instrumental' | 'master'>): boolean {
    return this.vocalsAudio?.getAttribute('src') === this.resolveAudioSource(sources.vocals)
      && this.instrumentalAudio?.getAttribute('src') === this.resolveAudioSource(sources.instrumental)
      && (this.loadedMasterSource ?? this.masterAudio?.getAttribute('src') ?? null)
        === (sources.master ? this.resolveAudioSource(sources.master) : null);
  }

  async loadStems(sources: StemSources): Promise<void> {
    this.release();
    const request = this.loadRequest;
    const context = this.getContext();
    const vocalsAudio = this.createAudio(sources.vocals);
    const instrumentalAudio = this.createAudio(sources.instrumental);
    this.vocalsAudio = vocalsAudio;
    this.instrumentalAudio = instrumentalAudio;
    this.masterAudio = sources.master ? this.createAudio(sources.master) : null;
    this.loadedMasterSource = sources.master ? this.resolveAudioSource(sources.master) : null;

    try {
      let vocalsStretch: SignalsmithStretchNode | null = null;
      let instrumentalStretch: SignalsmithStretchNode | null = null;
      try {
        vocalsStretch = await SignalsmithStretch(context);
        instrumentalStretch = await SignalsmithStretch(context);
      } catch (error) {
        this.stopStretch(vocalsStretch);
        this.stopStretch(instrumentalStretch);
        vocalsStretch = null;
        instrumentalStretch = null;
        this.reportPitchShiftFailure(error);
      }
      if (request !== this.loadRequest) {
        this.stopStretch(vocalsStretch);
        this.stopStretch(instrumentalStretch);
        return;
      }
      this.vocalsStretch = vocalsStretch;
      this.instrumentalStretch = instrumentalStretch;
      this.watchStretchProcessor(vocalsStretch);
      this.watchStretchProcessor(instrumentalStretch);
      this.vocalsSource = context.createMediaElementSource(vocalsAudio);
      this.instrumentalSource = context.createMediaElementSource(instrumentalAudio);
      this.masterSource = this.masterAudio
        ? context.createMediaElementSource(this.masterAudio)
        : null;

      this.vocalsGain = context.createGain();
      this.instrumentalGain = context.createGain();
      this.stemsMixGain = context.createGain();
      this.masterBypassGain = context.createGain();
      this.masterGain = context.createGain();
      this.peakLimiter = context.createDynamicsCompressor();
      this.peakLimiter.threshold.value = -1;
      this.peakLimiter.knee.value = 0;
      this.peakLimiter.ratio.value = 20;
      this.peakLimiter.attack.value = 0.003;
      this.peakLimiter.release.value = 0.15;
      this.vocalsGain.gain.value = this.vocalsVolume();
      this.instrumentalGain.gain.value = this.instrumentalVolume();
      this.replayGain = sources.replayGain;
      this.applyReplayGain();

      await Promise.all([
        this.waitForMetadata(vocalsAudio),
        this.waitForMetadata(instrumentalAudio),
      ]);
      if (request !== this.loadRequest) return;
      if (this.masterAudio) {
        try {
          await this.waitForMetadata(this.masterAudio);
        } catch (error) {
          console.warn('Master audio is unavailable; using separated stems:', error);
          this.masterSource?.disconnect();
          this.disposeAudio(this.masterAudio);
          this.masterSource = null;
          this.masterAudio = null;
        }
      }

      this.usingMasterBypass = this.shouldUseMasterBypass();
      this.stemsMixGain.gain.value = this.usingMasterBypass ? 0 : 1;
      this.masterBypassGain.gain.value = this.usingMasterBypass ? 1 : 0;
      this.masterGain.connect(this.peakLimiter).connect(context.destination);
      const vocalsOutput = vocalsStretch
        ? this.vocalsSource.connect(vocalsStretch)
        : this.vocalsSource;
      const instrumentalOutput = instrumentalStretch
        ? this.instrumentalSource.connect(instrumentalStretch)
        : this.instrumentalSource;
      vocalsOutput.connect(this.vocalsGain).connect(this.stemsMixGain).connect(this.masterGain);
      instrumentalOutput.connect(this.instrumentalGain).connect(this.stemsMixGain).connect(this.masterGain);
      this.masterSource?.connect(this.masterBypassGain).connect(this.masterGain);

      this.instrumentalAudio.addEventListener('ended', () => {
        if (this.usingMasterBypass) return;
        this.pause();
        this.trackEnded.next();
      });
      this.masterAudio?.addEventListener('ended', () => {
        if (!this.usingMasterBypass) return;
        this.pause();
        this.trackEnded.next();
      });

      await this.schedulePitchShift();
      this.duration.set(Math.max(
        vocalsAudio.duration,
        instrumentalAudio.duration,
        this.masterAudio?.duration ?? 0,
      ));
      this.currentTime.set(0);
      this.attachTimeUpdates();
    } catch (error) {
      if (request !== this.loadRequest) return;
      this.release();
      console.error('Could not load playback audio:', error);
      this.playbackIssues.next({
        kind: 'error',
        message: 'Playback could not load this song. Check the audio files and try again.',
      });
      throw error;
    }
  }

  async play(): Promise<void> {
    const vocals = this.vocalsAudio;
    const instrumental = this.instrumentalAudio;
    if (!vocals || !instrumental) {
      return;
    }
    const master = this.masterAudio;
    let contextResumed = false;
    try {
      await this.resumeAudioContext();
      contextResumed = true;
      if (
        this.vocalsAudio !== vocals
        || this.instrumentalAudio !== instrumental
        || this.masterAudio !== master
      ) return;
      await Promise.all([vocals.play(), instrumental.play(), ...(master ? [master.play()] : [])]);
      if (
        this.vocalsAudio !== vocals
        || this.instrumentalAudio !== instrumental
        || this.masterAudio !== master
      ) return;
      this.playbackStarted.set(true);
      this.isPlaying.set(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      void this.acquireWakeLock();
    } catch (error) {
      if (contextResumed) {
        console.error('Audio playback failed:', error);
        this.playbackIssues.next({
          kind: 'error',
          message: 'Playback could not start. Check the audio output and try again.',
        });
      }
      throw error;
    }
  }

  async resumeAudioContext(): Promise<void> {
    try {
      await this.getContext().resume();
    } catch (error) {
      console.error('Could not resume the audio context:', error);
      this.playbackIssues.next({
        kind: 'error',
        message: 'Audio could not start. Check your browser audio permissions and try again.',
      });
      throw error;
    }
  }

  pause(): void {
    this.vocalsAudio?.pause();
    this.instrumentalAudio?.pause();
    this.masterAudio?.pause();
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
    if (this.masterAudio) {
      this.masterAudio.currentTime = target;
    }
    this.currentTime.set(target);
  }

  setVocalsVolume(volume: number): void {
    const value = this.clampVolume(volume);
    this.vocalsVolume.set(value);
    if (this.vocalsGain) {
      this.vocalsGain.gain.value = value;
    }
    this.updateMasterBypass();
  }

  setInstrumentalVolume(volume: number): void {
    const value = this.clampVolume(volume);
    this.instrumentalVolume.set(value);
    if (this.instrumentalGain) {
      this.instrumentalGain.gain.value = value;
    }
    this.updateMasterBypass();
  }

  setSemitoneShift(value: number): Promise<void> {
    this._semitoneShift.set(clampSemitoneShift(value));
    this.updateMasterBypass();
    return this.schedulePitchShift();
  }

  setKeyShiftEnabled(enabled: boolean): Promise<void> {
    this._isKeyShiftEnabled.set(enabled);
    this.updateMasterBypass();
    return this.schedulePitchShift();
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

  setVolumeBoostDb(value: number): void {
    const boost = clampVolumeBoostDb(value);
    this.volumeBoostDb.set(boost);
    storage.set(VOLUME_BOOST_KEY, String(boost));
    this.applyReplayGain();
  }

  private applyReplayGain(): void {
    if (!this.masterGain) return;
    const factor = this.replayGainEnabled() ? replayGainFactor(this.replayGain, this.replayGainMode()) : 1;
    this.masterGain.gain.value = factor * 10 ** (this.volumeBoostDb() / 20);
  }

  setOutputDevice(id: string): void {
    this.outputDeviceId = id;
    this.applyOutputDevice();
  }

  release(): void {
    this.pause();
    this.playbackStarted.set(false);
    this.stopStretch(this.vocalsStretch);
    this.stopStretch(this.instrumentalStretch);
    this.vocalsSource?.disconnect();
    this.instrumentalSource?.disconnect();
    this.masterSource?.disconnect();
    this.vocalsGain?.disconnect();
    this.instrumentalGain?.disconnect();
    this.stemsMixGain?.disconnect();
    this.masterBypassGain?.disconnect();
    this.masterGain?.disconnect();
    this.peakLimiter?.disconnect();
    this.disposeAudio(this.vocalsAudio);
    this.disposeAudio(this.instrumentalAudio);
    this.disposeAudio(this.masterAudio);
    this.vocalsAudio = null;
    this.instrumentalAudio = null;
    this.masterAudio = null;
    this.vocalsSource = null;
    this.instrumentalSource = null;
    this.masterSource = null;
    this.vocalsStretch = null;
    this.instrumentalStretch = null;
    this.vocalsGain = null;
    this.instrumentalGain = null;
    this.stemsMixGain = null;
    this.masterBypassGain = null;
    this.masterGain = null;
    this.peakLimiter = null;
    this.replayGain = undefined;
    this.usingMasterBypass = false;
    this.loadedMasterSource = null;
    this.pitchShiftRequest += 1;
    this.loadRequest += 1;
    this._semitoneShift.set(0);
    this._isKeyShiftEnabled.set(true);
    this.currentTime.set(0);
    this.duration.set(0);
  }

  private disposeAudio(audio: HTMLAudioElement | null): void {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio.remove();
  }

  private stopStretch(stretch: SignalsmithStretchNode | null): void {
    if (!stretch) return;
    void stretch.stop().catch((error: unknown) => {
      console.warn('Could not stop the pitch-shift worklet:', error);
    }).finally(() => {
      stretch.disconnect();
      stretch.port.close();
    });
  }

  private getContext(): AudioContext {
    this.context ??= new AudioContext();
    const context = this.context as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };
    if (this.outputDeviceId && context.setSinkId) void context.setSinkId(this.outputDeviceId).catch(() => undefined);
    return this.context;
  }

  private createAudio(source: string): HTMLAudioElement {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    audio.src = this.resolveAudioSource(source);
    const mediaElement = audio as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
    if (this.outputDeviceId && mediaElement.setSinkId) void mediaElement.setSinkId(this.outputDeviceId).catch(() => undefined);
    return audio;
  }

  private applyOutputDevice(): void {
    for (const audio of [this.vocalsAudio, this.instrumentalAudio, this.masterAudio]) {
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
      const vocals = this.vocalsAudio;
      const instrumental = this.instrumentalAudio;
      const master = this.masterAudio;
      if (this.usingMasterBypass && master) {
        this.currentTime.set(master.currentTime);
        if (this.isPlaying() && instrumental && Math.abs(instrumental.currentTime - master.currentTime) > 0.12) {
          instrumental.currentTime = master.currentTime;
        }
        if (this.isPlaying() && vocals && Math.abs(vocals.currentTime - master.currentTime) > 0.12) {
          vocals.currentTime = master.currentTime;
        }
      } else {
        const vocalsTime = vocals?.currentTime ?? 0;
        const instrumentalTime = instrumental?.currentTime ?? 0;
        if (this.isPlaying() && vocals && instrumental && Math.abs(vocalsTime - instrumentalTime) > 0.08) {
          vocals.currentTime = instrumentalTime;
        }
        if (this.isPlaying() && master && instrumental && Math.abs(master.currentTime - instrumentalTime) > 0.12) {
          master.currentTime = instrumentalTime;
        }
        this.currentTime.set(instrumental ? instrumental.currentTime : (vocalsTime + instrumentalTime) / 2);
      }
    };
    this.vocalsAudio?.addEventListener('timeupdate', update);
    this.instrumentalAudio?.addEventListener('timeupdate', update);
    this.masterAudio?.addEventListener('timeupdate', update);
  }

  private shouldUseMasterBypass(): boolean {
    return !!this.masterAudio
      && this.effectiveSemitones() === 0
      && this.vocalsVolume() === 1
      && this.instrumentalVolume() === 1;
  }

  private updateMasterBypass(): void {
    if (!this.stemsMixGain || !this.masterBypassGain) return;
    const shouldBypass = this.shouldUseMasterBypass();
    if (shouldBypass === this.usingMasterBypass) return;

    this.usingMasterBypass = shouldBypass;
    const now = this.context?.currentTime ?? 0;
    this.rampGain(this.stemsMixGain.gain, shouldBypass ? 0 : 1, now);
    this.rampGain(this.masterBypassGain.gain, shouldBypass ? 1 : 0, now);
  }

  private rampGain(param: AudioParam, value: number, now: number): void {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
    }
    param.linearRampToValueAtTime(value, now + CROSSFADE_SECONDS);
  }

  private async schedulePitchShift(): Promise<void> {
    const request = ++this.pitchShiftRequest;
    const vocals = this.vocalsStretch;
    const instrumental = this.instrumentalStretch;
    const context = this.context;
    if (!vocals || !instrumental || !context) return;

    try {
      const [vocalLatency, instrumentalLatency] = await Promise.all([
        vocals.latency(),
        instrumental.latency(),
      ]);
      if (
        request !== this.pitchShiftRequest
        || this.vocalsStretch !== vocals
        || this.instrumentalStretch !== instrumental
      ) return;

      const schedule: StretchSchedule = {
        active: true,
        output: context.currentTime + Math.max(vocalLatency, instrumentalLatency),
        semitones: this.effectiveSemitones(),
        formantBaseHz: 0,
      };
      await Promise.all([
        vocals.schedule({ ...schedule, formantCompensation: true }),
        instrumental.schedule({ ...schedule, formantCompensation: false }),
      ]);
    } catch (error) {
      if (
        request === this.pitchShiftRequest
        && this.vocalsStretch === vocals
        && this.instrumentalStretch === instrumental
      ) {
        this.fallbackToDirectStemPlayback(error);
      }
    }
  }

  private fallbackToDirectStemPlayback(error: unknown): void {
    const vocalsAudio = this.vocalsAudio;
    const instrumentalAudio = this.instrumentalAudio;
    if (!vocalsAudio || !instrumentalAudio || !this.vocalsSource || !this.instrumentalSource
      || !this.vocalsStretch || !this.instrumentalStretch
      || !this.vocalsGain || !this.instrumentalGain || !this.stemsMixGain || !this.masterGain) {
      return;
    }
    this.reportPitchShiftFailure(error);
    this.stopStretch(this.vocalsStretch);
    this.stopStretch(this.instrumentalStretch);
    this.vocalsStretch = null;
    this.instrumentalStretch = null;
    this.vocalsSource.disconnect();
    this.instrumentalSource.disconnect();
    this.vocalsSource.connect(this.vocalsGain).connect(this.stemsMixGain).connect(this.masterGain);
    this.instrumentalSource.connect(this.instrumentalGain).connect(this.stemsMixGain).connect(this.masterGain);
    this.updateMasterBypass();
  }

  private watchStretchProcessor(stretch: SignalsmithStretchNode | null): void {
    stretch?.addEventListener('processorerror', (error) => {
      if (this.vocalsStretch === stretch || this.instrumentalStretch === stretch) {
        this.fallbackToDirectStemPlayback(error);
      }
    }, { once: true });
  }

  private reportPitchShiftFailure(error: unknown): void {
    console.error('Signalsmith pitch-shift failed; falling back to direct stem playback:', error);
    this.playbackIssues.next({
      kind: 'info',
      message: 'Key adjustment is unavailable for this song; playback will continue without it.',
    });
  }

  private resolveAudioSource(source: string): string {
    const isAppUrl = /^(?:https?:|blob:|data:)/i.test(source)
      || /^\/(?:api|media-roots)(?:\/|$)/i.test(source);
    if (isAppUrl || !isTauri()) return source;

    let localPath = source;
    if (/^file:/i.test(localPath)) {
      localPath = decodeURIComponent(new URL(localPath).pathname);
      if (/^\/[a-z]:\//i.test(localPath)) localPath = localPath.slice(1);
    }
    const isAbsolutePath = /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(localPath);
    return isAbsolutePath ? convertFileSrc(localPath) : source;
  }

  private clampVolume(volume: number): number {
    return Math.max(0, Math.min(1, volume));
  }
}