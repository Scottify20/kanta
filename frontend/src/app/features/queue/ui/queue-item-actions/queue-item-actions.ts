import { Component, input, output } from '@angular/core';
import { LucideMoreHorizontal, LucidePause, LucidePlay } from '@lucide/angular';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { QueueItem } from '../../interfaces/queue.models';

@Component({
  selector: 'app-queue-item-actions',
  imports: [PopupPanel, Tooltip, LucideMoreHorizontal, LucidePause, LucidePlay],
  templateUrl: './queue-item-actions.html',
  styleUrl: './queue-item-actions.scss',
})
export class QueueItemActions {
  readonly item = input.required<QueueItem>();
  readonly queue = input.required<'karaoke_queue' | 'processing_queue'>();
  readonly current = input(false);
  readonly playbackActive = input(false);

  readonly pause = output<void>();
  readonly resume = output<void>();
  readonly remove = output<void>();
}
