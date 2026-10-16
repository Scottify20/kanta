import { Component, OnDestroy, computed, effect, inject, signal, untracked, DOCUMENT, HostListener } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import {
  LucideChevronLeft,
  LucideChevronRight,
  LucideListMusic,
  LucideMaximize,
  LucideMinimize,
  LucideMenu,
  LucidePause,
  LucidePlay,
  LucideStar,
} from '@lucide/angular';
import { SearchBar } from '../../shared/components/search-bar/search-bar';
import { LyricsStage } from './ui/lyrics-stage/lyrics-stage';
import { LyricsTimingControl } from './ui/lyrics-timing-control/lyrics-timing-control';
import { StemVolumeControl } from './ui/stem-volume-control/stem-volume-control';
import { AudioPlayerService } from '../../shared/services/audio-player.service';
import { Tooltip } from '../../shared/directives/tooltip';
import { FullscreenService } from '../../shared/services/fullscreen.service';
import { LyricsService } from '../../shared/services/lyrics';
import { QueueItem, QueueSnapshot } from '../queue/interfaces/queue.models';
import { QueueService } from '../queue/data-access/queue.service';
import { SongManifest, SongsService } from '../../shared/services/songs.service';
import { LayoutService } from '../../shared/services/layout.service';
import { PopupStateService } from '../../shared/services/popup-state.service';

@Component({
  selector: 'app-now-playing',
  imports: [
    Tooltip,
    LyricsStage,
    SearchBar,
    LyricsTimingControl,
    StemVolumeControl,
    LucideChevronLeft,
    LucideChevronRight,
    LucideListMusic,
    LucideMaximize,
    LucideMinimize,
    LucideMenu,
    LucidePause,
    LucidePlay,
    LucideStar,
  ],
  templateUrl: './ui/now-playing.html',
  styleUrl: './ui/now-playing.scss',
})
export class NowPlaying implements OnDestroy {
  readonly lyricsService = inject(LyricsService);
  readonly audioPlayer = inject(AudioPlayerService);
  private readonly queueService = inject(QueueService);
  private readonly songsService = inject(SongsService);
  private readonly popupState = inject(PopupStateService);
  private pointerInsideTrackArea = false;
  private readonly fullscreen = inject(FullscreenService);
  private readonly document = inject(DOCUMENT);
  readonly layout = inject(LayoutService);
  readonly lyricsOffsetMs = signal(0);
  readonly selectedTrack = signal<QueueItem | null>(null);

  // Controls the collapsed state of the track-area in fullscreen mode
  readonly trackAreaCollapsed = signal(false);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  readonly selectedTrackProcessing = computed(() => {
    const status = this.selectedTrack()?.status;
    return (
      status === 'pending' ||
      status === 'processing' ||
      status === 'paused' ||
      status === 'cancelling'
    );
  });
  readonly selectedTrackPaused = computed(
    () =>
      this.selectedTrack()?.status === 'paused' ||
      (this.selectedTrackProcessing() && this.queueSnapshot().processing_paused === true),
  );
  readonly coverUrl = signal<string | null>(null);
  readonly playbackError = signal('');
  readonly selectedManifest = signal<SongManifest | null>(null);
  readonly lyricsTimeSeconds = computed(() =>
    Math.max(0, this.audioPlayer.currentTime() - this.lyricsOffsetMs() / 1000),
  );
  readonly isSeeking = signal(false);
  readonly queueSnapshot = signal<QueueSnapshot>({
    karaoke_queue: [],
    processing_queue: [],
    current_task: null,
  });
  readonly queuePreview = computed(() => {
    const snapshot = this.queueSnapshot();
    const items = snapshot.karaoke_queue;
    const selectedTaskId = this.selectedTrack()?.task_id;
    const selectedIndex = selectedTaskId
      ? items.findIndex((item) => item.task_id === selectedTaskId)
      : -1;
    return items
      .slice(selectedIndex + 1)
      .filter((item) => !['failed', 'cancelled', 'cancelling'].includes(item.status))
      .slice(0, 3);
  });
  private loadedTaskId: string | null = null;
  private loadedSongKey: string | null = null;
  private queuedAutoplayTaskId: string | null = null;
  private resumeAfterSeek = false;
  private seekPointerId: number | null = null;

