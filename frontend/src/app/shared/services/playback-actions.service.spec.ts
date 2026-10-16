import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { QueueService } from '../../features/queue/data-access/queue.service';
import { PlaybackActions } from './playback-actions.service';
import { SongManifest, SongsService } from './songs.service';

describe('PlaybackActions', () => {
  const song = (title: string): SongManifest => ({
    artist: 'A',
    album: 'B',
    title,
    stems: [
      { name: `${title} (Vocals).mp3`, url: '/v' },
      { name: `${title} (Instrumental).mp3`, url: '/i' },
    ],
    lyrics: [],
    covers: [],
    master: null,
  });

  it('clears only the karaoke queue and chains inserted songs in order', async () => {
    const clearQueue = vi.fn(() => of({ message: 'ok' }));
    const addProcessedTrack = vi.fn((s: { title: string }, _a?: unknown, after?: string | null) => of({ item: { task_id: `t-${s.title}` } }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: QueueService, useValue: { clearQueue, addProcessedTrack } },
      ],
    });
    const selectSong = vi.spyOn(TestBed.inject(SongsService), 'selectSong');

    await TestBed.inject(PlaybackActions).playSongs([song('one'), song('two')]);

    expect(clearQueue).toHaveBeenCalledTimes(1);
    expect(clearQueue).toHaveBeenCalledWith(1);
    expect(addProcessedTrack.mock.calls.map((c) => c[2])).toEqual([null, 't-one']);
    expect(selectSong).toHaveBeenCalledWith(expect.objectContaining({ title: 'one' }), true, 't-one');
  });
});
