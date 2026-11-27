import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, from, mergeMap, tap } from 'rxjs';

import { QueueItem } from '../../interfaces/queue.models';
import { QueueService } from '../../data-access/queue.service';
import { ToastService } from '../../../../shared/services/toast.service';
import { filterImportFiles, matchImportFiles } from './import-files';
import { KaraokeQueueSection } from './karaoke-queue-section/karaoke-queue-section';
import { ProcessingQueueSection } from './processing-queue-section/processing-queue-section';
import type { PartySessionService } from '../../../../shared/services/party-session.service';

const formatPlaytime = (seconds: number): string => {
  const total = Math.round(seconds);
  if (total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours} hr ${minutes} min`;
  return minutes ? `${minutes} min ${total % 60} s` : `${total} s`;
};

const ACTIVE_STATUSES = new Set(['pending', 'processing', 'paused', 'cancelling']);
const UPLOAD_PREFIX = 'upload:';

@Component({
  selector: 'app-queue-sheet',
  imports: [KaraokeQueueSection, ProcessingQueueSection],
  templateUrl: './queue-sheet.html',
  styleUrl: './queue-sheet.scss',
})
export class QueueSheet implements OnInit {
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly folderInput = viewChild<ElementRef<HTMLInputElement>>('folderInput');

  private browseTarget: 'karaoke' | 'processing' = 'karaoke';
  private readonly queueService = inject(QueueService);
  private readonly injector = inject(Injector);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly lastStatus = new Map<string, string>();

  private tempCounter = 0;
  private partySessionPromise: Promise<PartySessionService> | null = null;
  private isReordering = false;
  private reorderLockTimer: ReturnType<typeof setTimeout> | null = null;

  readonly activeTaskId = input<string | null>(null);
  readonly playbackActive = input(false);
  readonly processedItemDrag = input(false);
  readonly hideProcessingQueue = input(false);

  readonly karaokeCollapsed = signal(false);
  readonly processingCollapsed = signal(false);

  readonly karaokeItems = signal<QueueItem[]>([]);
  readonly processingItems = signal<QueueItem[]>([]);
  readonly uploads = signal<QueueItem[]>([]);

  readonly karaokeTotalSeconds = computed(() =>
    this.karaokeItems()
      .filter((item) => !['failed', 'cancelled', 'cancelling'].includes(item.status))
      .reduce((sum, item) => sum + (item.duration_seconds ?? 0), 0),
  );
  readonly karaokeTotalLabel = computed(() => formatPlaytime(this.karaokeTotalSeconds()));

  readonly processingPaused = signal(false);
  readonly processingView = computed(() => {
    const base = this.processingItems().filter((item) => ACTIVE_STATUSES.has(item.status));
    const known = new Set(base.map((item) => item.task_id));
    return [...base, ...this.uploads().filter((item) => !known.has(item.task_id))];
  });

  readonly close = output<void>();
  readonly trackSelected = output<QueueItem>();

  ngOnInit(): void {
    this.queueService.queue$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((snapshot) => {
      this.announceCompleted([...snapshot.processing_queue, ...snapshot.karaoke_queue]);
      this.processingItems.set(snapshot.processing_queue);
      this.uploads.update((list) =>
        list.filter(
          (item) =>
            item.task_id.startsWith(UPLOAD_PREFIX) ||
            !snapshot.processing_queue.some((queued) => queued.task_id === item.task_id),
        ),
      );
      this.processingPaused.set(snapshot.processing_paused ?? false);

      if (this.isReordering) {
        // Update track metadata/status without reverting client list ordering
        this.karaokeItems.update((current) =>
          current.map((item) => {
            const updated = snapshot.karaoke_queue.find((s) => s.task_id === item.task_id);
            return updated ? { ...item, status: updated.status, progress: updated.progress } : item;
          }),
        );
        return;
      }

      this.karaokeItems.set([...snapshot.karaoke_queue]);
    });
  }

  clearQueue(priority: 1 | 2): void {
    if (priority === 1) {
      this.karaokeItems.set([]);
    }
    this.queueService.clearQueue(priority).subscribe({
      error: (error: unknown) => {
        const detail =
          error instanceof HttpErrorResponse && typeof error.error?.detail === 'string'
            ? ` ${error.error.detail}`
            : '';
        this.toast.error(`Could not clear the queue.${detail}`);
        this.queueService.refresh();
      },
    });
  }

  toggleProcessingPause(): void {
    (this.processingPaused() ? this.queueService.resumeAll() : this.queueService.pauseAll()).subscribe();
  }

  reorderKaraoke(taskIds: string[]): void {
    // Optimistically reorder locally to eliminate momentary reversion
    const map = new Map(this.karaokeItems().map((item) => [item.task_id, item]));
    const next = taskIds.map((id) => map.get(id)!).filter(Boolean);
    this.karaokeItems.set(next);

    this.lockReorder();
    this.queueService.reorderKaraokeTracks(taskIds).subscribe({
      next: () => this.unlockReorder(400),
      error: () => {
        this.unlockReorder(0);
        this.queueService.refresh();
      },
    });
  }

  private lockReorder(): void {
    this.isReordering = true;
    if (this.reorderLockTimer) clearTimeout(this.reorderLockTimer);
  }

  private unlockReorder(delayMs = 0): void {
    if (this.reorderLockTimer) clearTimeout(this.reorderLockTimer);
    this.reorderLockTimer = setTimeout(() => {
      this.isReordering = false;
    }, delayMs);
  }

  reorderProcessing(taskIds: string[]): void {
    this.queueService.reorderProcessingTracks(taskIds).subscribe({
      error: () => this.queueService.refresh(),
    });
  }

  pause(item: QueueItem): void {
    if (item.task_id.startsWith(UPLOAD_PREFIX)) return;
    this.queueService.pauseTrack(item.task_id).subscribe();
  }

  resume(item: QueueItem): void {
    if (item.task_id.startsWith(UPLOAD_PREFIX)) return;
    this.queueService.resumeTrack(item.task_id).subscribe();
  }

  remove(item: QueueItem, queue: 'karaoke' | 'processing'): void {
    if (item.task_id.startsWith(UPLOAD_PREFIX)) return;
    if (queue === 'karaoke') {
      this.karaokeItems.update((items) => items.filter((i) => i.task_id !== item.task_id));
      this.queueService.removeKaraokeTrack(item.task_id).subscribe();
    } else {
      this.queueService.removeTrack(item.task_id).subscribe();
    }
  }

  browseFiles(target: 'karaoke' | 'processing'): void {
    this.browseTarget = target;
    this.fileInput()?.nativeElement.click();
  }

  browseFolder(): void {
    this.browseTarget = 'processing';
    this.folderInput()?.nativeElement.click();
  }

  onFilesChosen(input: HTMLInputElement, folder = false): void {
    if (input.files?.length) void this.addFiles(Array.from(input.files), this.browseTarget, folder);
    input.value = '';
  }

  async addFiles(files: File[], targetQueue: 'karaoke' | 'processing', folder = false): Promise<void> {
    const priority = targetQueue === 'karaoke' ? 1 : 2;
    const filtered = await filterImportFiles(files);
    if (filtered.skipped.length) {
      this.toast.show(`Skipped ${filtered.skipped.length} non-audio file${filtered.skipped.length === 1 ? '' : 's'}.`);
    }
    for (const { file, message } of filtered.errors) {
      this.toast.error(`Could not inspect “${file.name}”: ${message}`);
    }
    const { matches, unmatchedLyrics } = matchImportFiles(filtered.files);
    if (folder && !matches.length) this.toast.error('No audio files found in the selected folder.');

    const pending = matches.flatMap(({ audio: file, lyrics, ambiguous }) => {
      if (ambiguous) {
        this.toast.error(`Cannot match lyrics for “${file.name}”: multiple files have the same name.`);
        return [];
      }
      const temp = this.uploadPlaceholder(file, priority);
      return [{ file, lyrics, temp }];
    });

    const placeholders = pending.map(({ temp }) => temp);
    if (placeholders.length) {
      this.uploads.update((list) => [...list, ...placeholders]);
      if (priority === 1) {
        this.karaokeItems.update((items) => [...items, ...placeholders]);
      }
    }

    from(pending)
      .pipe(
        mergeMap(
          ({ file, lyrics, temp }) =>
            this.queueService.addTrack(file, priority, lyrics).pipe(
              tap(({ item, skipped }) => {
                if (skipped || !item) {
                  this.uploads.update((list) => list.filter((entry) => entry !== temp));
                  this.karaokeItems.update((items) => items.filter((entry) => entry !== temp));
                  this.toast.show(
                    skipped === 'already_queued'
                      ? `Skipped “${file.name}”; it is already queued.`
                      : `Skipped “${file.name}”; it is already in the library.`,
                  );
                  return;
                }
                this.uploads.update((list) => list.map((entry) => (entry === temp ? item : entry)));
                if (priority === 1) {
                  this.karaokeItems.update((items) =>
                    items.map((entry) => (entry === temp ? item : entry)),
                  );
                }
              }),
              catchError((error: unknown) => {
                const detail =
                  error instanceof HttpErrorResponse && typeof error.error?.detail === 'string'
                    ? ` ${error.error.detail}`
                    : '';
                this.toast.error(`Could not add “${file.name}” to the queue.${detail}`);
                this.uploads.update((list) => list.filter((entry) => entry !== temp));
                this.karaokeItems.update((items) => items.filter((entry) => entry !== temp));
                return EMPTY;
              }),
            ),
          3,
        ),
      )
      .subscribe();

    if (!folder) {
      for (const lyrics of unmatchedLyrics) {
        this.toast.error(`No matching audio selected for “${lyrics.name}”.`);
      }
    }
  }

  private announceCompleted(items: QueueItem[]): void {
    for (const item of items) {
      const previous = this.lastStatus.get(item.task_id);
      if (previous && ACTIVE_STATUSES.has(previous) && item.status === 'completed') {
        this.toast.success(`Finished processing “${item.title || item.raw_title}”`);
      }
      this.lastStatus.set(item.task_id, item.status);
    }
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