  constructor() {
    const savedSong = this.songsService.currentSong();
    if (savedSong) {
      this.restoreCurrentSong(savedSong);
    }

    effect(() => {
      if (this.fullscreen.active()) {
        untracked(() => this.startHideTimer());
      } else {
        untracked(() => {
          this.clearHideTimer();
          this.trackAreaCollapsed.set(false);
        });
      }
    });

    effect(() => {
      // Popups are portaled out of the track area, so resume idle hiding once they close.
      if (!this.popupState.anyOpen() && untracked(() => this.isFullScreen())) {
        untracked(() => this.startHideTimer());
      }
    });

    effect(() => {
      const request = this.songsService.queueTrackRequest();
      if (request) {
        this.songsService.consumeQueueTrackRequest();
        this.selectTrack(request);
      }
    });

    effect(() => {
      const librarySong = this.songsService.selectedSong();
      if (librarySong && this.songsService.playRequested()) {
        this.selectLibrarySong(librarySong, this.songsService.selectedSongQueueTaskId());
        this.songsService.consumePlayRequest();
        void this.togglePlayback();
      }
    });

    this.queueService.queue$.pipe(takeUntilDestroyed()).subscribe((snapshot) => {
      this.queueSnapshot.set(snapshot);
      const current = this.selectedTrack();
      if (!current) {
        const savedTaskId = this.songsService.currentQueueTaskId();
        const savedTrack = savedTaskId
          ? snapshot.karaoke_queue.find((item) => item.task_id === savedTaskId)
          : null;
        if (savedTrack) {
          this.selectedTrack.set(savedTrack);
          this.queuedAutoplayTaskId = savedTrack.status === 'completed' ? null : savedTrack.task_id;
          if (savedTrack.status === 'completed') {
            const song = this.songsService.currentSong();
            if (song && this.sameSong(song, savedTrack)) {
              this.selectedManifest.set(song);
              this.coverUrl.set(song.covers[0]?.url ?? null);
              this.lyricsOffsetMs.set(song.lyrics_offset_ms ?? 0);
            } else {
              void this.loadManifest(savedTrack);
            }
          } else {
            this.audioPlayer.pause();
            this.selectedManifest.set(null);
            this.coverUrl.set(null);
            this.lyricsService.clearLyrics();
          }
        }
        return;
      }
      const updated = snapshot.karaoke_queue.find((item) => item.task_id === current.task_id);
      if (!updated) {
        if (this.selectedTrackProcessing()) {
          this.audioPlayer.pause();
          this.lyricsService.clearLyrics();
          this.selectedTrack.set(null);
          this.selectedManifest.set(null);
          this.coverUrl.set(null);
          this.queuedAutoplayTaskId = null;
          this.songsService.setNowPlaying(null);
        }
        return;
      }
      this.selectedTrack.set(updated);
      if (updated.status !== 'completed') {
        this.audioPlayer.pause();
        if (this.selectedManifest()) {
          this.lyricsService.clearLyrics();
        }
        this.selectedManifest.set(null);
        this.coverUrl.set(null);
        this.loadedSongKey = null;
        if (['failed', 'cancelled', 'cancelling'].includes(updated.status)) {
          this.queuedAutoplayTaskId = null;
        }
        return;
      }
      if (this.queuedAutoplayTaskId === updated.task_id) {
        void this.playQueueItem(updated);
      }
    });

    this.queueService.karaokeRemoved$.pipe(takeUntilDestroyed()).subscribe((taskId) => {
      if (taskId !== null && taskId !== this.selectedTrack()?.task_id) return;
      this.stopPlayback();
    });

    this.audioPlayer.trackEnded.pipe(takeUntilDestroyed()).subscribe(() => {
      void this.playNext();
    });
  }

  isFullScreen(): boolean {
    return this.fullscreen.active();
  }

  toggleFullScreen(): Promise<void> {
    return this.fullscreen.toggle();
  }

  @HostListener('document:keydown', ['$event'])
  onShortcut(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const isToggle = event.key === 'F11' || (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing);
    if (!isToggle || event.repeat) return;
    event.preventDefault();
    void this.fullscreen.toggle();
  }

  ngOnDestroy(): void {
    void this.fullscreen.exit();
    this.clearHideTimer();
  }

  onTrackAreaMouseEnter(): void {
    this.pointerInsideTrackArea = true;
    if (!this.trackAreaCollapsed()) this.clearHideTimer();
  }

  // Controls only re-appear while hovering (or focusing) the timeline.
  revealTrackArea(): void {
    if (!this.isFullScreen()) return;
    this.clearHideTimer();
    this.trackAreaCollapsed.set(false);
  }

  onTrackAreaMouseLeave(): void {
    this.pointerInsideTrackArea = false;
    if (!this.isFullScreen() || this.isSeeking()) return;
    this.startHideTimer();
  }

