import { Component, computed, inject, input } from '@angular/core';
import { LibraryService, songKey } from '../../../../shared/services/library.service';
import { LyricsService } from '../../../../shared/services/lyrics';
import { SongsService, LyricsLevel } from '../../../../shared/services/songs.service';
import { QueueItem } from '../../interfaces/queue.models';

@Component({
  selector: 'app-queue-track-summary',
  templateUrl: './queue-track-summary.html',
  styleUrl: './queue-track-summary.scss',
})
export class QueueTrackSummary {
  readonly item = input.required<QueueItem>();
  readonly variant = input<'karaoke' | 'processing'>('karaoke');

  private readonly library = inject(LibraryService);
  private readonly lyrics = inject(LyricsService);
  private readonly songs = inject(SongsService);

  private readonly librarySongs = computed(
    () => new Map(this.library.songs().map((song) => [songKey(song), song])),
  );

  // Prefer the server value, then the library listing, then what the player actually loaded.
  readonly lyricsLevel = computed<LyricsLevel>(() => {
    const item = this.item();
    const own = item.lyrics_level;
    if (own && own !== 'none') return own;
    const fromLibrary = this.librarySongs().get(songKey(item))?.lyrics_level;
    if (fromLibrary && fromLibrary !== 'none') return fromLibrary;
    if (item.task_id === this.songs.currentQueueTaskId()) return this.lyrics.lyricsLevel();
    return 'none';
  });

  readonly isDuet = computed(() => {
    const item = this.item();
    if (item.is_duet !== undefined) return item.is_duet;
    const song = this.librarySongs().get(songKey(item));
    if (song?.is_duet !== undefined) return song.is_duet;
    return item.task_id === this.songs.currentQueueTaskId() &&
      (this.lyrics.lyrics()?.some((line) => line.agent === 'v2' || line.agent === 'v3' || line.agent === 'v1000') ?? false);
  });

  readonly lyricsLevelLabel = computed(() => {
    switch (this.lyricsLevel()) {
      case 'word':
        return 'Word';
      case 'line':
        return 'Line';
      default:
        return 'None';
    }
  });

  readonly subtitle = computed(() => {
    const item = this.item();
    if (this.variant() === 'processing') {
      return `${item.raw_artist} · ${item.priority === 1 ? 'Karaoke stems' : 'Processing only'}`;
    }

    const statusLabel = {
      pending: 'Waiting',
      processing: 'Processing',
      paused: 'Paused',
    }[item.status as 'pending' | 'processing' | 'paused'];
    return statusLabel ? `${item.raw_artist} · ${statusLabel}` : item.raw_artist;
  });
}
