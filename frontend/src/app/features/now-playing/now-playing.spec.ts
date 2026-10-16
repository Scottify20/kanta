import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { QueueItem } from '../queue/interfaces/queue.models';
import { SongsService } from '../../shared/services/songs.service';
import { NowPlaying } from './now-playing';

describe('NowPlaying', () => {
  let component: NowPlaying;
  let fixture: ComponentFixture<NowPlaying>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NowPlaying],
    }).compileComponents();

    fixture = TestBed.createComponent(NowPlaying);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('pauses playback and reports status for a karaoke task still processing', () => {
    const track: QueueItem = {
      task_id: 'karaoke-task',
      file_path: '/tmp/song.mp3',
      raw_title: 'Song',
      raw_artist: 'Artist',
      raw_album: 'Album',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      priority: 1,
      status: 'processing',
      progress: 35,
      step: 'Separating vocals',
      position: 0,
    };
    component.audioPlayer.isPlaying.set(true);

    component.selectTrack(track);

    expect(component.audioPlayer.isPlaying()).toBe(false);
    expect(component.selectedTrackProcessing()).toBe(true);
    expect(component.selectedTrack()?.task_id).toBe(track.task_id);
  });

  it('does not select a processing-only task for playback', () => {
    const track = {
      task_id: 'processing-task',
      priority: 2,
      status: 'processing',
    } as QueueItem;

    component.selectTrack(track);

    expect(component.selectedTrack()).toBeNull();
  });

  it('shows the next three eligible Karaoke Queue items in playback order', () => {
    const track = (taskId: string, status: QueueItem['status']): QueueItem => ({
      task_id: taskId,
      file_path: `/tmp/${taskId}.mp3`,
      raw_title: taskId,
      raw_artist: 'Artist',
      raw_album: 'Album',
      title: taskId,
      artist: 'Artist',
      album: 'Album',
      priority: 1,
      status,
      progress: 0,
      step: 'Queued',
      position: 0,
    });

    component.selectedTrack.set(track('current', 'completed'));
    component.queueSnapshot.set({
      karaoke_queue: [
        track('previous', 'completed'),
        track('current', 'completed'),
        track('next-ready', 'completed'),
        track('failed', 'failed'),
        track('next-running', 'processing'),
        track('next-paused', 'paused'),
        track('beyond-preview', 'pending'),
      ],
      processing_queue: [track('unrelated-job', 'processing')],
      current_task: track('unrelated-job', 'processing'),
    });

    expect(component.queuePreview().map((item) => item.task_id)).toEqual([
      'next-ready',
      'next-running',
      'next-paused',
    ]);
  });

  it('applies the lyrics timing offset to highlighting and lyric-click seeking', () => {
    component.lyricsOffsetMs.set(250);
    component.audioPlayer.currentTime.set(3);
    component.audioPlayer.duration.set(10);

    expect(component.lyricsTimeSeconds()).toBe(2.75);

    component.onLyricClick(4);

    expect(component.audioPlayer.currentTime()).toBe(4.25);
  });

  it('pauses while dragging the timeline and resumes only on release', () => {
    const track = {
      getBoundingClientRect: () => ({ left: 0, width: 100 }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    } as unknown as HTMLElement;
    const pointer = (clientX: number): PointerEvent =>
      ({
        button: 0,
        clientX,
        currentTarget: track,
        pointerId: 7,
        preventDefault: vi.fn(),
      }) as unknown as PointerEvent;
    const play = vi.spyOn(component.audioPlayer, 'play').mockResolvedValue();
    component.audioPlayer.duration.set(100);
    component.audioPlayer.isPlaying.set(true);

    component.startSeek(pointer(20));

    expect(component.audioPlayer.isPlaying()).toBe(false);
    expect(component.audioPlayer.currentTime()).toBe(20);
    component.updateSeek(pointer(60));
    expect(component.audioPlayer.currentTime()).toBe(60);
    expect(play).not.toHaveBeenCalled();

    component.finishSeek(pointer(80));

    expect(component.audioPlayer.currentTime()).toBe(80);
    expect(play).toHaveBeenCalledOnce();
  });

  it('restores the selected song metadata and cover after route recreation', () => {
    const song = {
      artist: 'Artist',
      album: 'Album',
      title: 'Song',
      stems: [],
      lyrics: [],
      covers: [{ name: 'cover.jpg', url: '/media/cover.jpg' }],
      master: null,
    };
    TestBed.inject(SongsService).setNowPlaying(song);
    fixture.destroy();

    fixture = TestBed.createComponent(NowPlaying);
    component = fixture.componentInstance;

    expect(component.selectedManifest()).toEqual(song);
    expect(component.coverUrl()).toBe('/media/cover.jpg');
  });
});
