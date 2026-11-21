import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('signalsmith-stretch', () => ({ default: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path) => `asset://${path}`),
  isTauri: vi.fn(() => false),
}));

import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import SignalsmithStretch from 'signalsmith-stretch';
import { AudioPlayerService, clampSemitoneShift } from '../src/app/shared/services/audio-player.service.ts';

class FakeAudioNode {
  connections = [];
  disconnect = vi.fn();
  listeners = new Map();

  connect(node) {
    this.connections.push(node);
    return node;
  }

  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

class FakeAudioParam {
  constructor(value = 1) {
    this.value = value;
    this.cancelScheduledValues = vi.fn();
    this.cancelAndHoldAtTime = vi.fn();
    this.setValueAtTime = vi.fn();
    this.linearRampToValueAtTime = vi.fn();
  }
}

class FakeAudio {
  constructor(src) {
    this.src = src;
    this.preload = '';
    this.crossOrigin = '';
    this.readyState = 1;
    this.duration = 100;
    this.currentTime = 0;
    this.error = null;
    this.listeners = new Map();
    this.play = vi.fn().mockResolvedValue(undefined);
    this.pause = vi.fn();
    this.remove = vi.fn();
    this.setSinkId = vi.fn().mockResolvedValue(undefined);
  }

  getAttribute(name) {
    return name === 'src' ? this.src : null;
  }

  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

const makeStretchNode = () => {
  const node = new FakeAudioNode();
  node.port = { close: vi.fn() };
  node.latency = vi.fn().mockResolvedValue(0.025);
  node.schedule = vi.fn().mockResolvedValue(undefined);
  node.stop = vi.fn().mockResolvedValue(undefined);
  return node;
};

const createAudioContext = () => {
  const gains = [];
  const sources = [];
  const context = {
    currentTime: 20,
    destination: new FakeAudioNode(),
    resume: vi.fn().mockResolvedValue(undefined),
    setSinkId: vi.fn().mockResolvedValue(undefined),
    createMediaElementSource: vi.fn(() => {
      const source = new FakeAudioNode();
      sources.push(source);
      return source;
    }),
    createGain: vi.fn(() => {
      const gain = new FakeAudioNode();
      gain.gain = new FakeAudioParam();
      gains.push(gain);
      return gain;
    }),
    createDynamicsCompressor: vi.fn(() => {
      const limiter = new FakeAudioNode();
      limiter.threshold = new FakeAudioParam(-24);
      limiter.knee = new FakeAudioParam(30);
      limiter.ratio = new FakeAudioParam(12);
      limiter.attack = new FakeAudioParam(0.003);
      limiter.release = new FakeAudioParam(0.25);
      return limiter;
    }),
  };
  return { context, gains, sources };
};

describe('audio player pitch shifting', () => {
  let audio;
  let context;
  let gains;
  let sources;
  let worklets;
  let audioElements;

  beforeEach(() => {
    worklets = [];
    audioElements = [];
    isTauri.mockReturnValue(false);
    convertFileSrc.mockClear();
    ({ context, gains, sources } = createAudioContext());
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    vi.stubGlobal('Audio', class extends FakeAudio {
      constructor(src) {
        super(src);
        audioElements.push(this);
      }
    });
    vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1 });
    vi.stubGlobal('navigator', {});
    SignalsmithStretch.mockImplementation(async () => {
      const node = makeStretchNode();
      worklets.push(node);
      return node;
    });
    audio = new AudioPlayerService();
  });

  afterEach(() => {
    audio?.release();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clamps semitone shifts to the supported range', () => {
    expect(clampSemitoneShift(-9)).toBe(-6);
    expect(clampSemitoneShift(3.5)).toBe(3.5);
    expect(clampSemitoneShift(9)).toBe(6);
    expect(clampSemitoneShift(Number.NaN)).toBe(0);
  });

  it('schedules both stems together, preserves the dialed shift when disabled, and crossfades the master bypass', async () => {
    await audio.loadStems({
      vocals: '/vocals.ogg',
      instrumental: '/instrumental.ogg',
      master: '/master.ogg',
    });

    expect(audio.isKeyShiftEnabled()).toBe(true);
    expect(audio.effectiveSemitones()).toBe(0);
    expect(audio.usingMasterBypass).toBe(true);
    expect(audio.hasLoadedSources({
      vocals: '/vocals.ogg',
      instrumental: '/instrumental.ogg',
      master: '/master.ogg',
    })).toBe(true);
    expect(audio.hasLoadedSources({
      vocals: '/vocals.ogg',
      instrumental: '/instrumental.ogg',
    })).toBe(false);
    expect(gains[2].gain.value).toBe(0);
    expect(gains[3].gain.value).toBe(1);

    await audio.setSemitoneShift(3);
    expect(audio.effectiveSemitones()).toBe(3);
    expect(audio.usingMasterBypass).toBe(false);
    expect(gains[2].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 20.03);
    expect(gains[3].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 20.03);

    const [vocalSchedule, instrumentalSchedule] = worklets.map((node) =>
      node.schedule.mock.lastCall[0],
    );
    expect(vocalSchedule.semitones).toBe(3);
    expect(instrumentalSchedule.semitones).toBe(3);
    expect(vocalSchedule.output).toBe(instrumentalSchedule.output);
    expect(vocalSchedule.formantCompensation).toBe(true);
    expect(instrumentalSchedule.formantCompensation).toBe(false);

    await audio.setKeyShiftEnabled(false);
    expect(audio.semitoneShift()).toBe(3);
    expect(audio.effectiveSemitones()).toBe(0);
    expect(audio.usingMasterBypass).toBe(true);
    expect(worklets[0].schedule.mock.lastCall[0].semitones).toBe(0);
    expect(worklets[1].schedule.mock.lastCall[0].semitones).toBe(0);

    audio.seek(24);
    expect(audioElements.map((element) => element.currentTime)).toEqual([24, 24, 24]);
    audioElements[2].currentTime = 27;
    audioElements[2].dispatch('timeupdate');
    expect(audio.currentTime()).toBe(27);

    audio.setVocalsVolume(0.5);
    expect(audio.usingMasterBypass).toBe(false);
    audioElements[0].currentTime = 40;
    audioElements[1].currentTime = 42;
    audioElements[2].dispatch('timeupdate');
    expect(audio.currentTime()).toBe(41);

    await audio.setKeyShiftEnabled(true);
    expect(audio.semitoneShift()).toBe(3);
    expect(audio.effectiveSemitones()).toBe(3);
  });

