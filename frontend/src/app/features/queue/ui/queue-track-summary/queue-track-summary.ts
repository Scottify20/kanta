import { Component, computed, input } from '@angular/core';
import { QueueItem } from '../../interfaces/queue.models';

@Component({
  selector: 'app-queue-track-summary',
  templateUrl: './queue-track-summary.html',
  styleUrl: './queue-track-summary.scss',
})
export class QueueTrackSummary {
  readonly item = input.required<QueueItem>();
  readonly variant = input<'karaoke' | 'processing'>('karaoke');

  readonly lyricsLevelLabel = computed(() => {
    switch (this.item().lyrics_level) {
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
