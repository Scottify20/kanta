import '@angular/compiler';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { LibraryService } from '../src/app/shared/services/library.service.ts';

const makeSong = (title) => ({
  artist: 'Artist',
  album: 'Album',
  title,
  stems: [{ name: `${title} (Vocals).mp3`, url: '/vocals' }],
  lyrics: [],
  covers: [],
  master: null,
});

describe('library vocal-range analysis scheduling', () => {
  it('runs only one background analysis request at a time', async () => {
    let finishFirst;
    const firstResult = new Promise((resolve) => { finishFirst = resolve; });
    const first = makeSong('First');
    const second = makeSong('Second');
    const songsService = {
      analyzeSongVocalRange: vi.fn()
        .mockReturnValueOnce(firstResult)
        .mockResolvedValueOnce(second),
    };
    const library = Object.create(LibraryService.prototype);
    library.songsService = songsService;
    library.songs = signal([first, second]);
    library.vocalRangeRequests = new Map();
    library.vocalRangeAnalysisQueue = Promise.resolve();
    library.toast = { error: vi.fn() };

    const firstRequest = library.requestVocalRangeAnalysis(first);
    const secondRequest = library.requestVocalRangeAnalysis(second);
    await Promise.resolve();
    expect(songsService.analyzeSongVocalRange).toHaveBeenCalledTimes(1);

    finishFirst(first);
    await Promise.all([firstRequest, secondRequest]);

    expect(songsService.analyzeSongVocalRange).toHaveBeenCalledTimes(2);
  });
});
