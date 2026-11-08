import '@angular/compiler';
import { computed, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { Library } from '../src/app/features/library/library.ts';
import { MetadataEditor } from '../src/app/features/library/ui/metadata-editor/metadata-editor.ts';
import { MiniLyrics } from '../src/app/features/now-playing/ui/mini-lyrics/mini-lyrics.ts';
import { AudioPlayerService, replayGainFactor } from '../src/app/shared/services/audio-player.service.ts';
import { songEntry } from '../src/app/features/library/data/library-entries.ts';

const song = {
  artist: 'Artist', album: 'Album', title: 'Title',
  stems: [{ name: 'Title (Vocals).mp3', url: '/vocals' }, { name: 'Title (Instrumental).mp3', url: '/instrumental' }],
  covers: [], lyrics: [], replaygain_track_gain: -3.2, replaygain_track_peak: 0.9,
};

describe('metadata editor', () => {
  it('accepts numeric ReplayGain values returned by the library', () => {
    const editor = Object.create(MetadataEditor.prototype);
    const draft = editor.toDraft(song);
    expect(draft.replaygain_track_gain).toBe('-3.2');
    expect(draft.replaygain_track_peak).toBe('0.9');
    expect(replayGainFactor({ trackGain: -3.2 }, 'track')).toBeCloseTo(10 ** (-3.2 / 20));
  });

  it('saves numeric ReplayGain values and confirms the result', () => {
    const editor = Object.create(MetadataEditor.prototype);
    editor.manifest = signal(song);
    editor.draft = signal(editor.toDraft(song));
    editor.baseline = signal(editor.toDraft(song));
    editor.saving = signal(false);
    editor.error = signal('');
    editor.saveStatus = signal('');
    editor.saved = { emit: vi.fn() };
    editor.songs = { updateSongMetadata: vi.fn(() => of(song)) };
    editor.setText('genre', 'Pop');
    editor.saveMetadata();
    expect(editor.songs.updateSongMetadata).toHaveBeenCalledWith(song, expect.objectContaining({
      genre: 'Pop', replaygain_track_gain: -3.2,
    }));
    expect(editor.saveStatus()).toBe('Changes saved.');
    expect(editor.saved.emit).toHaveBeenCalledWith(song);
  });
});

describe('mini lyrics', () => {
  it('only shows a queued song after it starts, including when paused', () => {
    const mini = Object.create(MiniLyrics.prototype);
    const audio = new AudioPlayerService();
    audio.vocalsAudio = { getAttribute: () => '/vocals', pause: vi.fn(), remove: vi.fn() };
    audio.instrumentalAudio = { getAttribute: () => '/instrumental', pause: vi.fn(), remove: vi.fn() };
    mini.audio = audio;
    mini.playerVisible = signal(false);
    mini.song = signal(song);
    mini.songs = { currentQueueTaskId: signal('a') };
    mini.queue = signal({ karaoke_queue: [{ task_id: 'a', status: 'completed' }] });
    const visible = computed(() => mini.isVisible());

    expect(visible()).toBe(false);
    audio.playbackStarted.set(true);
    audio.isPlaying.set(true);
    expect(visible()).toBe(true);
    audio.pause();
    expect(visible()).toBe(true);
    mini.playerVisible.set(true);
    expect(visible()).toBe(false);
    mini.playerVisible.set(false);
    expect(visible()).toBe(true);

    mini.song.set({ ...song, stems: [{ name: 'Other (Vocals).mp3', url: '/other' }, song.stems[1]] });
    expect(visible()).toBe(false);
    mini.song.set(song);
    mini.queue.set({ karaoke_queue: [] });
    expect(visible()).toBe(false);
    mini.queue.set({ karaoke_queue: [{ task_id: 'a', status: 'completed' }] });
    expect(visible()).toBe(true);
    audio.release();
    expect(visible()).toBe(false);
  });

  it('marks playback started only after play succeeds, preserving it while paused and clearing it on release', async () => {
    const audio = new AudioPlayerService();
    audio.context = { resume: vi.fn().mockResolvedValue() };
    const stem = () => ({ play: vi.fn().mockResolvedValue(), pause: vi.fn(), remove: vi.fn() });
    audio.vocalsAudio = stem();
    audio.instrumentalAudio = stem();
    expect(audio.playbackStarted()).toBe(false);
    await audio.play();
    expect(audio.playbackStarted()).toBe(true);
    audio.pause();
    expect(audio.playbackStarted()).toBe(true);
    audio.release();
    expect(audio.playbackStarted()).toBe(false);
  });

  it('does not mark playback started when the audio cannot play', async () => {
    const audio = new AudioPlayerService();
    audio.context = { resume: vi.fn().mockResolvedValue() };
    audio.vocalsAudio = { play: vi.fn().mockRejectedValue(new Error('blocked')) };
    audio.instrumentalAudio = { play: vi.fn().mockResolvedValue() };
    await expect(audio.play()).rejects.toThrow('blocked');
    expect(audio.playbackStarted()).toBe(false);
  });

  it('does not mark released stems as started when a pending play resolves', async () => {
    const audio = new AudioPlayerService();
    let finishPlay;
    const pending = new Promise((resolve) => { finishPlay = resolve; });
    audio.context = { resume: vi.fn().mockResolvedValue() };
    audio.vocalsAudio = { play: vi.fn(() => pending), pause: vi.fn(), remove: vi.fn() };
    audio.instrumentalAudio = { play: vi.fn(() => pending), pause: vi.fn(), remove: vi.fn() };
    const play = audio.play();
    await Promise.resolve();
    audio.release();
    finishPlay();
    await play;
    expect(audio.playbackStarted()).toBe(false);
    expect(audio.isPlaying()).toBe(false);
  });

  it('only treats matching stem sources as loaded', () => {
    const audio = Object.create(AudioPlayerService.prototype);
    audio.vocalsAudio = { getAttribute: () => '/vocals' };
    audio.instrumentalAudio = { getAttribute: () => '/instrumental' };
    expect(audio.hasLoadedSources({ vocals: '/vocals', instrumental: '/instrumental' })).toBe(true);
    expect(audio.hasLoadedSources({ vocals: '/other', instrumental: '/instrumental' })).toBe(false);
    audio.vocalsAudio = null;
    expect(audio.hasLoadedSources({ vocals: '/vocals', instrumental: '/instrumental' })).toBe(false);
  });

  it('toggles the pill while preserving the expanded bounds', () => {
    const mini = Object.create(MiniLyrics.prototype);
    mini.minimized = signal(false);
    mini.savedBounds = signal({ x: 20, y: 30, width: 360, height: 240 });
    mini.pillAnchor = signal(null);
    mini.viewport = signal({ width: 800, height: 600 });
    mini.bounds = computed(() => mini.constrain(mini.savedBounds()));
    mini.minimizedAnchor = computed(() => mini.pillAnchor());
    mini.saveBounds = vi.fn();
    mini.popups = { close: vi.fn() };
    mini.toggleMinimized();
    expect(mini.minimized()).toBe(true);
    expect(mini.minimizedAnchor()).toEqual({ x: 380, y: 270 });
    mini.toggleMinimized();
    expect(mini.minimized()).toBe(false);
    expect(mini.savedBounds()).toEqual({ x: 20, y: 30, width: 360, height: 240 });
    expect(mini.popups.close).toHaveBeenCalledTimes(2);
  });

  it('moves the minimized pill using its own dimensions and expands at its new anchor', () => {
    const mini = Object.create(MiniLyrics.prototype);
    mini.minimized = signal(false);
    mini.savedBounds = signal({ x: 424, y: 344, width: 360, height: 240 });
    mini.pillAnchor = signal(null);
    mini.viewport = signal({ width: 800, height: 600 });
    mini.bounds = computed(() => mini.constrain(mini.savedBounds()));
    mini.minimizedAnchor = computed(() => mini.pillAnchor());
    mini.saveBounds = vi.fn();
    mini.popups = { close: vi.fn() };
    const target = {
      closest: () => ({ getBoundingClientRect: () => ({ width: 180, height: 48 }) }),
      setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    };
    mini.toggleMinimized();
    mini.startGesture({ button: 0, pointerId: 1, clientX: 700, clientY: 560, currentTarget: target, preventDefault: vi.fn() }, 'move');
    mini.moveGesture({ pointerId: 1, clientX: 550, clientY: 410 });
    expect(mini.minimizedAnchor()).toEqual({ x: 634, y: 434 });
    mini.finishGesture({ pointerId: 1, currentTarget: target });
    mini.toggleMinimized();
    expect(mini.savedBounds()).toEqual({ x: 274, y: 194, width: 360, height: 240 });

    mini.toggleMinimized();
    mini.startGesture({ button: 0, pointerId: 2, clientX: 550, clientY: 410, currentTarget: target, preventDefault: vi.fn() }, 'move');
    mini.moveGesture({ pointerId: 2, clientX: 200, clientY: 100 });
    expect(mini.minimizedAnchor()).toEqual({ x: 284, y: 124 });
    mini.cancelGesture({ pointerId: 2 });
    expect(mini.minimizedAnchor()).toEqual({ x: 634, y: 434 });
    mini.startGesture({ button: 0, pointerId: 3, clientX: 550, clientY: 410, currentTarget: target, preventDefault: vi.fn() }, 'move');
    mini.moveGesture({ pointerId: 3, clientX: 700, clientY: 560 });
    expect(mini.minimizedAnchor()).toEqual({ x: 784, y: 584 });
    mini.finishGesture({ pointerId: 3, currentTarget: target });
    mini.onKeyboard({ key: 'ArrowLeft', shiftKey: false, currentTarget: target, preventDefault: vi.fn() }, 'move');
    expect(mini.minimizedAnchor()).toEqual({ x: 774, y: 584 });
  });

  it('resumes loaded audio without reselecting the track', async () => {
    const mini = Object.create(MiniLyrics.prototype);
    mini.selectedTrack = () => ({ task_id: 'a', status: 'completed' });
    mini.song = () => song;
    mini.audio = { hasLoadedSources: vi.fn(() => true), isPlaying: () => false, play: vi.fn().mockResolvedValue() };
    mini.songs = { currentQueueTaskId: () => 'a', requestQueueTrack: vi.fn() };
    await mini.resume();
    expect(mini.audio.play).toHaveBeenCalledOnce();
    expect(mini.songs.requestQueueTrack).not.toHaveBeenCalled();
  });

  it('selects a completed queue track when audio is not loaded, but never resumes processing tracks', async () => {
    const mini = Object.create(MiniLyrics.prototype);
    const track = { task_id: 'a', status: 'completed' };
    mini.selectedTrack = () => track;
    mini.song = () => null;
    mini.audio = { hasLoadedSources: vi.fn(() => false), isPlaying: () => false, play: vi.fn() };
    mini.songs = { currentQueueTaskId: () => null, requestQueueTrack: vi.fn() };
    await mini.resume();
    expect(mini.songs.requestQueueTrack).toHaveBeenCalledWith(track);
    mini.selectedTrack = () => ({ task_id: 'b', status: 'processing' });
    await mini.resume();
    expect(mini.songs.requestQueueTrack).toHaveBeenCalledOnce();
    expect(mini.audio.play).not.toHaveBeenCalled();
  });

  it('reports playback failures', async () => {
    const mini = Object.create(MiniLyrics.prototype);
    mini.selectedTrack = () => ({ task_id: 'a', status: 'completed' });
    mini.song = () => song;
    mini.audio = { hasLoadedSources: vi.fn(() => true), isPlaying: () => false, play: vi.fn().mockRejectedValue(new Error('blocked')) };
    mini.songs = { currentQueueTaskId: () => 'a' };
    mini.toast = { error: vi.fn() };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mini.resume();
    expect(mini.toast.error).toHaveBeenCalledWith('Could not resume playback.');
    log.mockRestore();
  });

  it('does not resume stems from a different selected song', async () => {
    const mini = Object.create(MiniLyrics.prototype);
    const track = { task_id: 'a', status: 'completed' };
    mini.selectedTrack = () => track;
    mini.song = () => song;
    mini.audio = { hasLoadedSources: vi.fn(() => false), isPlaying: () => false, play: vi.fn() };
    mini.songs = { currentQueueTaskId: () => 'a', requestQueueTrack: vi.fn() };
    await mini.resume();
    expect(mini.audio.hasLoadedSources).toHaveBeenCalledWith({ vocals: '/vocals', instrumental: '/instrumental' });
    expect(mini.songs.requestQueueTrack).toHaveBeenCalledWith(track);
    expect(mini.audio.play).not.toHaveBeenCalled();
  });
});

describe('library processing', () => {
  it('blocks unfinished songs even when stems already exist', () => {
    const library = Object.create(Library.prototype);
    library.processingSongs = () => new Map([['Artist\0Album\0Title', 50]]);
    expect(library.entryUnavailable(songEntry(song))).toBe(true);
    const actions = vi.fn();
    library.open = actions;
    library.activate(songEntry(song), 0, {});
    expect(actions).not.toHaveBeenCalled();
    expect(library.playable([song])).toEqual([]);
    library.processingSongs = () => new Map();
    expect(library.entryUnavailable(songEntry(song))).toBe(false);
    expect(library.playable([song])).toEqual([song]);
    expect(library.entryUnavailable(songEntry({ ...song, stems: [] }))).toBe(true);
  });
});
