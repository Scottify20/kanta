import { Component, input, output, signal } from '@angular/core';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import {
  LucideChevronDown,
  LucideFilePlus,
  LucideFolderPlus,
  LucidePause,
  LucidePlay,
  LucideTrash2,
} from '@lucide/angular';

import { Tooltip } from '../../../../../shared/directives/tooltip';
import { QueueItem } from '../../../interfaces/queue.models';
import { QueueTrackSummary } from '../../queue-track-summary/queue-track-summary';
import { QueueItemActions } from '../../queue-item-actions/queue-item-actions';

@Component({
  selector: 'app-processing-queue-section',
  imports: [
    QueueTrackSummary,
    QueueItemActions,
    Tooltip,
    LucideChevronDown,
    LucideFilePlus,
    LucideFolderPlus,
    LucidePause,
    LucidePlay,
    LucideTrash2,
    DragDropModule,
    ScrollingModule,
  ],
  templateUrl: './processing-queue-section.html',
  styleUrl: './processing-queue-section.scss',
})
export class ProcessingQueueSection {
  readonly items = input.required<QueueItem[]>();
  readonly paused = input(false);
  readonly collapsed = input(false);

  readonly toggleCollapse = output<void>();
  readonly togglePause = output<void>();
  readonly clear = output<void>();
  readonly browseFiles = output<void>();
  readonly browseFolder = output<void>();
  readonly pause = output<QueueItem>();
  readonly resume = output<QueueItem>();
  readonly remove = output<QueueItem>();
  readonly reordered = output<string[]>();
  readonly droppedFiles = output<File[]>();

  readonly isOver = signal(false);

  canSortProcessing = (index: number): boolean => this.items()[index]?.status === 'pending';

  canDragProcessing(item: QueueItem): boolean {
    return item.status === 'pending' && !item.task_id.startsWith('upload:');
  }

  isUpload(item: QueueItem): boolean {
    return item.task_id.startsWith('upload:');
  }

  onDrop(event: CdkDragDrop<QueueItem[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    const view = [...this.items()];
    moveItemInArray(view, event.previousIndex, event.currentIndex);
    this.reordered.emit(
      view.filter((item) => !this.isUpload(item)).map((item) => item.task_id),
    );
  }

  onDragOver(event: DragEvent): void {
    if (!(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    this.isOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    const area = event.currentTarget as HTMLElement;
    if (!area.contains(event.relatedTarget as Node | null)) {
      this.isOver.set(false);
    }
  }

  onDropFiles(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isOver.set(false);
    if (event.dataTransfer?.files?.length) {
      this.droppedFiles.emit(Array.from(event.dataTransfer.files));
    }
  }
}