import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { QueueService } from '../../data-access/queue.service';
import { QueueItem, QueueSnapshot } from '../../interfaces/queue.models';
import { QueueSheet } from './queue-sheet';

describe('QueueSheet', () => {
  let fixture: ComponentFixture<QueueSheet>;
  let component: QueueSheet;
  let addedSongs: Array<Pick<QueueItem, 'artist' | 'album' | 'title'>>;

  const queueItem = (
    taskId: string,
    priority: QueueItem['priority'],
    coverUrl: string | null,
  ): QueueItem => ({
    task_id: taskId,
    file_path: `/tmp/${taskId}.mp3`,
    raw_title: taskId,
    raw_artist: 'Artist',
    raw_album: 'Album',
    title: taskId,
    artist: 'Artist',
    album: 'Album',
    priority,
    status: 'pending',
    progress: 0,
    step: 'Queued',
    position: 0,
    cover_url: coverUrl,
  });

  const queueSnapshot: QueueSnapshot = {
    karaoke_queue: [
      queueItem('karaoke', 1, '/media/cover.jpg'),
      queueItem('karaoke-no-cover', 1, null),
    ],
    processing_queue: [queueItem('processing', 2, '/media/processing-cover.jpg')],
    current_task: null,
  };

  beforeEach(async () => {
    addedSongs = [];
    await TestBed.configureTestingModule({
      imports: [QueueSheet],
      providers: [
        {
          provide: QueueService,
          useValue: {
            queue$: of(queueSnapshot),
            addProcessedTrack: (song: Pick<QueueItem, 'artist' | 'album' | 'title'>) => {
              addedSongs.push(song);
              return of({ item: {} as QueueItem });
            },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QueueSheet);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('hides Processing Queue before opening for a processed-song drag', () => {
    fixture.componentRef.setInput('processedItemDrag', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.queue-section').length).toBe(1);
  });

  it('shows an available album cover in both queue lists', () => {
    const sections = fixture.nativeElement.querySelectorAll('.queue-section');
    const karaokeCover = sections[0].querySelector('img.cover-image') as HTMLImageElement;
    const processingCover = sections[1].querySelector('img.cover-image') as HTMLImageElement;

    expect(karaokeCover.getAttribute('src')).toBe('/media/cover.jpg');
    expect(karaokeCover.getAttribute('alt')).toBe('Album cover for Album');
    expect(processingCover.getAttribute('src')).toBe('/media/processing-cover.jpg');
    expect(sections[0].querySelector('span.cover-placeholder')).not.toBeNull();
  });

  it('animates the current-track wave only while audio is playing', () => {
    fixture.componentRef.setInput('activeTaskId', 'karaoke');
    fixture.componentRef.setInput('playbackActive', true);
    fixture.detectChanges();

    const wave = fixture.nativeElement.querySelector('.now-playing-wave') as HTMLElement;
    expect(wave.classList.contains('is-playing')).toBe(true);

    fixture.componentRef.setInput('playbackActive', false);
    fixture.detectChanges();

    expect(wave.classList.contains('is-playing')).toBe(false);
  });

  it('adds a dropped processed song once without allowing the drop to bubble', () => {
    const song = {
      artist: 'Artist',
      album: 'Album',
      title: 'Song',
      stems: [{ name: 'Song (Vocals).mp3', url: '/vocals.mp3' }],
      lyrics: [],
      covers: [],
      master: null,
    };
    let defaultPrevented = false;
    let propagationStopped = false;
    const event = {
      preventDefault: () => (defaultPrevented = true),
      stopPropagation: () => (propagationStopped = true),
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-kanta-processed' ? JSON.stringify(song) : '',
        files: { length: 0 },
      },
    } as unknown as DragEvent;

    component.dropExternal(event, 'karaoke_queue');

    expect(addedSongs).toHaveLength(1);
    expect(addedSongs[0]).toMatchObject({ artist: 'Artist', album: 'Album', title: 'Song' });
    expect(defaultPrevented).toBe(true);
    expect(propagationStopped).toBe(true);
  });
});