  it('uses the stem route without a master and releases worklets and per-track shift state', async () => {
    await audio.loadStems({ vocals: '/vocals.ogg', instrumental: '/instrumental.ogg' });
    expect(audio.usingMasterBypass).toBe(false);
    expect(gains[2].gain.value).toBe(1);
    expect(gains[3].gain.value).toBe(0);

    await audio.setSemitoneShift(-2);
    await audio.setKeyShiftEnabled(false);
    audio.setOutputDevice('device-1');
    expect(audioElements).toHaveLength(2);
    expect(audioElements.every((element) => element.setSinkId.mock.calls.length > 0)).toBe(true);
    expect(context.setSinkId).toHaveBeenCalledWith('device-1');

    const activeWorklets = [...worklets];
    audio.release();
    await Promise.all(activeWorklets.map((node) => node.stop.mock.results[0].value));
    await Promise.resolve();

    expect(audio.semitoneShift()).toBe(0);
    expect(audio.isKeyShiftEnabled()).toBe(true);
    expect(audio.effectiveSemitones()).toBe(0);
    expect(activeWorklets.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(activeWorklets.every((node) => node.port.close.mock.calls.length === 1)).toBe(true);
    expect(audio.hasStems).toBe(false);
  });

  it('falls back to direct stems when a worklet cannot initialize', async () => {
    const failure = new Error('worklet module unavailable');
    SignalsmithStretch.mockRejectedValueOnce(failure);
    const issues = [];
    audio.playbackIssues.subscribe((issue) => issues.push(issue));

    await audio.loadStems({
      vocals: '/vocals.ogg',
      instrumental: '/instrumental.ogg',
    });
    await audio.play();

    expect(audio.hasStems).toBe(true);
    expect(audio.isPlaying()).toBe(true);
    expect(audioElements.slice(0, 2).every((element) => element.play.mock.calls.length === 1)).toBe(true);
    expect(sources[0].connections.at(-1)).toBe(gains[0]);
    expect(sources[1].connections.at(-1)).toBe(gains[1]);
    expect(issues).toEqual([{
      kind: 'info',
      message: 'Key adjustment is unavailable for this song; playback will continue without it.',
    }]);
  });

  it('falls back to direct stems when worklet scheduling fails', async () => {
    const failedNode = makeStretchNode();
    failedNode.schedule.mockRejectedValueOnce(new Error('processor failure'));
    SignalsmithStretch.mockResolvedValueOnce(failedNode);
    SignalsmithStretch.mockResolvedValueOnce(makeStretchNode());

    await audio.loadStems({
      vocals: '/vocals.ogg',
      instrumental: '/instrumental.ogg',
    });

    expect(sources[0].disconnect).toHaveBeenCalled();
    expect(sources[1].disconnect).toHaveBeenCalled();
    expect(sources[0].connections.at(-1)).toBe(gains[0]);
    expect(sources[1].connections.at(-1)).toBe(gains[1]);
  });

  it('falls back to direct stems when a worklet processor fails during playback', async () => {
    await audio.loadStems({
      vocals: '/vocals.ogg',
      instrumental: '/instrumental.ogg',
    });

    worklets[0].dispatch('processorerror');

    expect(sources[0].connections.at(-1)).toBe(gains[0]);
    expect(sources[1].connections.at(-1)).toBe(gains[1]);
  });

  it('converts only local paths to Tauri asset URLs', async () => {
    isTauri.mockReturnValue(true);
    await audio.loadStems({
      vocals: '/home/user/vocals.ogg',
      instrumental: '/media-roots/0/instrumental.ogg',
    });

    expect(audioElements[0].src).toBe('asset:///home/user/vocals.ogg');
    expect(audioElements[1].src).toBe('/media-roots/0/instrumental.ogg');
    expect(convertFileSrc).toHaveBeenCalledTimes(1);
  });
});
