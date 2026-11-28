import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { QueueItem } from '../../../interfaces/queue.models';
import { QueueTrackSummary } from '../../queue-track-summary/queue-track-summary';
import { QueueItemActions } from '../../queue-item-actions/queue-item-actions';
import { SongRef, songKey, songCover, LibraryService } from '../../../../../shared/services/library.service';
import { activeDragSongs, readDragPayload } from '../../../../../shared/util/drag-payload';
import { KANTA_DRAG_TYPE, LayoutService } from '../../../../../shared/services/layout.service';
import { PlaybackActions } from '../../../../../shared/services/playback-actions.service';
import { MarqueeBox, MarqueeController, applyExplorerClick } from '../../../../../shared/util/explorer-selection';
import { VerticalQueueDragController } from '../../../../../shared/util/queue-reorder';

interface PendingDropState {
  songs: SongRef[];
  index: number;
  existingIds: ReadonlySet<string>;
}

@Component({
  selector: 'app-karaoke-queue-section',
  imports: [QueueTrackSummary, QueueItemActions],
  templateUrl: './karaoke-queue-section.html',
  styleUrl: './karaoke-queue-section.scss',
})
export class KaraokeQueueSection {
  readonly items = input.required<QueueItem[]>();
  readonly activeTaskId = input<string | null>(null);
  readonly playbackActive = input(false);
  readonly collapsed = input(false);
  readonly totalLabel = input<string>('');

  readonly trackSelected = output<QueueItem>();
  readonly pause = output<QueueItem>();
  readonly resume = output<QueueItem>();
  readonly remove = output<QueueItem>();
  readonly reordered = output<string[]>();

  protected readonly layout = inject(LayoutService);
  private readonly actions = inject(PlaybackActions);
  private readonly library = inject(LibraryService);
  private readonly destroyRef = inject(DestroyRef);

  readonly karaokeSection = viewChild<ElementRef<HTMLElement>>('karaokeSection');
  readonly trackListElement = viewChild<ElementRef<HTMLElement>>('trackListElement');

  readonly selectedTaskIds = signal<ReadonlySet<string>>(new Set());
  private anchorId: string | null = null;

  readonly marqueeBox = signal<MarqueeBox | null>(null);
  readonly overQueue = signal(false);
  readonly dropIndex = signal<number | null>(null);
  readonly pendingDropped = signal<PendingDropState | null>(null);

  readonly drag = new VerticalQueueDragController<QueueItem>({
    getItems: () => this.items(),
    getId: (item) => item.task_id,
    canDrag: (item) => item.status !== 'cancelled',
    getMinSlot: () => 0,
    getSelectedIds: () => this.selectedTaskIds(),
    setSelectedIds: (next) => {
      this.selectedTaskIds.set(next);
      if (next.size) {
        this.layout.clearLibrarySelection$.next();
        this.layout.clearProcessingSelection$.next();
      }
    },
    getScrollContainer: () => this.karaokeSection()?.nativeElement ?? null,
    getListElement: () => this.trackListElement()?.nativeElement ?? null,
    onDragStart: () => {
      this.layout.clearLibrarySelection$.next();
      this.layout.clearProcessingSelection$.next();
    },
    onCommit: (orderedIds) => this.reordered.emit(orderedIds),
  });

  private readonly marquee = new MarqueeController({
    getBoxHost: () => this.karaokeSection()?.nativeElement ?? null,
    getScrollContainer: () => this.karaokeSection()?.nativeElement ?? null,
    ignoreSelector: 'li.queue-row, button, a, input, .actions',
    getTargets: () => {
      const container = this.karaokeSection()?.nativeElement;
      if (!container) return [];
      return Array.from(container.querySelectorAll<HTMLElement>('li.queue-row[data-task-id]')).map(
        (element) => ({ id: element.getAttribute('data-task-id')!, element }),
      );
    },
    getSelection: () => this.selectedTaskIds(),
    setSelection: (next) => this.selectedTaskIds.set(next),
    onMarqueeStart: () => {
      this.layout.clearLibrarySelection$.next();
      this.layout.clearProcessingSelection$.next();
    },
    onEmptyClick: () => this.clearSelection(),
    onBoxChange: (box) => this.marqueeBox.set(box),
  });

