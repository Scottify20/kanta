import { Component, inject, input, output, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LucideMoreHorizontal, LucidePause, LucidePlay } from '@lucide/angular';

import { ContextMenu } from '../../../../shared/components/context-menu/context-menu';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { EntryActionsService } from '../../../../shared/services/entry-actions.service';
import { LibraryService, songKey } from '../../../../shared/services/library.service';
import { SongsService } from '../../../../shared/services/songs.service';
import { ToastService } from '../../../../shared/services/toast.service';
import { QueueItem } from '../../interfaces/queue.models';

@Component({
  selector: 'app-queue-item-actions',
  imports: [
    PopupPanel,
    Tooltip,
    ContextMenu,
    LucideMoreHorizontal,
    LucidePause,
    LucidePlay,
  ],
  templateUrl: './queue-item-actions.html',
  styleUrl: './queue-item-actions.scss',
})
export class QueueItemActions {
  readonly item = input.required<QueueItem>();
  readonly queue = input.required<'karaoke_queue' | 'processing_queue'>();
  readonly current = input(false);
  readonly playbackActive = input(false);
  readonly selectedCount = input<number>(0);
  readonly isFirst = input(false);
  readonly isLast = input(false);

  readonly pause = output<void>();
  readonly resume = output<void>();
  readonly remove = output<void>();
  readonly select = output<void>();
  readonly moveUp = output<void>();
  readonly moveDown = output<void>();
  readonly batchRemove = output<void>();

  private readonly popup = viewChild.required(PopupPanel);
  private readonly library = inject(LibraryService);
  private readonly songs = inject(SongsService);
  private readonly entryActions = inject(EntryActionsService);
  private readonly toast = inject(ToastService);

  openAt(event: MouseEvent): void {
    this.popup().openAt(event);
  }

  async editMetadata(): Promise<void> {
    const item = this.item();
    if (item.status !== 'completed') return;
    const cached = this.library.songByKey().get(songKey(item));
    if (cached) {
      this.entryActions.editingSong.set(cached);
      return;
    }
    try {
      const manifest = await firstValueFrom(
        this.songs.getManifest(item.artist, item.album, item.title),
      );
      this.entryActions.editingSong.set(manifest);
    } catch (error) {
      console.error('Could not load song metadata for editing:', error);
      this.toast.error('Could not open metadata editor for this song.');
    }
  }
}