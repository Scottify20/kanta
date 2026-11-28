import { Component, computed, inject, input, output } from '@angular/core';
import { LibraryService, songKey } from '../../../../shared/services/library.service';
import { LyricsService } from '../../../../shared/services/lyrics';
import { SongsService, LyricsLevel } from '../../../../shared/services/songs.service';
import { sizedImageUrl } from '../../../../shared/util/image-url';
import { QueueItem } from '../../interfaces/queue.models';
import { QueuePartyControls } from './queue-party-controls';

@Component({
  selector: 'app-queue-track-summary',
  imports: [QueuePartyControls],
  templateUrl: './queue-track-summary.html',
  styleUrl: './queue-track-summary.scss',
})
export class QueueTrackSummary {
  readonly item = input.required<QueueItem>();
  readonly variant = input<'karaoke' | 'processing'>('karaoke');
  readonly duetPrompt = input(false);
  readonly duetPromptHandled = output<void>();

  private readonly library = inject(LibraryService);
  private readonly lyrics = inject(LyricsService);
  private readonly songs = inject(SongsService);

  readonly coverSrc = computed(() => sizedImageUrl(this.item().cover_url, 128));

  // Prefer the server value, then the library listing, then what the player actually loaded.
  readonly lyricsLevel = computed<LyricsLevel>(() => {
    const item = this.item();
    const own = item.lyrics_level;
    if (own && own !== 'none') return own;
    const fromLibrary = this.library.songByKey().get(songKey(item))?.lyrics_level;
    if (fromLibrary && fromLibrary !== 'none') return fromLibrary;
    if (item.task_id === this.songs.currentQueueTaskId()) return this.lyrics.lyricsLevel();
    return 'none';
  });

  readonly isDuet = computed(() => {
    const item = this.item();
    if (item.is_duet === true) return true;
    const song = this.library.songByKey().get(songKey(item));
    if (song?.is_duet === true) return true;
    if (item.is_duet === false || song?.is_duet === false) return false;
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