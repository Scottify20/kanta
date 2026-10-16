import { ApplicationRef, Component, DestroyRef, OnInit, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideChevronDown, LucidePause, LucidePlay, LucideTrash2 } from '@lucide/angular';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';

import { Tooltip } from '../../../../shared/directives/tooltip';
import { LibraryService, SongRef, songCover, songKey } from '../../../../shared/services/library.service';
import { PlaybackActions } from '../../../../shared/services/playback-actions.service';
import { KANTA_DRAG_TYPE } from '../../../../shared/services/layout.service';
import { readDragPayload } from '../../../../shared/util/drag-payload';
import { QueueItemActions } from '../queue-item-actions/queue-item-actions';
import { QueueTrackSummary } from '../queue-track-summary/queue-track-summary';
import { QueueItem } from '../../interfaces/queue.models';
import { QueueService } from '../../data-access/queue.service';

type QueueName = 'karaoke_queue' | 'processing_queue';

const SERVER_TRUST_DELAY_MS = 1200;

@Component({
  selector: 'app-queue-sheet',
  imports: [
    QueueItemActions,
    QueueTrackSummary,
    Tooltip,
    LucideChevronDown,
    LucidePause,
    LucidePlay,
    LucideTrash2,
    DragDropModule,
  ],
  templateUrl: './queue-sheet.html',
  styleUrl: './queue-sheet.scss',
})
export class QueueSheet implements OnInit {
  private readonly queueService = inject(QueueService);
  private readonly actions = inject(PlaybackActions);
  private readonly library = inject(LibraryService);
  private readonly appRef = inject(ApplicationRef);
  private readonly destroyRef = inject(DestroyRef);

  // While true, polled server orders are ignored so optimistic local order is not overwritten.
  private isDragging = false;
  private isReordering = false;
  private reorderTimer: ReturnType<typeof setTimeout> | null = null;
  private tempCounter = 0;
  private readonly entering = new Map<string, number>();

  readonly processedDrag = signal(false);
  readonly processedItemDrag = input(false);
  readonly hideProcessingQueue = input(false);
  readonly activeTaskId = input<string | null>(null);
  readonly playbackActive = input(false);

  readonly karaokeCollapsed = signal(false);
  readonly processingCollapsed = signal(false);

  readonly karaokeItems = signal<QueueItem[]>([]);
  readonly processingItems = signal<QueueItem[]>([]);
  readonly processingPaused = signal(false);
  // Index at which an externally dragged item would be inserted; renders a gap that shifts rows.
  readonly dropIndex = signal<number | null>(null);

  readonly close = output<void>();
  readonly trackSelected = output<QueueItem>();

  ngOnInit(): void {
    this.queueService.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((snapshot) => {
      this.processingItems.set(snapshot.processing_queue);
      this.processingPaused.set(snapshot.processing_paused ?? false);

      if (this.isDragging || this.isReordering) {
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
        return;
      }

      const currentItems = this.karaokeItems();
      const sameOrder =
        currentItems.length === snapshot.karaoke_queue.length &&
        currentItems.every((item, index) => item.task_id === snapshot.karaoke_queue[index].task_id);
      this.karaokeItems.set(
        sameOrder
          ? currentItems.map((item, index) => ({ ...item, ...snapshot.karaoke_queue[index] }))
          : [...snapshot.karaoke_queue],
      );
    });
  }

  clearQueue(priority: 1 | 2): void {
    if (priority === 1) {
      this.karaokeItems.set([]);
      this.lockServerOrder();
    }
    this.queueService.clearQueue(priority).subscribe();
  }

  toggleProcessingPause(isPaused: boolean): void {
    (isPaused ? this.queueService.resumeAll() : this.queueService.pauseAll()).subscribe();
  }

  handleDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    this.processedDrag.set(types.includes(KANTA_DRAG_TYPE));
    event.preventDefault();
  }

  onDragStarted(): void {
    this.isDragging = true;
  }

  onDragEnded(): void {
    this.isDragging = false;
  }

  onListDrop(event: CdkDragDrop<QueueItem[]>): void {
    if (event.previousIndex === event.currentIndex) return;

    this.lockServerOrder(true);
    const newArray = [...this.karaokeItems()];
    moveItemInArray(newArray, event.previousIndex, event.currentIndex);
    this.karaokeItems.set(newArray);
    // Render the new order before CDK resets its transforms, otherwise the old order flashes.
    this.appRef.tick();

    const taskIds = newArray.map((item) => item.task_id);
    this.queueService.reorderKaraokeTracks(taskIds).subscribe({
      next: () => this.lockServerOrder(),
      error: () => {
        this.releaseServerOrder();
        this.queueService.refresh();
      },
    });
  }

  onExternalDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes(KANTA_DRAG_TYPE) && !types.includes('Files')) return;
    event.preventDefault();
    const list = event.currentTarget as HTMLElement;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > li.queue-row'));
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    if (this.dropIndex() !== index) this.dropIndex.set(index);
  }

  onExternalDragLeave(event: DragEvent): void {
    const list = event.currentTarget as HTMLElement;
    if (!list.contains(event.relatedTarget as Node | null)) this.dropIndex.set(null);
  }

  dropExternal(event: DragEvent, targetQueue: QueueName): void {
    event.preventDefault();
    event.stopPropagation();
    this.processedDrag.set(false);
    const index = this.dropIndex();
    this.dropIndex.set(null);

    const songs = readDragPayload(event);
    if (songs.length) {
      if (targetQueue === 'karaoke_queue') {
        this.insertSongs(songs, index ?? this.karaokeItems().length);
      }
      return;
    }

    if (event.dataTransfer?.files.length) {
      this.addFiles(event.dataTransfer.files, targetQueue);
    }
  }

  isEntering(item: QueueItem): boolean {
    return this.entering.has(item.task_id);
  }

  enteringDelay(item: QueueItem): number | null {
    return this.entering.get(item.task_id) ?? null;
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
      this.lockServerOrder();
      this.queueService.removeKaraokeTrack(item.task_id).subscribe();
    } else {
      this.queueService.removeTrack(item.task_id).subscribe();
    }
  }

  private insertSongs(songs: SongRef[], index: number): void {
    const items = this.karaokeItems();
    const afterTaskId = index > 0 ? (items[index - 1]?.task_id ?? null) : null;
    const known = new Map(this.library.songs().map((song) => [songKey(song), song]));
    const temps = songs.map((song, offset): QueueItem => {
      const taskId = `pending-drop:${++this.tempCounter}`;
      this.entering.set(taskId, offset * 60);
      return {
        task_id: taskId,
        file_path: '',
        raw_title: song.title,
        raw_artist: song.artist,
        raw_album: song.album,
        ...song,
        priority: 1,
        status: 'completed',
        progress: 100,
        step: '',
        position: 0,
        cover_url: known.has(songKey(song)) ? songCover(known.get(songKey(song))!) : null,
      };
    });
    const next = [...items];
    next.splice(index, 0, ...temps);
    this.karaokeItems.set(next);
    this.lockServerOrder(true);

    this.actions
      .enqueue(songs, afterTaskId, index === 0)
      .catch(() => undefined)
      .finally(() => {
        temps.forEach((temp) => this.entering.delete(temp.task_id));
        this.lockServerOrder();
        this.queueService.refresh();
      });
  }

  // Holds optimistic state; `hold` keeps it until released, otherwise releases shortly after.
  private lockServerOrder(hold = false): void {
    this.isReordering = true;
    if (this.reorderTimer) clearTimeout(this.reorderTimer);
    this.reorderTimer = hold
      ? setTimeout(() => this.releaseServerOrder(), 8000)
      : setTimeout(() => this.releaseServerOrder(), SERVER_TRUST_DELAY_MS);
  }

  private releaseServerOrder(): void {
    this.isReordering = false;
    if (this.reorderTimer) {
      clearTimeout(this.reorderTimer);
      this.reorderTimer = null;
    }
  }

  private addFiles(files: FileList, targetQueue: QueueName): void {
    const priority = targetQueue === 'karaoke_queue' ? 1 : 2;
    Array.from(files).forEach((file) => {
      this.queueService.addTrack(file, priority).subscribe();
    });
  }
}
