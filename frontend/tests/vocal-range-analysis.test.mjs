import '@angular/compiler';
import { HttpClient } from '@angular/common/http';
import { createEnvironmentInjector, Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { LibraryService } from '../src/app/shared/services/library.service.ts';
import { SongsService } from '../src/app/shared/services/songs.service.ts';

const song = {
  artist: 'Artist Name',
  album: 'Album Name',
  title: 'Track Name',
  stems: [{ name: 'Track Name (Vocals).flac', url: '/vocals' }],
  lyrics: [],
  covers: [],
  master: null,
  vocal_min_hz: null,
  vocal_max_hz: null,
};

describe('on-demand vocal range analysis', () => {
  it('deduplicates requests and updates the current song manifest', async () => {
    const updated = { ...song, vocal_min_hz: 110, vocal_max_hz: 440 };
    const http = { post: vi.fn(() => of({ song: updated, vocal_range: { min_hz: 110, max_hz: 440 } })) };
    const injector = createEnvironmentInjector([
      { provide: HttpClient, useValue: http },
    ], Injector.NULL);
    const service = runInInjectionContext(injector, () => new SongsService());
    service.setNowPlaying(song, 'task');

    const first = service.analyzeSongVocalRange(song);
    const second = service.analyzeSongVocalRange(song);
    expect(await Promise.all([first, second])).toEqual([updated, updated]);
    expect(http.post).toHaveBeenCalledOnce();
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/songs/Artist%20Name/Album%20Name/Track%20Name/vocal-range/analyze'),
      { vocal_range: true, replaygain: false },
    );
    expect(service.currentSong()).toEqual(updated);
    await expect(service.analyzeSongVocalRange(song)).resolves.toBeNull();
    expect(http.post).toHaveBeenCalledOnce();
    injector.destroy();
  });

  it('deduplicates library requests and refreshes the indexed song', async () => {
    const updated = { ...song, vocal_min_hz: 110, vocal_max_hz: 440 };
    let resolveAnalysis;
    const songsService = {
      analyzeSongVocalRange: vi.fn(() => new Promise((resolve) => { resolveAnalysis = resolve; })),
    };
    const library = Object.create(LibraryService.prototype);
    library.songs = signal([song]);
    library.vocalRangeRequests = new Map();
    library.vocalRangeAnalysisQueue = Promise.resolve();
    library.songsService = songsService;
    library.toast = { error: vi.fn() };

    const first = library.requestVocalRangeAnalysis(song);
    const second = library.requestVocalRangeAnalysis(song);
    await Promise.resolve();
    expect(songsService.analyzeSongVocalRange).toHaveBeenCalledOnce();
    resolveAnalysis(updated);
    await Promise.all([first, second]);
    expect(library.songs()).toEqual([updated]);
    expect(library.toast.error).not.toHaveBeenCalled();
  });

  it('does not request analysis when a vocal stem is unavailable', async () => {
    const library = Object.create(LibraryService.prototype);
    library.songsService = { analyzeSongVocalRange: vi.fn() };
    library.vocalRangeRequests = new Map();
    library.toast = { error: vi.fn() };

    await expect(library.requestVocalRangeAnalysis({ ...song, stems: [] })).resolves.toMatchObject({
      vocal_max_hz: null,
    });
    expect(library.songsService.analyzeSongVocalRange).not.toHaveBeenCalled();
  });
});
