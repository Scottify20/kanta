import '@angular/compiler';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { SongsService } from '../src/app/shared/services/songs.service.ts';

const song = {
  artist: 'Artist',
  album: 'Album',
  title: 'Title',
  stems: [{ name: 'Title (Vocals).mp3', url: '/vocals' }],
  lyrics: [],
  covers: [],
  master: null,
};

function serviceWithHttp(http) {
  const service = Object.create(SongsService.prototype);
  service.http = http;
  service.vocalRangeRequests = new Map();
  service.vocalRangeAttempts = new Set();
  service.currentSong = signal(song);
  return service;
}

describe('song vocal and batch analysis requests', () => {
  it('forces vocal range re-analysis even when a result and prior attempt exist', async () => {
    const updated = { ...song, vocal_min_hz: 110, vocal_max_hz: 220 };
    const http = { post: vi.fn(() => of({ song: updated })) };
    const service = serviceWithHttp(http);
    service.vocalRangeAttempts.add('Artist\u0000Album\u0000Title');

    await expect(service.analyzeSongVocalRange({
      ...song,
      vocal_min_hz: 100,
      vocal_max_hz: 200,
    }, true)).resolves.toEqual(updated);

    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining('/vocal-range/analyze'),
      { vocal_range: true, replaygain: false },
    );
  });

  it('uses the batch start, task status, and cancellation endpoints with their expected payloads', () => {
    const http = {
      post: vi.fn(() => of({ task_id: 'task-1', status: 'pending' })),
      get: vi.fn(() => of({ task_id: 'task-1', status: 'processing', progress: 10, step: 'Analyzing' })),
    };
    const service = serviceWithHttp(http);
    const options = {
      vocal_range: true,
      musical_key: false,
      bpm: false,
      replaygain: true,
      missing_only: false,
    };

    service.startLibraryReanalysis(options).subscribe();
    service.getAnalysisTaskStatus('task-1').subscribe();
    service.cancelAnalysisTask('task-1').subscribe();

    expect(http.post).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/songs/reanalyze'),
      options,
    );
    expect(http.get).toHaveBeenCalledWith(expect.stringContaining('/api/status/task-1'));
    expect(http.post).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/api/cancel/task-1'),
      {},
    );
  });
});
