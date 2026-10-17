import { ApplicationRef, Component, DestroyRef, ElementRef, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideChevronDown, LucideFilePlus, LucidePause, LucidePlay, LucideTrash2 } from '@lucide/angular';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';

import { Tooltip } from '../../../../shared/directives/tooltip';
import { LibraryService, SongRef, songCover, songKey } from '../../../../shared/services/library.service';
import { SongManifest, songAlbum, songArtist, songTitle } from '../../../../shared/services/songs.service';
import { PlaybackActions } from '../../../../shared/services/playback-actions.service';
import { KANTA_DRAG_TYPE } from '../../../../shared/services/layout.service';
import { readDragPayload } from '../../../../shared/util/drag-payload';
import { QueueItemActions } from '../queue-item-actions/queue-item-actions';
import { QueueTrackSummary } from '../queue-track-summary/queue-track-summary';
import { QueueItem } from '../../interfaces/queue.models';
import { QueueService } from '../../data-access/queue.service';

type QueueName = 'karaoke_queue' | 'processing_queue';

const SERVER_TRUST_DELAY_MS = 1200;
const ACTIVE_STATUSES = new Set(['pending', 'processing', 'paused', 'cancelling']);
const UPLOAD_PREFIX = 'upload:';

@Component({
  selector: 'app-queue-sheet',
  imports: [
    QueueItemActions,
    QueueTrackSummary,
    Tooltip,
    LucideChevronDown,
    LucideFilePlus,
    LucidePause,
    LucidePlay,
    LucideTrash2,
    DragDropModule,
    ScrollingModule,
  ],
  templateUrl: './queue-sheet.html',
  styleUrl: './queue-sheet.scss',
})
export class QueueSheet implements OnInit {
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private browseTarget: QueueName = 'karaoke_queue';
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
  // Optimistic rows for files that are still uploading, so a drop morphs into a queue item immediately.
  private readonly uploads = signal<QueueItem[]>([]);
  readonly processingView = computed(() => {
    const base = this.processingItems().filter((item) => ACTIVE_STATUSES.has(item.status));
    const known = new Set(base.map((item) => item.task_id));
    return [...base, ...this.uploads().filter((item) => !known.has(item.task_id))];
  });
  readonly overQueue = signal<QueueName | null>(null);
  readonly committing = signal(false);
  private processingLocked = false;
  readonly canSortProcessing = (index: number): boolean => this.processingView()[index]?.status === 'pending';
  // Index at which an externally dragged item would be inserted; renders a gap that shifts rows.
  readonly dropIndex = signal<number | null>(null);

  readonly close = output<void>();
  readonly trackSelected = output<QueueItem>();

