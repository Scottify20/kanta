import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { QueueService } from '../queue/data-access/queue.service';
import { Library } from './library';
import { SongManifest, SongsService } from '../../shared/services/songs.service';

describe('Library', () => {
  let fixture: ComponentFixture<Library>;
  let component: Library;
  let addProcessedTrack: ReturnType<typeof vi.fn>;
  let clearAllQueue: ReturnType<typeof vi.fn>;
  let selectSong: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;

  const song: SongManifest = {
    artist: 'Artist',
    album: 'Album',
    title: 'Song',
    stems: [
      { name: 'Song (Vocals).mp3', url: '/vocals.mp3' },
      { name: 'Song (Instrumental).mp3', url: '/instrumental.mp3' },
    ],
    lyrics: [],
    covers: [],
    master: null,
  };

  beforeEach(async () => {
    addProcessedTrack = vi.fn(() => of({ item: { task_id: 'queued-song' } }));
    clearAllQueue = vi.fn(() =>
      of([{ message: 'karaoke cleared' }, { message: 'processing cleared' }]),
    );
    selectSong = vi.fn();
    await TestBed.configureTestingModule({
      imports: [Library],
      providers: [
        { provide: QueueService, useValue: { addProcessedTrack, clearAllQueue } },
        {
          provide: SongsService,
          useValue: {
            listSongs: () => of([song]),
            selectSong,
            currentSong: () => null,
            currentQueueTaskId: () => 'current-task',
          },
        },
        provideRouter([]),
      ],
    }).compileComponents();

    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    fixture = TestBed.createComponent(Library);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('clears the queues, then enqueues and plays a clicked library song', () => {
    component.playSong(song);

    expect(clearAllQueue).toHaveBeenCalledOnce();
    expect(addProcessedTrack).toHaveBeenCalledWith(song);
    expect(selectSong).toHaveBeenCalledWith(song, true, 'queued-song');
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('adds a processed song to the front for Play Next', () => {
    component.playNext(song);

    expect(addProcessedTrack).toHaveBeenCalledWith(song, true, 'current-task');
    expect(clearAllQueue).not.toHaveBeenCalled();
  });
});