  readonly remainingIndexMap = computed(() => {
    const dragged = this.drag.draggedIds();
    const map = new Map<string, number>();
    let idx = 0;
    for (const item of this.items()) {
      if (!dragged.has(item.task_id)) {
        map.set(item.task_id, idx++);
      }
    }
    return map;
  });

  readonly activeHoverSongs = computed(() => activeDragSongs());

  // Removes each staged song from placeholders the instant its real item arrives via SSE.
  private readonly pendingDropProgress = computed<{ remaining: SongRef[]; arrivedCount: number }>(() => {
    const pending = this.pendingDropped();
    if (!pending) return { remaining: [], arrivedCount: 0 };

    const arrivedByKey = new Map<string, number>();
    for (const item of this.items()) {
      if (pending.existingIds.has(item.task_id)) continue;
      const key = songKey(item);
      arrivedByKey.set(key, (arrivedByKey.get(key) ?? 0) + 1);
    }

    const remaining: SongRef[] = [];
    let arrivedCount = 0;
    for (const song of pending.songs) {
      const key = songKey(song);
      const count = arrivedByKey.get(key) ?? 0;
      if (count > 0) {
        arrivedByKey.set(key, count - 1);
        arrivedCount++;
      } else {
        remaining.push(song);
      }
    }
    return { remaining, arrivedCount };
  });

  readonly phantomSongs = computed(() => {
    const pending = this.pendingDropped();
    return pending ? this.pendingDropProgress().remaining : this.activeHoverSongs();
  });

  readonly phantomItems = computed<QueueItem[]>(() => {
    const songs = this.phantomSongs();
    const byKey = this.library.songByKey();
    return songs.map((s, idx) => {
      const librarySong = byKey.get(songKey(s));
      return {
        task_id: `phantom-staged-${idx}`,
        file_path: '',
        raw_title: s.title,
        raw_artist: s.artist,
        raw_album: s.album,
        title: s.title,
        artist: s.artist,
        album: s.album,
        priority: 1,
        status: 'completed',
        progress: 100,
        step: '',
        position: 0,
        cover_url: librarySong ? songCover(librarySong) : null,
      };
    });
  });

  readonly effectiveDropIndex = computed(() => {
    const pending = this.pendingDropped();
    if (pending) {
      const { remaining, arrivedCount } = this.pendingDropProgress();
      if (!remaining.length) return null;
      return Math.min(this.items().length, pending.index + arrivedCount);
    }
    return this.dropIndex();
  });

  constructor() {
    this.layout.clearQueueSelection$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.clearSelection());

