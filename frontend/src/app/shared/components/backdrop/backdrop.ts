import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import { QueueService } from '../../../features/queue/data-access/queue.service';
import { SongsService } from '../../services/songs.service';

@Component({
  selector: 'app-backdrop',
  template: `
    @for (layer of layers(); track layer.url) {
      <div class="layer" [style.background-image]="'url(' + layer.url + ')'"></div>
    }
    <div class="scrim"></div>
  `,
  styleUrl: './backdrop.scss',
})
export class Backdrop {
  private readonly songs = inject(SongsService);
  private readonly snapshot = toSignal(inject(QueueService).queue$);

  readonly coverUrl = computed(() => {
    const queue = this.snapshot()?.karaoke_queue ?? [];
    if (!queue.length) return null;
    const taskId = this.songs.currentQueueTaskId();
    const current = queue.find((item) => item.task_id === taskId);
    return (
      this.songs.currentSong()?.covers[0]?.url ??
      current?.cover_url ??
      queue.find((item) => item.cover_url)?.cover_url ??
      null
    );
  });

  readonly layers = computed(() => {
    const url = this.coverUrl();
    return url ? [{ url }] : [];
  });
}