  ngOnInit(): void {
    this.queueService.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((snapshot) => {
      if (!this.processingLocked) this.processingItems.set(snapshot.processing_queue);
      this.uploads.update((list) =>
        list.filter((item) => item.task_id.startsWith(UPLOAD_PREFIX) || !snapshot.processing_queue.some((queued) => queued.task_id === item.task_id)),
      );
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

  isUpload(item: QueueItem): boolean {
    return item.task_id.startsWith(UPLOAD_PREFIX);
  }

  canDragProcessing(item: QueueItem): boolean {
    return item.status === 'pending' && !this.isUpload(item);
  }

  onProcessingDrop(event: CdkDragDrop<QueueItem[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    const view = this.processingView();
    const reordered = [...view];
    moveItemInArray(reordered, event.previousIndex, event.currentIndex);
    this.processingLocked = true;
    this.processingItems.set(reordered.filter((item) => !this.isUpload(item)));
    this.appRef.tick();
    const release = (): void => { setTimeout(() => (this.processingLocked = false), 400); };
    this.queueService.reorderProcessingTracks(reordered.filter((item) => !this.isUpload(item)).map((item) => item.task_id)).subscribe({
      next: release,
      error: () => { this.processingLocked = false; this.queueService.refresh(); },
    });
  }

  onProcessingDragOver(event: DragEvent): void {
    if (!(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    if (this.overQueue() !== 'processing_queue') this.overQueue.set('processing_queue');
  }

  onProcessingDragLeave(event: DragEvent): void {
    const area = event.currentTarget as HTMLElement;
    if (!area.contains(event.relatedTarget as Node | null)) this.overQueue.set(null);
  }

  onExternalDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes(KANTA_DRAG_TYPE) && !types.includes('Files')) return;
    event.preventDefault();
    if (this.overQueue() !== 'karaoke_queue') this.overQueue.set('karaoke_queue');
    const list = event.currentTarget as HTMLElement;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > li.queue-row'));
    let index = rows.length;
    // Dropped files are appended by the server, so only library songs get a positional gap.
    for (let i = 0; types.includes(KANTA_DRAG_TYPE) && i < rows.length; i++) {
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
    if (!list.contains(event.relatedTarget as Node | null)) {
      this.dropIndex.set(null);
      this.overQueue.set(null);
    }
  }

  dropExternal(event: DragEvent, targetQueue: QueueName): void {
    event.preventDefault();
    event.stopPropagation();
    this.processedDrag.set(false);
    const index = this.dropIndex();
    this.dropIndex.set(null);
    this.overQueue.set(null);
    // The gap is replaced by a row of the same height, so it must vanish instantly rather than animate out.
    this.committing.set(true);
    setTimeout(() => this.committing.set(false), 80);

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
    if (this.isUpload(item)) return;
    if (item.priority === 1 && !['failed', 'cancelled', 'cancelling'].includes(item.status)) {
      this.trackSelected.emit(item);
    }
  }

  pause(item: QueueItem): void {
    if (this.isUpload(item)) return;
    this.queueService.pauseTrack(item.task_id).subscribe();
  }

  resume(item: QueueItem): void {
    if (this.isUpload(item)) return;
    this.queueService.resumeTrack(item.task_id).subscribe();
  }

  remove(item: QueueItem, queue: QueueName): void {
    if (this.isUpload(item)) return;
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
        raw_title: songTitle(song as SongManifest),
        raw_artist: songArtist(song as SongManifest),
        raw_album: songAlbum(song as SongManifest),
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

  browseFiles(target: QueueName): void {
    this.browseTarget = target;
    this.fileInput()?.nativeElement.click();
  }

  onFilesChosen(input: HTMLInputElement): void {
    if (input.files?.length) this.addFiles(input.files, this.browseTarget);
    input.value = '';
  }

  private addFiles(files: FileList, targetQueue: QueueName): void {
    const priority = targetQueue === 'karaoke_queue' ? 1 : 2;
    Array.from(files).forEach((file) => {
      const temp = this.uploadPlaceholder(file, priority);
      this.uploads.update((list) => [...list, temp]);
      if (priority === 1) {
        this.entering.set(temp.task_id, 0);
        this.karaokeItems.update((items) => [...items, temp]);
        this.lockServerOrder(true);
      }
      this.queueService.addTrack(file, priority).subscribe({
        next: ({ item }) => {
          this.entering.delete(temp.task_id);
          this.uploads.update((list) => list.map((entry) => (entry === temp ? item : entry)));
          if (priority === 1) {
            this.karaokeItems.update((items) => items.map((entry) => (entry === temp ? item : entry)));
            this.lockServerOrder();
          }
        },
        error: () => {
          this.entering.delete(temp.task_id);
          this.uploads.update((list) => list.filter((entry) => entry !== temp));
          this.karaokeItems.update((items) => items.filter((entry) => entry !== temp));
          this.releaseServerOrder();
        },
      });
    });
  }

  private uploadPlaceholder(file: File, priority: 1 | 2): QueueItem {
    const name = file.name.replace(/\.[^/.]+$/, '');
    return {
      task_id: `${UPLOAD_PREFIX}${++this.tempCounter}`,
      file_path: '',
      raw_title: name,
      raw_artist: 'Uploading…',
      raw_album: '',
      title: name,
      artist: 'Uploading…',
      album: '',
      priority,
      status: 'pending',
      progress: 0,
      step: 'Uploading…',
      position: 0,
      cover_url: null,
    };
  }
}
