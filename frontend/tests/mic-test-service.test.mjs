import '@angular/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicTestService } from '../src/app/features/settings/ui/mic-test/mic-test.service.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MicTestService lifecycle', () => {
  it('stops a stream that resolves after the caller has cancelled startup', async () => {
    let resolveStream;
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise((resolve) => { resolveStream = resolve; }) },
    });
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const mic = new MicTestService();
    const starting = mic.start('device-id');
    mic.stop();
    resolveStream(stream);
    await starting;

    expect(track.stop).toHaveBeenCalledOnce();
    expect(mic.running()).toBe(false);
  });

  it('stops tracks, disconnects audio nodes, and closes the context', async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const analyser = {
      fftSize: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: (samples) => samples.fill(0),
    };
    const sink = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    const context = {
      state: 'running',
      sampleRate: 44100,
      destination: {},
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      createMediaStreamSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      createGain: vi.fn(() => sink),
    };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const mic = new MicTestService();
    await mic.start();
    mic.stop();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(analyser.disconnect).toHaveBeenCalledOnce();
    expect(sink.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
