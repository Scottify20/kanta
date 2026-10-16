import { NgFor, NgIf } from '@angular/common';
import { Component, DestroyRef, OnInit, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideChevronDown, LucideMoreHorizontal, LucidePause, LucidePlay } from '@lucide/angular';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { QueueTrackSummary } from '../queue-track-summary/queue-track-summary';
import { LyricsLevel, QueueItem } from '../../interfaces/queue.models';
import { QueueService } from '../../data-access/queue.service';
import { SongManifest } from '../../../../shared/services/songs.service';

type QueueName = 'karaoke_queue' | 'processing_queue';

@Component({
  selector: 'app-queue-sheet',
  standalone: true,
  imports: [
    NgFor,
    NgIf,
    PopupPanel,
    QueueTrackSummary,
    LucideChevronDown,
    LucideMoreHorizontal,
    LucidePause,
    LucidePlay,
    DragDropModule,
  ],
  templateUrl: './queue-sheet.html',
  styleUrl: './queue-sheet.scss',
})
export class QueueSheet implements OnInit {
  private readonly queueService = inject(QueueService);
  private readonly destroyRef = inject(DestroyRef);

  // Absolute locks to ignore incoming delayed server orders
  private isDragging = false;
  private isReordering = false;

  readonly processedDrag = signal(false);
  readonly processedItemDrag = input(false);
  readonly hideProcessingQueue = input(false);
  readonly activeTaskId = input<string | null>(null);
  readonly playbackActive = input(false);

  readonly karaokeCollapsed = signal(false);
  readonly processingCollapsed = signal(false);

  // Standalone properties decoupled from the async pipe
  readonly karaokeItems = signal<QueueItem[]>([]);
  readonly processingItems = signal<QueueItem[]>([]);
  readonly processingPaused = signal(false);

  readonly close = output<void>();
  readonly trackSelected = output<QueueItem>();

  ngOnInit(): void {
    this.queueService.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((snapshot) => {
      this.processingItems.set(snapshot.processing_queue);
      this.processingPaused.set(snapshot.processing_paused ?? false);

      if (this.isDragging || this.isReordering) {
        // DOM IS LOCKED: Ignore all array changes from the server.
        // Only surgically update progress bars for existing items.
        this.karaokeItems.update((items) =>
          items.map((localItem) => {
            const serverMatch = snapshot.karaoke_queue.find(
              (item) => item.task_id === localItem.task_id,
            );
            return serverMatch
              ? { ...localItem, status: serverMatch.status, progress: serverMatch.progress }
              : localItem;
          }),
        );
      } else {
        // DOM IS UNLOCKED: Safe to sync array order with the server.
        const currentItems = this.karaokeItems();
        const currentIds = currentItems.map((item) => item.task_id).join(',');
        const serverIds = snapshot.karaoke_queue.map((i) => i.task_id).join(',');

        if (currentIds !== serverIds) {
          this.karaokeItems.set([...snapshot.karaoke_queue]);
        } else {
          // If order matches exactly, just copy properties so Angular doesn't rebuild DOM
          this.karaokeItems.set(
            currentItems.map((item, index) => ({ ...item, ...snapshot.karaoke_queue[index] })),
          );
        }
      }
    });
  }

  closeSheet(): void {
    this.close.emit();
  }

  clearQueue(priority: 1 | 2): void {
    if (priority === 1) {
      this.karaokeItems.set([]);
      this.isReordering = true;
      setTimeout(() => {
        this.isReordering = false;
      }, 2000);
    }
    this.queueService.clearQueue(priority).subscribe();
  }

  toggleProcessingPause(isPaused: boolean): void {
    (isPaused ? this.queueService.resumeAll() : this.queueService.pauseAll()).subscribe();
  }

  handleDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    this.processedDrag.set(types.includes('application/x-kanta-processed'));
    event.preventDefault();
  }

  trackByTaskId(_index: number, item: QueueItem): string {
    return item.task_id;
  }

  onDragStarted(): void {
    this.isDragging = true;
  }

  onDragEnded(): void {
    // Leave drag state active briefly to allow CDK drop animation to complete smoothly
    setTimeout(() => {
      this.isDragging = false;
    }, 200);
  }

  onListDrop(event: CdkDragDrop<QueueItem[]>): void {
    if (event.previousIndex === event.currentIndex) return;

    // 1. HARD LOCK ENGAGED: Ignore all incoming server lists
    this.isReordering = true;

    // 2. Fixes Angular `trackBy` bug: Clone the array, mutate it, and reassign it
    const newArray = [...this.karaokeItems()];
    moveItemInArray(newArray, event.previousIndex, event.currentIndex);
    this.karaokeItems.set(newArray);

    // 3. Send to Server
    const taskIds = this.karaokeItems().map((item) => item.task_id);
    this.queueService.reorderKaraokeTracks(taskIds).subscribe({
      next: () => {
        // Wait 2 full seconds AFTER the backend succeeds before trusting server updates again.
        // This stops the backend's async DB from temporarily feeding us the old order.
        setTimeout(() => {
          this.isReordering = false;
          this.queueService.refresh();
        }, 2000);
      },
      error: () => {
        this.isReordering = false;
        this.queueService.refresh();
      },
    });
  }

  dropExternal(event: DragEvent, targetQueue: QueueName): void {
    event.preventDefault();
    event.stopPropagation();
    this.processedDrag.set(false);

    const processedSong = event.dataTransfer?.getData('application/x-kanta-processed');
    if (processedSong) {
      if (targetQueue === 'karaoke_queue') {
        this.selectProcessedSong(processedSong);
      }
      return;
    }

    if (event.dataTransfer?.files.length) {
      this.addFiles(event.dataTransfer.files, targetQueue);
    }
  }

  selectTrack(item: QueueItem): void {
    if (item.priority === 1 && !['failed', 'cancelled', 'cancelling'].includes(item.status)) {
      this.trackSelected.emit(item);
    }
  }

  pause(item: QueueItem): void {
    this.queueService.pauseTrack(item.task_id).subscribe();
  }

  resume(item: QueueItem): void {
    this.queueService.resumeTrack(item.task_id).subscribe();
  }

  remove(item: QueueItem, queue: QueueName): void {
    if (queue === 'karaoke_queue') {
      this.karaokeItems.update((items) =>
        items.filter((queued) => queued.task_id !== item.task_id),
      );
      this.isReordering = true;
      setTimeout(() => {
        this.isReordering = false;
      }, 2000);
      this.queueService.removeKaraokeTrack(item.task_id).subscribe();
    } else {
      this.queueService.removeTrack(item.task_id).subscribe();
    }
  }

  private addFiles(files: FileList, targetQueue: QueueName): void {
    const priority = targetQueue === 'karaoke_queue' ? 1 : 2;
    Array.from(files).forEach((file) => {
      this.queueService.addTrack(file, priority).subscribe();
    });
  }

  private selectProcessedSong(value: string): void {
    try {
      const song = JSON.parse(value) as SongManifest;
      if (song.artist && song.album && song.title && Array.isArray(song.stems)) {
        this.queueService.addProcessedTrack(song).subscribe();
      }
    } catch {
      return;
    }
  }
}
