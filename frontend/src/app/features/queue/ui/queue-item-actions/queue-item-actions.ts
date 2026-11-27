import { Component, inject, input, output, viewChild } from '@angular/core';
import { LucideMoreHorizontal, LucidePause, LucidePlay } from '@lucide/angular';

import { ContextMenu } from '../../../../shared/components/context-menu/context-menu';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { PopupStateService } from '../../../../shared/services/popup-state.service';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { QueueItem } from '../../interfaces/queue.models';

@Component({
  selector: 'app-queue-item-actions',
  imports: [PopupPanel, Tooltip, ContextMenu, LucideMoreHorizontal, LucidePause, LucidePlay],
  templateUrl: './queue-item-actions.html',
  styleUrl: './queue-item-actions.scss',
})
export class QueueItemActions {
  readonly item = input.required<QueueItem>();
  readonly queue = input.required<'karaoke_queue' | 'processing_queue'>();
  readonly current = input(false);
  readonly playbackActive = input(false);
  readonly selectedCount = input<number>(0);

  private readonly popups = inject(PopupStateService);

  readonly pause = output<void>();
  readonly resume = output<void>();
  readonly remove = output<void>();
  readonly select = output<void>();
  readonly batchRemove = output<void>();

  private readonly popup = viewChild.required(PopupPanel);

  openAt(event: MouseEvent): void {
    this.popup().openAt(event);
  }

  assignSingers(): void {
    this.popups.open('queue-party', `queue-singers:${this.item().task_id}`);
  }
}