  private startHideTimer(): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      if (this.isFullScreen() && !this.isSeeking() && !this.popupState.anyOpen()) {
        this.trackAreaCollapsed.set(true);
      }
    }, 3000);
  }

  private clearHideTimer(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  startSeek(event: PointerEvent): void {
    if (event.button !== 0 || !this.audioPlayer.duration()) return;
    event.preventDefault();
    this.clearHideTimer();
    this.resumeAfterSeek = this.audioPlayer.isPlaying();
    this.audioPlayer.pause();
    this.isSeeking.set(true);
    this.seekPointerId = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.updateSeek(event);
  }

  updateSeek(event: PointerEvent): void {
    if (!this.isSeeking() || this.seekPointerId !== event.pointerId) return;
    this.audioPlayer.seek(this.timeAtPointer(event));
  }

  finishSeek(event: PointerEvent): void {
    if (!this.isSeeking() || this.seekPointerId !== event.pointerId) return;
    this.updateSeek(event);
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    this.seekPointerId = null;
    this.isSeeking.set(false);

    if (this.isFullScreen()) {
      this.startHideTimer();
    }

    if (this.resumeAfterSeek) {
      this.resumeAfterSeek = false;
      void this.audioPlayer.play().catch(() => {
        this.playbackError.set('Could not resume playback after seeking.');
      });
    }
  }

  seekByKeyboard(event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 5;
    let time: number | null = null;
    if (event.key === 'ArrowLeft') time = this.audioPlayer.currentTime() - step;
    if (event.key === 'ArrowRight') time = this.audioPlayer.currentTime() + step;
    if (event.key === 'Home') time = 0;
    if (event.key === 'End') time = this.audioPlayer.duration();
    if (time === null) return;
    event.preventDefault();
    this.audioPlayer.seek(time);

    if (this.isFullScreen()) {
      this.startHideTimer();
    }
  }

  timelineProgressPercent(): number {
    const duration = this.audioPlayer.duration();
    return duration ? (this.audioPlayer.currentTime() / duration) * 100 : 0;
  }

  private timeAtPointer(event: PointerEvent): number {
    const track = event.currentTarget as HTMLElement;
    const bounds = track.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    return progress * this.audioPlayer.duration();
  }

  onLyricClick(event: any): void {
    let rawTime: number | null = null;

    // 1. Handle direct number emission
    if (typeof event === 'number') {
      rawTime = event;
    }
    // 2. Handle standard DOM Events (Mouse Clicks)
    else if (event instanceof Event) {
      // Only read event.detail if it's a true CustomEvent, avoiding the MouseEvent.detail click-count bug
      if (event instanceof CustomEvent && event.detail !== undefined) {
        if (typeof event.detail === 'number') {
          rawTime = event.detail;
        } else if (event.detail.time !== undefined) {
          rawTime = parseFloat(event.detail.time);
        }
      }

      // If no custom event payload, traverse the DOM to find the time attribute
      if (rawTime === null) {
        const path = (event.composedPath && event.composedPath()) || [];

        if (path.length > 0) {
          for (const el of path) {
            if (el instanceof HTMLElement) {
              const timeAttr =
                el.getAttribute('time') ??
                el.getAttribute('data-time') ??
                el.getAttribute('data-timestamp') ??
                el.getAttribute('data-start');

              if (timeAttr !== null) {
                rawTime = parseFloat(timeAttr);
                break;
              }
            }
          }
        }
        // Absolute fallback for older Light DOM without composedPath
        else if (event.target instanceof HTMLElement) {
          const lineEl = event.target.closest(
            '[time], [data-time], [data-timestamp], [data-start]',
          );
          if (lineEl) {
            const timeAttr =
              lineEl.getAttribute('time') ??
              lineEl.getAttribute('data-time') ??
              lineEl.getAttribute('data-timestamp') ??
              lineEl.getAttribute('data-start');

            if (timeAttr !== null) rawTime = parseFloat(timeAttr);
          }
        }
      }
    }
    // 3. Handle raw object payload emissions
    else if (event && event.time !== undefined) {
      rawTime = typeof event.time === 'number' ? event.time : parseFloat(event.time);
    }

    // Abort if we failed to find a valid time
    if (rawTime === null || isNaN(rawTime)) return;

    this.audioPlayer.seek(rawTime + this.lyricsOffsetMs() / 1000);
    this.audioPlayer.play().catch(() => {
      this.playbackError.set('An error occurred.');
    });
  }

  readonly currentQueueIndex = computed(() => {
    const items = this.queueItems();
    const taskId = this.selectedTrack()?.task_id ?? this.songsService.currentQueueTaskId();
    const song = this.selectedManifest();
    return items.findIndex((item) =>
      taskId ? item.task_id === taskId : !!song && this.sameSong(song, item),
    );
  });
  readonly hasPrevious = computed(() => this.currentQueueIndex() > 0 || this.audioPlayer.currentTime() > 3);
  // Next is only available once the upcoming track has finished processing.
  readonly hasNext = computed(() => {
    const items = this.queueItems();
    const index = this.currentQueueIndex();
    const upcoming = items[index < 0 ? 0 : index + 1];
    return !!upcoming && upcoming.status === 'completed';
  });

  async playPrevious(): Promise<void> {
    // Like most players: restart the song first, go to the previous item when near the start.
    if (this.audioPlayer.currentTime() > 3 || this.currentQueueIndex() <= 0) {
      if (this.selectedManifest()) this.audioPlayer.seek(0);
      return;
    }
    await this.playRelative(-1);
  }

  async playNext(): Promise<void> {
    if (!this.hasNext()) {
      // Reaching the true end of the queue stops playback; a still-processing next track does nothing.
      const items = this.queueItems();
      if (this.currentQueueIndex() >= items.length - 1) {
        this.audioPlayer.pause();
        this.audioPlayer.seek(0);
      }
      return;
    }
    await this.playRelative(1);
  }

  private stopPlayback(): void {
    this.audioPlayer.release();
    this.lyricsService.clearLyrics();
    this.selectedTrack.set(null);
    this.selectedManifest.set(null);
    this.coverUrl.set(null);
    this.loadedSongKey = null;
    this.loadedTaskId = null;
    this.queuedAutoplayTaskId = null;
    this.songsService.setNowPlaying(null);
  }

  // Offsets may shift lyrics by up to half of the song's length.
  readonly maxOffsetMs = computed(() => {
    const duration = this.audioPlayer.duration();
    return duration > 0 ? Math.round(duration * 500) : 10_000;
  });

  private clampOffset(ms: number): number {
    const max = this.maxOffsetMs();
    return Math.max(-max, Math.min(max, ms));
  }

  updateLyricsOffset(seconds: number): void {
    if (Number.isFinite(seconds)) {
      this.lyricsOffsetMs.set(this.clampOffset(Math.round(seconds * 1000)));
    }
  }

  adjustLyricsOffset(seconds: number): void {
    const nextOffset = this.lyricsOffsetMs() + seconds * 1000;
    this.lyricsOffsetMs.set(this.clampOffset(nextOffset));
    this.saveLyricsOffset();
  }

  saveLyricsOffset(): void {
    const song = this.selectedManifest();
    if (!song) return;
    this.songsService.saveLyricsTiming(song, this.lyricsOffsetMs()).subscribe({
      next: ({ offset_ms }) => {
        this.lyricsOffsetMs.set(offset_ms);
        this.selectedManifest.update((manifest) =>
          manifest ? { ...manifest, lyrics_offset_ms: offset_ms } : null,
        );
      },
      error: () => this.playbackError.set('Could not save lyrics timing.'),
    });
  }

  resetLyricsOffset(): void {
    this.lyricsOffsetMs.set(0);
    this.saveLyricsOffset();
  }

  selectTrack(track: QueueItem): void {
    if (track.priority !== 1 || ['failed', 'cancelled', 'cancelling'].includes(track.status)) {
      return;
    }
    this.playbackError.set('');
    void this.playQueueItem(track);
  }

  private async playRelative(direction: -1 | 1): Promise<void> {
    const items = this.queueItems();
    const index = this.currentQueueIndex();
    const target = items[index < 0 ? (direction > 0 ? 0 : items.length - 1) : index + direction];
    if (target) await this.playQueueItem(target);
  }

  private queueItems(): QueueItem[] {
    const snapshot = this.queueSnapshot();
    const items = snapshot.karaoke_queue.filter(
      (item) => !['failed', 'cancelled', 'cancelling'].includes(item.status),
    );
    return items.filter(
      (item, index, all) =>
        all.findIndex((candidate) => candidate.task_id === item.task_id) === index,
    );
  }

  private async playQueueItem(track: QueueItem): Promise<void> {
    this.audioPlayer.pause();
    this.lyricsService.clearLyrics();
    this.selectedTrack.set(track);
    this.songsService.setNowPlaying(null, track.task_id);
    this.selectedManifest.set(null);
    this.coverUrl.set(null);
    this.loadedSongKey = null;
    if (track.status !== 'completed') {
      this.queuedAutoplayTaskId = track.task_id;
      this.lyricsService.clearLyrics();
      return;
    }
    this.queuedAutoplayTaskId = null;
    const manifest = await this.loadManifest(track);
    if (manifest) {
      await this.togglePlayback();
    }
  }

  playLibrarySong(song: SongManifest): void {
    this.selectLibrarySong(song);
    void this.togglePlayback();
  }

  private selectLibrarySong(song: SongManifest, queueTaskId: string | null = null): void {
    this.audioPlayer.pause();
    this.lyricsService.clearLyrics();
    this.selectedTrack.set(
      queueTaskId
        ? (this.queueSnapshot().karaoke_queue.find((item) => item.task_id === queueTaskId) ?? null)
        : null,
    );
    this.selectedManifest.set(song);
    this.songsService.setNowPlaying(song, queueTaskId);
    this.lyricsOffsetMs.set(song.lyrics_offset_ms ?? 0);
    this.coverUrl.set(song.covers[0]?.url ?? null);
    this.loadedTaskId = null;
    this.loadedSongKey = null;
    this.queuedAutoplayTaskId = null;
    this.playbackError.set('');
    void this.loadLyrics(song);
  }

  async togglePlayback(): Promise<void> {
    if (this.audioPlayer.isPlaying()) {
      this.audioPlayer.pause();
      return;
    }

    const manifest = this.selectedManifest();
    if (this.selectedTrackProcessing()) {
      this.audioPlayer.pause();
      return;
    }
    if (!manifest) {
      this.playbackError.set('Add a song to the queue before starting playback.');
      return;
    }

    try {
      const songKey = `${manifest.artist}/${manifest.album}/${manifest.title}`;
      if (this.loadedSongKey !== songKey) {
        const vocals = manifest.stems.find((file) => file.name.toLowerCase().includes('vocals'));
        const instrumental = manifest.stems.find((file) =>
          file.name.toLowerCase().includes('instrumental'),
        );
        if (!vocals || !instrumental) {
          throw new Error('This processed song is missing playback stems.');
        }
        await this.audioPlayer.loadStems({
          vocals: vocals.url,
          instrumental: instrumental.url,
          replayGain: {
            trackGain: manifest.replaygain_track_gain,
            trackPeak: manifest.replaygain_track_peak,
            albumGain: manifest.replaygain_album_gain,
            albumPeak: manifest.replaygain_album_peak,
          },
        });
        this.loadedSongKey = songKey;
      }
      this.playbackError.set('');
      await this.audioPlayer.play();
    } catch (error) {
      this.playbackError.set(error instanceof Error ? error.message : 'Could not load this song.');
    }
  }

  private async loadManifest(track: QueueItem): Promise<SongManifest | null> {
    try {
      const manifest = await firstValueFrom(
        this.songsService.getManifest(track.artist, track.album, track.title),
      );
      this.selectedManifest.set(manifest);
      this.songsService.setNowPlaying(manifest, track.task_id);
      this.coverUrl.set(manifest.covers[0]?.url ?? null);
      this.lyricsOffsetMs.set(manifest.lyrics_offset_ms ?? 0);
      this.loadedTaskId = null;
      this.loadedSongKey = null;
      await this.loadLyrics(manifest);
      return manifest;
    } catch (error) {
      this.playbackError.set(error instanceof Error ? error.message : 'Could not load this song.');
      return null;
    }
  }

  private async loadLyrics(song: SongManifest): Promise<void> {
    this.lyricsService.lyrics.set(null);
    this.lyricsService.lyricsLevel.set('none');
    const wordLyrics = song.lyrics.find(
      (file) => file.level === 'word' || (!file.level && file.name.toLowerCase().endsWith('.ttml')),
    );
    if (wordLyrics) {
      await this.lyricsService.loadStoredLyrics(wordLyrics.url, 'word');
      return;
    }

    const lineLyrics = song.lyrics.find(
      (file) => file.level === 'line' || file.name.toLowerCase().endsWith('.lrc'),
    );
    const loadedLineLyrics = lineLyrics
      ? await this.lyricsService.loadStoredLyrics(lineLyrics.url, 'line')
      : false;
    await this.lyricsService.fetchLyrics(
      {
        artistName: song.artist,
        albumName: song.album,
        trackName: song.title,
      },
      loadedLineLyrics,
    );
  }

  private restoreCurrentSong(song: SongManifest): void {
    this.selectedTrack.set(null);
    this.selectedManifest.set(song);
    this.coverUrl.set(song.covers[0]?.url ?? null);
    this.lyricsOffsetMs.set(song.lyrics_offset_ms ?? 0);
  }

  private sameSong(song: SongManifest, track: QueueItem): boolean {
    return song.artist === track.artist && song.album === track.album && song.title === track.title;
  }

  formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0');
    const remainingSeconds = Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0');
    return `${minutes}:${remainingSeconds}`;
  }
}