    this.destroyRef.onDestroy(() => {
      this.marquee.destroy();
      this.drag.destroy();
    });
  }

  isItemSelected(item: QueueItem): boolean {
    return this.selectedTaskIds().has(item.task_id);
  }

  clearSelection(): void {
    this.selectedTaskIds.set(new Set());
    this.anchorId = null;
  }

  rowShiftPx(item: QueueItem): number {
    return this.drag.shiftPxForIndex(this.remainingIndexMap().get(item.task_id) ?? -1);
  }

  onSectionPointerDown(event: PointerEvent): void {
    this.marquee.handlePointerDown(event);
  }

  handleRowClick(item: QueueItem, event: MouseEvent): void {
    if (this.drag.consumeClickSuppression()) return;

    const result = applyExplorerClick(
      this.items().map((i) => i.task_id),
      item.task_id,
      this.selectedTaskIds(),
      this.anchorId,
      { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
      'clear-and-activate',
    );
    this.anchorId = result.anchorId;
    this.selectedTaskIds.set(result.selection);

    if (result.selection.size > 0) {
      this.layout.clearLibrarySelection$.next();
      this.layout.clearProcessingSelection$.next();
    }
    if (result.activate) {
      this.trackSelected.emit(item);
    }
  }

  handleContextMenu(item: QueueItem, event: MouseEvent, actions: QueueItemActions): void {
    if (!this.selectedTaskIds().has(item.task_id)) {
      this.selectedTaskIds.set(new Set([item.task_id]));
      this.anchorId = item.task_id;
      this.layout.clearLibrarySelection$.next();
      this.layout.clearProcessingSelection$.next();
    }
    actions.openAt(event);
  }

  moveItem(index: number, direction: 'up' | 'down'): void {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    const all = [...this.items()];
    if (targetIndex < 0 || targetIndex >= all.length) return;
    const [moved] = all.splice(index, 1);
    all.splice(targetIndex, 0, moved);
    this.reordered.emit(all.map((i) => i.task_id));
  }

  removeSelectedItems(): void {
    const selected = this.selectedTaskIds();
    for (const item of this.items()) {
      if (selected.has(item.task_id)) this.remove.emit(item);
    }
    this.clearSelection();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if (event.key === 'Escape') {
      if (this.selectedTaskIds().size > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.clearSelection();
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      const container = this.karaokeSection()?.nativeElement;
      if (container && event.composedPath().includes(container)) {
        event.preventDefault();
        this.selectedTaskIds.set(new Set(this.items().map((i) => i.task_id)));
        this.layout.clearLibrarySelection$.next();
        this.layout.clearProcessingSelection$.next();
      }
    }
  }

  onExternalDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes(KANTA_DRAG_TYPE) && !types.includes('Files')) return;
    event.preventDefault();
    this.overQueue.set(true);

    const container = this.karaokeSection()?.nativeElement;
    const rows = Array.from(
      container?.querySelectorAll<HTMLElement>('li.queue-row:not(.phantom-row):not(.phantom-stack)') ?? [],
    );

    let calculatedIndex = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        calculatedIndex = i;
        break;
      }
    }

    if (this.dropIndex() !== calculatedIndex) {
      this.dropIndex.set(calculatedIndex);
    }
  }

  onExternalDragLeave(event: DragEvent): void {
    const container = this.karaokeSection()?.nativeElement;
    if (!container?.contains(event.relatedTarget as Node | null)) {
      this.dropIndex.set(null);
      this.overQueue.set(false);
    }
  }

  dropExternal(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const index = this.dropIndex() ?? this.items().length;
    this.dropIndex.set(null);
    this.overQueue.set(false);

    const songs = readDragPayload(event);
    if (!songs.length) return;

    this.layout.notifyDropped();

    const items = this.items();
    const existingIds = new Set(items.map((item) => item.task_id));
    const afterTaskId = index > 0 ? (items[index - 1]?.task_id ?? null) : null;

    this.pendingDropped.set({ songs, index, existingIds });

    void this.actions
      .enqueue(songs, afterTaskId, index === 0, event)
      .then((createdTaskIds) => {
        if (createdTaskIds.length) {
          this.selectedTaskIds.set(new Set(createdTaskIds));
        }
      })
      .finally(() => {
        this.pendingDropped.set(null);
      });
  }

  scrollToCurrentTrack(smooth = true): void {
    const activeId = this.activeTaskId();
    if (!activeId) return;
    const container = this.karaokeSection()?.nativeElement;
    if (!container) return;
    const targetRow = container.querySelector(`li[data-task-id="${activeId}"]`) as HTMLElement | null;
    if (!targetRow) return;

    const containerRect = container.getBoundingClientRect();
    const rowRect = targetRow.getBoundingClientRect();
    const targetScrollTop = container.scrollTop + (rowRect.top - containerRect.top) - 10;

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }
}