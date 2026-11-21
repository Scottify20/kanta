import '@angular/compiler';
import { HttpClient } from '@angular/common/http';
import { computed, createEnvironmentInjector, Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { Library } from '../src/app/features/library/library.ts';
import { App } from '../src/app/app.ts';
import { SearchBar } from '../src/app/shared/components/search-bar/search-bar.ts';
import { EntryActionsService } from '../src/app/shared/services/entry-actions.service.ts';
import { LibraryService } from '../src/app/shared/services/library.service.ts';
import { PlaylistsService } from '../src/app/shared/services/playlists.service.ts';
import { SettingsService } from '../src/app/shared/services/settings.service.ts';
import { ToastService } from '../src/app/shared/services/toast.service.ts';
import { SongsService } from '../src/app/shared/services/songs.service.ts';
import { MetadataEditor } from '../src/app/features/library/ui/metadata-editor/metadata-editor.ts';
import { LibraryToolbar } from '../src/app/features/library/ui/library-toolbar/library-toolbar.ts';
import { MiniLyrics } from '../src/app/features/now-playing/ui/mini-lyrics/mini-lyrics.ts';
import { AudioPlayerService, clampVolumeBoostDb, replayGainFactor } from '../src/app/shared/services/audio-player.service.ts';
import { ArtistInfoService } from '../src/app/shared/services/artist-info.service.ts';
import { genreEntries, songEntry, sortSongsByVocalFit, SORT_MODES } from '../src/app/features/library/data/library-entries.ts';
import { createProfileFromPreset } from '../src/app/shared/services/party-session.service.ts';
import { DEFAULT_ARTIST_DELIMITERS, DEFAULT_GENRE_DELIMITERS, splitMetadataValues } from '../src/app/shared/util/metadata-delimiters.ts';

const song = {
  artist: 'Artist', album: 'Album', title: 'Title',
  musical_key: 'F',
  stems: [{ name: 'Title (Vocals).mp3', url: '/vocals' }, { name: 'Title (Instrumental).mp3', url: '/instrumental' }],
  covers: [], lyrics: [], replaygain_track_gain: -3.2, replaygain_track_peak: 0.9,
};

describe('library song filters', () => {
  it('offers All songs to reset any filter and preserves the active-filter toggle', () => {
    const injector = createEnvironmentInjector([], Injector.NULL);
    const toolbar = runInInjectionContext(injector, () => new LibraryToolbar());
    expect(toolbar.lyricsFilters).toContainEqual({ value: 'all', label: 'All songs' });
    toolbar.lyricsFilter.set('all');
    expect(toolbar.filterLabel()).toBe('All songs');
    for (const value of ['word', 'line', 'duet', 'none']) {
      toolbar.selectFilter(value);
      expect(toolbar.lyricsFilter()).toBe(value);
      toolbar.selectFilter('all');
      expect(toolbar.lyricsFilter()).toBe('all');
    }
    toolbar.selectFilter('word');
    toolbar.selectFilter('word');
    expect(toolbar.lyricsFilter()).toBe('all');
    toolbar.selectFilter('all');
    expect(toolbar.lyricsFilter()).toBe('all');
    injector.destroy();
  });

  it('offers genres as a song-browsing library tab', () => {
    const injector = createEnvironmentInjector([], Injector.NULL);
    const toolbar = runInInjectionContext(injector, () => new LibraryToolbar());
    toolbar.tab.set('genres');
    expect(toolbar.tabs.map(({ id }) => id)).toEqual(['songs', 'albums', 'artists', 'genres', 'playlists']);
    expect(toolbar.sortModes()).toContain('most-songs');
    expect(toolbar.sortModes()).not.toContain('artist');
    expect(SORT_MODES.songs).toContain('best-fit');
    injector.destroy();
  });

  it('ranks vocal fits before reach and unanalyzed songs for the active singer', () => {
    const singer = { ...createProfileFromPreset('Tenor', 'Singer'), tessituraMaxHz: 400 };
    const songs = [
      { ...song, title: 'Unanalyzed', vocal_max_hz: null },
      { ...song, title: 'Reach', vocal_max_hz: 800 },
      { ...song, title: 'Adjusted', vocal_max_hz: 450 },
      { ...song, title: 'Natural', vocal_max_hz: 400 },
    ];

    expect(sortSongsByVocalFit(songs, singer).map(({ title }) => title)).toEqual([
      'Natural', 'Adjusted', 'Reach', 'Unanalyzed',
    ]);
  });

  it('lists unique genres as openable entries containing their songs', () => {
    const songs = [
      { ...song, genre: 'Pop' },
      { ...song, title: 'Second', genre: ' pop ' },
      { ...song, title: 'Third', genre: '' },
    ];
    const entries = genreEntries(songs);
    expect(entries.map((entry) => entry.title)).toEqual(['Pop', 'Unknown genre']);
    expect(entries.map((entry) => entry.count)).toEqual([2, 1]);
    expect(entries[0].kind).toBe('genre');

    const library = Object.create(Library.prototype);
    library.detail = signal(null);
    library.selection = signal(new Set());
    library.host = { nativeElement: { closest: () => null } };
    library.tab = signal('genres');
    library.entryUnavailable = () => false;
    library.activate(entries[0], 0, { ctrlKey: false, metaKey: false, shiftKey: false });
    expect(library.detail()).toBe(entries[0]);
  });
});

describe('volume boost', () => {
  it('clamps boost to a safe 0–6 dB range', () => {
    expect(clampVolumeBoostDb(-1)).toBe(0);
    expect(clampVolumeBoostDb(3.5)).toBe(3.5);
    expect(clampVolumeBoostDb(20)).toBe(6);
    expect(clampVolumeBoostDb(Number.NaN)).toBe(0);
  });
});

describe('artist photos', () => {
  it('requests and caches artist information by display name across source folders', async () => {
    const http = { get: vi.fn(() => of({ name: 'Display Name', bio: null, photo_url: '/local/photo', source_url: null, sources: [] })) };
    const injector = createEnvironmentInjector([{ provide: HttpClient, useValue: http }], Injector.NULL);
    const service = runInInjectionContext(injector, () => new ArtistInfoService());
    expect(service.info('Display Name')).toBeNull();
    service.request('Display Name', 'Artist Folder');
    await Promise.resolve();
    await Promise.resolve();
    expect(http.get).toHaveBeenCalledWith(expect.stringContaining('/api/artists/info'), {
      params: { name: 'Display Name', folder: 'Artist Folder' },
    });
    expect(service.info('Display Name').photo_url).toBe('/local/photo');
    service.request('Display Name', 'Other Folder');
    expect(http.get).toHaveBeenCalledOnce();
    injector.destroy();
  });

  it('splits genre tags by the configured delimiters and ignores empty values', () => {
    const songs = [
      { ...song, genre: 'Pop; Rock / Pop' },
      { ...song, title: 'Second', genre: 'Rock' },
    ];
    const entries = genreEntries(songs, ';/');
    expect(entries.map((entry) => [entry.title, entry.count])).toEqual([['Pop', 1], ['Rock', 2]]);
    expect(splitMetadataValues(' Alice & Bob ; Alice ', '&;')).toEqual(['Alice', 'Bob']);
    expect(splitMetadataValues('A [B] / C', '[]/')).toEqual(['A', 'B', 'C']);
    expect(splitMetadataValues('Alice Feat. Bob & Carol', DEFAULT_ARTIST_DELIMITERS)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(splitMetadataValues('Alice FEAT. Bob', ['feat.'])).toEqual(['Alice', 'Bob']);
    expect(splitMetadataValues('Rock; Metal', DEFAULT_GENRE_DELIMITERS)).toEqual(['Rock', 'Metal']);
  });
});

describe('metadata editor', () => {
  it('loads the key, shows its Camelot code, and saves picker selections', () => {
    const editor = Object.create(MetadataEditor.prototype);
    const draft = editor.toDraft(song);
    editor.draft = signal(draft);
    editor.saveStatus = signal('');
    editor.keyPickerOpen = signal(true);
    editor.selectMusicalKey('F#');
    expect(editor.draft().musical_key).toBe('F#');
    expect(editor.camelotCode()).toBe('2B');
    expect(editor.keyPickerOpen()).toBe(false);
  });

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
    editor.analyzingVocalRange = signal(false);
    editor.analyzingMusicalKey = signal(false);
    editor.error = signal('');
    editor.saveStatus = signal('');
    editor.keyPickerOpen = signal(true);
    editor.saved = { emit: vi.fn() };
    editor.songs = { updateSongMetadata: vi.fn(() => of(song)) };
    editor.setText('genre', 'Pop');
    editor.selectMusicalKey('F#');
    editor.saveMetadata();
    expect(editor.songs.updateSongMetadata).toHaveBeenCalledWith(song, expect.objectContaining({
      genre: 'Pop', musical_key: 'F#', replaygain_track_gain: -3.2,
    }));
    expect(editor.saveStatus()).toBe('Changes saved.');
    expect(editor.saved.emit).toHaveBeenCalledWith(song);
  });

  it('does not send an unchanged metadata draft', () => {
    const editor = Object.create(MetadataEditor.prototype);
    const draft = editor.toDraft(song);
    editor.manifest = signal(song);
    editor.draft = signal(draft);
    editor.baseline = signal(draft);
    editor.saving = signal(false);
    editor.analyzingVocalRange = signal(false);
    editor.analyzingMusicalKey = signal(false);
    editor.songs = { updateSongMetadata: vi.fn() };
    editor.saveMetadata();
    expect(editor.songs.updateSongMetadata).not.toHaveBeenCalled();
  });

  it('refreshes vocal range without clobbering unsaved metadata edits', async () => {
    const editor = Object.create(MetadataEditor.prototype);
    const draft = editor.toDraft(song);
    const updated = {
      ...song,
      vocal_min_hz: 110,
      vocal_max_hz: 220,
      vocal_min_note: 'A2',
      vocal_max_note: 'A3',
      vocal_voice_type: 'Baritone',
    };
    editor.manifest = signal(song);
    editor.draft = signal({ ...draft, genre: 'Unsaved genre' });
    editor.baseline = signal(draft);
    editor.analyzingVocalRange = signal(false);
    editor.analyzingMusicalKey = signal(false);
    editor.saving = signal(false);
    editor.vocalRangeError = signal('');
    editor.saveStatus = signal('');
    editor.saved = { emit: vi.fn() };
    editor.library = { requestVocalRangeAnalysis: vi.fn().mockResolvedValue(updated) };

    await editor.analyzeVocalRange();

    expect(editor.library.requestVocalRangeAnalysis).toHaveBeenCalledWith(song, true);
    expect(editor.manifest()).toMatchObject({ vocal_min_note: 'A2', vocal_max_note: 'A3' });
    expect(editor.draft().genre).toBe('Unsaved genre');
    expect(editor.baseline().genre).toBe('');
    expect(editor.dirty()).toBe(true);
    expect(editor.saved.emit).toHaveBeenCalledWith(updated);
  });

  it('re-analyzes musical key without replacing unsaved draft fields', async () => {
    const editor = Object.create(MetadataEditor.prototype);
    const draft = editor.toDraft(song);
    const updated = { ...song, musical_key: 'G', camelot_key: '9B' };
    editor.manifest = signal(song);
    editor.draft = signal({ ...draft, genre: 'Unsaved genre' });
    editor.baseline = signal(draft);
    editor.analyzingVocalRange = signal(false);
    editor.analyzingMusicalKey = signal(false);
    editor.saving = signal(false);
    editor.musicalKeyError = signal('');
    editor.saveStatus = signal('');
    editor.saved = { emit: vi.fn() };
    editor.songs = { analyzeSongMusicalKey: vi.fn().mockResolvedValue(updated) };

    await editor.analyzeMusicalKey();

    expect(editor.songs.analyzeSongMusicalKey).toHaveBeenCalledWith(song);
    expect(editor.manifest().musical_key).toBe('G');
    expect(editor.draft().genre).toBe('Unsaved genre');
    expect(editor.dirty()).toBe(true);
    expect(editor.saved.emit).toHaveBeenCalledWith(updated);
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

  it('restores the collection tab scroll position after returning from its detail', () => {
    const content = { scrollTop: 0, isConnected: true };
    const library = Object.create(Library.prototype);
    library.host = { nativeElement: { closest: () => content } };
    library.tab = signal('albums');
    library.detail = signal(null);
    library.selection = signal(new Set());
    library.router = { navigateByUrl: vi.fn() };
    content.scrollTop = 360;
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback();
      return 1;
    });

    library.open({ kind: 'album', songs: [] });
    expect(library.detail()).not.toBeNull();
    content.scrollTop = 0;
    library.back();

    expect(library.detail()).toBeNull();
    expect(content.scrollTop).toBe(360);
    vi.unstubAllGlobals();
  });

  describe('library scroll restoration', () => {
    it('restores only the Songs tab position and clears it when another tab is opened', () => {
      const app = Object.create(App.prototype);
      const content = { scrollTop: 0, isConnected: true };
      app.contentElement = () => ({ nativeElement: content });
      app.libraryScrollTop = 420;
      app.library = { activeTab: signal('songs') };
      app.route = () => '/library';
      app.isLibraryRoute = (url) => url === '/library';
      vi.stubGlobal('requestAnimationFrame', (callback) => {
        callback();
        return 1;
      });

      app.syncLibraryScroll('/library', 'songs');
      expect(content.scrollTop).toBe(420);

      app.library.activeTab.set('genres');
      content.scrollTop = 140;
      app.syncLibraryScroll('/library', 'genres');
      expect(content.scrollTop).toBe(0);
      expect(app.libraryScrollTop).toBe(0);
      vi.unstubAllGlobals();
    });
  });

  describe('search result activation', () => {
    it('plays song hits but opens album, artist, and playlist hits', () => {
      const search = Object.create(SearchBar.prototype);
      search.focused = signal(true);
      search.actions = { playSongs: vi.fn() };
      search.entryActions = { open: vi.fn() };

      const songHit = { kind: 'song', key: 'song:key', songs: [song] };
      search.activate(songHit);
      expect(search.actions.playSongs).toHaveBeenCalledWith(songHit.songs);
      expect(search.entryActions.open).not.toHaveBeenCalled();

      for (const kind of ['album', 'artist', 'playlist']) {
        const hit = { kind, key: `${kind}:key`, songs: [song] };
        search.focused.set(true);
        search.activate(hit);
        expect(search.entryActions.open).toHaveBeenLastCalledWith(hit.key);
      }
      expect(search.actions.playSongs).toHaveBeenCalledOnce();
      expect(search.focused()).toBe(false);
    });

    describe('go to artist and album actions', () => {
      it('opens the first parsed artist and the song album for a collaboration', async () => {
        const actions = Object.create(EntryActionsService.prototype);
        actions.settings = { artistDelimiters: () => DEFAULT_ARTIST_DELIMITERS };
        actions.library = { pendingOpen: signal(null) };
        actions.router = { navigateByUrl: vi.fn() };
        const collab = { ...song, display_artist: 'Alice feat. Bob' };

        await actions.perform({ kind: 'song', title: collab.title, songs: [collab] }, 'go-artist');
        expect(actions.library.pendingOpen()).toBe('artist:alice');

        await actions.perform({ kind: 'song', title: collab.title, songs: [collab] }, 'go-album');
        expect(actions.library.pendingOpen()).toBe(`album:${collab.artist}\u0000${collab.album}`);
        expect(actions.router.navigateByUrl).toHaveBeenCalledWith('/library');
        expect(actions.router.navigateByUrl).toHaveBeenCalledTimes(2);
      });

      it('uses the fetched artist photo for artist results', () => {
        const search = Object.create(SearchBar.prototype);
        const hit = { kind: 'artist', key: 'artist:alice', title: 'Alice', coverUrl: '/album-cover', songs: [song] };
        search.artistInfo = { info: vi.fn(() => ({ photo_url: '/artist-photo' })) };

        expect(search.withArtistPhoto(hit).coverUrl).toBe('/artist-photo');
        const albumHit = { ...hit, kind: 'album' };
        expect(search.withArtistPhoto(albumHit)).toBe(albumHit);
      });
    });
  });

  describe('library search ranking', () => {
    it('puts strongly matched artists and albums before same-named songs', () => {
      const playlistService = { playlists: signal([]) };
      const injector = createEnvironmentInjector([
        { provide: SongsService, useValue: {} },
        { provide: PlaylistsService, useValue: playlistService },
        {
          provide: SettingsService,
          useValue: {
            artistDelimiters: signal('&,;/+'),
            genreDelimiters: signal(',;/|'),
            getSettings: () => of({ artist_delimiters: '&,;/+', genre_delimiters: ',;/|' }),
          },
        },
        { provide: ToastService, useValue: { error: vi.fn() } },
      ], Injector.NULL);
      const library = runInInjectionContext(injector, () => new LibraryService());
      library.songs.set([
        { ...song, title: 'Artist' },
        { ...song, artist: 'Other artist', album: 'Artist', title: 'Artist' },
      ]);

      const hits = library.search('Artist');
      const artistHit = hits.findIndex((hit) => hit.kind === 'artist' && hit.title === 'Artist');
      const artistSongHit = hits.findIndex((hit) => hit.kind === 'song' && hit.songs[0].artist === 'Artist');
      const albumHit = hits.findIndex((hit) => hit.kind === 'album' && hit.title === 'Artist');
      const albumSongHit = hits.findIndex((hit) => hit.kind === 'song' && hit.songs[0].album === 'Artist');

      expect(artistHit).toBeGreaterThanOrEqual(0);
      expect(albumHit).toBeGreaterThanOrEqual(0);
      expect(artistHit).toBeLessThan(artistSongHit);
      expect(albumHit).toBeLessThan(albumSongHit);
      injector.destroy();
    });

    it('lists each delimited artist as its own collection', () => {
      const injector = createEnvironmentInjector([
        { provide: SongsService, useValue: {} },
        { provide: PlaylistsService, useValue: { playlists: signal([]) } },
        {
          provide: SettingsService,
          useValue: {
            artistDelimiters: signal('&'),
            genreDelimiters: signal(','),
            getSettings: () => of({ artist_delimiters: '&', genre_delimiters: ',' }),
          },
        },
        { provide: ToastService, useValue: { error: vi.fn() } },
      ], Injector.NULL);
      const library = runInInjectionContext(injector, () => new LibraryService());
      library.songs.set([{ ...song, display_artist: 'Alice & Bob' }]);

      expect(library.artists().map((artist) => artist.displayArtist)).toEqual(['Alice', 'Bob']);
      expect(library.artists().map((artist) => artist.songs)).toEqual([[library.songs()[0]], [library.songs()[0]]]);
      injector.destroy();
    });
  });
});
