import '@angular/compiler';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../src/app/shared/services/audio-player.service.ts';
import { NowPlaying } from '../src/app/features/now-playing/now-playing.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('media session controls', () => {
  it('registers each action independently and forwards navigation', () => {
    const handlers = {};
    const setActionHandler = vi.fn((action, handler) => {
      if (action === 'nexttrack') throw new Error('Unsupported action');
      handlers[action] = handler;
    });
    vi.stubGlobal('navigator', { mediaSession: { setActionHandler } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const player = new AudioPlayerService();
    const directions = [];
    player.trackNavigation.subscribe((direction) => directions.push(direction));
    const pause = vi.spyOn(player, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(player, 'play').mockResolvedValue();

    handlers.play();
    handlers.pause();
    handlers.previoustrack();
    expect(setActionHandler.mock.calls.map(([action]) => action))
      .toEqual(['play', 'pause', 'nexttrack', 'previoustrack']);
    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
    expect(directions).toEqual(['previous']);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('forwards next and previous when both are supported', () => {
    const handlers = {};
    vi.stubGlobal('navigator', {
      mediaSession: { setActionHandler: (action, handler) => { handlers[action] = handler; } },
    });
    const player = new AudioPlayerService();
    const directions = [];
    player.trackNavigation.subscribe((direction) => directions.push(direction));
    handlers.nexttrack();
    handlers.previoustrack();
    expect(directions).toEqual(['next', 'previous']);
  });
});

describe('player queue navigation', () => {
  function makePlayer(items, index, seconds = 0) {
    const player = Object.create(NowPlaying.prototype);
    player.queueSnapshot = () => ({ karaoke_queue: items });
    player.currentQueueIndex = () => index;
    player.hasNext = () => {
      const upcoming = player.queueItems()[index < 0 ? 0 : index + 1];
      return !!upcoming && upcoming.status === 'completed';
    };
    player.selectedManifest = () => ({ title: 'current' });
    player.audioPlayer = { currentTime: () => seconds, seek: vi.fn(), pause: vi.fn() };
    player.playQueueItem = vi.fn().mockResolvedValue();
    return player;
  }

  const completed = (id) => ({ task_id: id, status: 'completed' });

  it('moves to completed tracks and skips failed entries', async () => {
    const first = completed('1');
    const next = completed('2');
    const player = makePlayer([first, { task_id: 'failed', status: 'failed' }, next], 0);
    await player.playNext();
    expect(player.playQueueItem).toHaveBeenCalledWith(next);

    const previous = makePlayer([first, next], 1);
    await previous.playPrevious();
    expect(previous.playQueueItem).toHaveBeenCalledWith(first);
  });

  it('restarts on previous after three seconds or at the start', async () => {
    for (const [index, time] of [[1, 4], [0, 0]]) {
      const player = makePlayer([completed('1'), completed('2')], index, time);
      await player.playPrevious();
      expect(player.audioPlayer.seek).toHaveBeenCalledWith(0);
      expect(player.playQueueItem).not.toHaveBeenCalled();
    }
  });

  it('waits for processing items and stops only at the end', async () => {
    const waiting = makePlayer([completed('1'), { task_id: '2', status: 'processing' }], 0);
    await waiting.playNext();
    expect(waiting.audioPlayer.pause).not.toHaveBeenCalled();
    expect(waiting.playQueueItem).not.toHaveBeenCalled();

    const end = makePlayer([completed('1')], 0);
    await end.playNext();
    expect(end.audioPlayer.pause).toHaveBeenCalledOnce();
    expect(end.audioPlayer.seek).toHaveBeenCalledWith(0);
  });

  it('ignores a stale manifest after another track is selected', async () => {
    const player = Object.create(NowPlaying.prototype);
    const response = new Subject();
    player.manifestRequest = 0;
    player.selectedTrack = signal(completed('1'));
    player.selectedManifest = signal(null);
    player.songsService = { getManifest: () => response, setNowPlaying: vi.fn() };
    player.playbackError = signal('');
    const loading = player.loadManifest(completed('1'));
    player.selectedTrack.set(completed('2'));
    response.next({ title: 'old' });
    expect(await loading).toBeNull();
    expect(player.selectedManifest()).toBeNull();
    expect(player.songsService.setNowPlaying).not.toHaveBeenCalled();
  });

  it('serializes repeated media and automatic navigation commands', async () => {
    const player = Object.create(NowPlaying.prototype);
    let finish;
    player.mediaNavigation = Promise.resolve();
    player.playNext = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    player.playPrevious = vi.fn().mockResolvedValue();
    player.queueMediaNavigation('next');
    player.queueMediaNavigation('previous');
    await Promise.resolve();
    expect(player.playNext).toHaveBeenCalledOnce();
    expect(player.playPrevious).not.toHaveBeenCalled();
    finish();
    await player.mediaNavigation;
    expect(player.playPrevious).toHaveBeenCalledOnce();
  });
});
