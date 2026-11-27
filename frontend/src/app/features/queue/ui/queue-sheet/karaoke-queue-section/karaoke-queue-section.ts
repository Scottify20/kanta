import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DragDropModule, CdkDragDrop, moveItemInArray, Point } from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { LucideChevronDown, LucideCrosshair } from '@lucide/angular';

import { Tooltip } from '../../../../../shared/directives/tooltip';
import { QueueItem } from '../../../interfaces/queue.models';
import { QueueTrackSummary } from '../../queue-track-summary/queue-track-summary';
import { QueueItemActions } from '../../queue-item-actions/queue-item-actions';
import { SongRef, songKey, songCover, LibraryService } from '../../../../../shared/services/library.service';
import { activeDragSongs, readDragPayload } from '../../../../../shared/util/drag-payload';
import { KANTA_DRAG_TYPE, LayoutService } from '../../../../../shared/services/layout.service';
import { PlaybackActions } from '../../../../../shared/services/playback-actions.service';

@Component({
  selector: 'app-karaoke-queue-section',
  imports: [
    QueueTrackSummary,
    QueueItemActions,
    Tooltip,
    LucideChevronDown,
    LucideCrosshair,
    DragDropModule,
    ScrollingModule,
  ],
  templateUrl: './karaoke-queue-section.html',
  styleUrl: './karaoke-queue-section.scss',
})
export class KaraokeQueueSection {
  readonly items = input.required<QueueItem[]>();
  readonly activeTaskId = input<string | null>(null);
  readonly playbackActive = input(false);
  readonly collapsed = input(false);
  readonly totalLabel = input<string>('');

  readonly toggleCollapse = output<void>();
  readonly clear = output<void>();
  readonly trackSelected = output<QueueItem>();
  readonly pause = output<QueueItem>();
  readonly resume = output<QueueItem>();
  readonly remove = output<QueueItem>();
  readonly reordered = output<string[]>();

  protected readonly layout = inject(LayoutService);
  private readonly actions = inject(PlaybackActions);
  private readonly library = inject(LibraryService);

  readonly karaokeSection = viewChild<ElementRef<HTMLElement>>('karaokeSection');
  readonly trackListElement = viewChild<ElementRef<HTMLElement>>('trackListElement');

  readonly selectedTaskIds = signal<ReadonlySet<string>>(new Set());
  private anchorIndex = -1;

  readonly isDragging = signal(false);
  readonly draggedTaskId = signal<string | null>(null);
  readonly overQueue = signal(false);
  readonly trashHovered = signal(false);
  readonly dropIndex = signal<number | null>(null);
  readonly pendingDropped = signal<{ songs: SongRef[]; index: number } | null>(null);

  // Marquee rectangle coordinates relative to scrollable content
  readonly marqueeActive = signal(false);
  readonly marqueeBox = signal<{ left: number; top: number; width: number; height: number } | null>(null);
  readonly ctrlPressed = signal(false);
  private startContentX = 0;
  private startContentY = 0;
  private marqueeInitialSelection = new Set<string>();

  // Progressive auto-scroll loop
  private autoScrollRaf: number | null = null;
  private currentPointerY = 0;
  private cachedRowMidpoints: number[] = [];
  private listLeftX = 0;

  readonly activeHoverSongs = computed(() => activeDragSongs());
  readonly phantomSongs = computed(() => {
    const pending = this.pendingDropped();
    return pending ? pending.songs : this.activeHoverSongs();
  });

  readonly phantomItems = computed<QueueItem[]>(() => {
    const songs = this.phantomSongs();
    return songs.map((s, idx) => {
      const librarySong = this.library.songs().find((item) => songKey(item) === songKey(s));
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
    return pending ? pending.index : this.dropIndex();
  });

  // Display items: during multi-drag, other selected items fold into the drag preview
  readonly displayItems = computed<QueueItem[]>(() => {
    const all = this.items();
    const draggedId = this.draggedTaskId();
    const selected = this.selectedTaskIds();
    if (!this.isDragging() || !draggedId || selected.size <= 1 || !selected.has(draggedId)) {
      return all;
    }
    return all.filter((item) => item.task_id === draggedId || !selected.has(item.task_id));
  });

  readonly selectedItemsPreview = computed(() => {
    const selected = this.selectedTaskIds();
    return this.items().filter((i) => selected.has(i.task_id));
  });

  isItemSelected(item: QueueItem): boolean {
    return this.selectedTaskIds().has(item.task_id);
  }

  // Horizontally locks item drag to tracklist boundaries unless hovering trash
  constrainDragPosition = (point: Point): Point => {
    if (this.trashHovered()) {
      return point;
    }
    return { x: this.listLeftX || point.x, y: point.y };
  };

  handleRowClick(item: QueueItem, index: number, event: MouseEvent): void {
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      this.handleRowSelection(item, index, event);
    } else {
      this.trackSelected.emit(item);
    }
  }

  handleContextMenu(item: QueueItem, event: MouseEvent, actions: QueueItemActions): void {
    if (!this.selectedTaskIds().has(item.task_id)) {
      this.selectedTaskIds.set(new Set([item.task_id]));
    }
    actions.openAt(event);
  }

  private handleRowSelection(item: QueueItem, index: number, event: MouseEvent): void {
    const isAdditive = event.ctrlKey || event.metaKey;
    const isRange = event.shiftKey && this.anchorIndex >= 0;

    if (isRange) {
      const all = this.items();
      const [from, to] = [this.anchorIndex, index].sort((a, b) => a - b);
      this.selectedTaskIds.set(new Set(all.slice(from, to + 1).map((t) => t.task_id)));
      return;
    }

    if (isAdditive) {
      this.selectedTaskIds.update((set) => {
        const next = new Set(set);
        next.has(item.task_id) ? next.delete(item.task_id) : next.add(item.task_id);
        return next;
      });
      this.anchorIndex = index;
      return;
    }

    this.anchorIndex = index;
    this.selectedTaskIds.set(new Set([item.task_id]));
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Control' || event.key === 'Meta') {
      this.ctrlPressed.set(true);
    }
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if (event.key === 'Escape') {
      if (this.selectedTaskIds().size > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.selectedTaskIds.set(new Set());
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      const container = this.karaokeSection()?.nativeElement;
      if (container && event.composedPath().includes(container)) {
        event.preventDefault();
        this.selectedTaskIds.set(new Set(this.items().map((i) => i.task_id)));
      }
    }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyup(event: KeyboardEvent): void {
    if (event.key === 'Control' || event.key === 'Meta') {
      this.ctrlPressed.set(false);
    }
  }

  startMarquee(event: PointerEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    const container = this.karaokeSection()?.nativeElement;
    if (!container) return;

    event.preventDefault();
    event.stopPropagation();

    this.marqueeActive.set(true);
    this.marqueeInitialSelection = new Set(this.selectedTaskIds());

    const rect = container.getBoundingClientRect();
    this.startContentX = event.clientX - rect.left;
    this.startContentY = event.clientY - rect.top + container.scrollTop;
    this.currentPointerY = event.clientY;
    this.marqueeBox.set({ left: this.startContentX, top: this.startContentY, width: 0, height: 0 });

    window.addEventListener('pointermove', this.updateMarquee);
    window.addEventListener('pointerup', this.endMarquee, { once: true });
    this.startAutoScrollLoop();
  }

  private updateMarquee = (event: PointerEvent): void => {
    if (!this.marqueeActive()) return;
    const container = this.karaokeSection()?.nativeElement;
    if (!container) return;

    this.currentPointerY = event.clientY;
    const rect = container.getBoundingClientRect();
    const currentContentX = event.clientX - rect.left;
    const currentContentY = event.clientY - rect.top + container.scrollTop;

    const left = Math.min(this.startContentX, currentContentX);
    const top = Math.min(this.startContentY, currentContentY);
    const width = Math.abs(currentContentX - this.startContentX);
    const height = Math.abs(currentContentY - this.startContentY);

    this.marqueeBox.set({ left, top, width, height });
    this.evaluateMarqueeCollisions(left, top, left + width, top + height);
  };

  private evaluateMarqueeCollisions(boxLeft: number, boxTop: number, boxRight: number, boxBottom: number): void {
    const container = this.karaokeSection()?.nativeElement;
    if (!container) return;

    const rows = container.querySelectorAll<HTMLElement>('li.queue-row[data-task-id]');
    const nextSelection = new Set(this.marqueeInitialSelection);

    rows.forEach((row) => {
      const relativeTop = row.offsetTop;
      const relativeBottom = relativeTop + row.offsetHeight;
      const relativeLeft = row.offsetLeft;
      const relativeRight = relativeLeft + row.offsetWidth;

      const collides =
        boxLeft < relativeRight &&
        boxRight > relativeLeft &&
        boxTop < relativeBottom &&
        boxBottom > relativeTop;

      const taskId = row.getAttribute('data-task-id');
      if (taskId && collides) nextSelection.add(taskId);
    });

    this.selectedTaskIds.set(nextSelection);
  }

  private endMarquee = (): void => {
    this.marqueeActive.set(false);
    this.marqueeBox.set(null);
    this.stopAutoScrollLoop();
    window.removeEventListener('pointermove', this.updateMarquee);
  };

  private startAutoScrollLoop(): void {
    this.stopAutoScrollLoop();
    const loop = (): void => {
      if (!this.isDragging() && !this.marqueeActive()) return;
      const container = this.karaokeSection()?.nativeElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        const threshold = 85;
        const topDist = this.currentPointerY - rect.top;
        const bottomDist = rect.bottom - this.currentPointerY;

        // Progressive auto-scroll curve
        if (topDist > 0 && topDist < threshold) {
          const ratio = 1 - topDist / threshold;
          const speed = Math.round(ratio * ratio * 28 + 2);
          container.scrollTop -= speed;
        } else if (bottomDist > 0 && bottomDist < threshold) {
          const ratio = 1 - bottomDist / threshold;
          const speed = Math.round(ratio * ratio * 28 + 2);
          container.scrollTop += speed;
        }

        if (this.marqueeActive() && this.marqueeBox()) {
          const box = this.marqueeBox()!;
          this.evaluateMarqueeCollisions(box.left, box.top, box.left + box.width, box.top + box.height);
        }
      }
      this.autoScrollRaf = requestAnimationFrame(loop);
    };
    this.autoScrollRaf = requestAnimationFrame(loop);
  }

  private stopAutoScrollLoop(): void {
    if (this.autoScrollRaf) {
      cancelAnimationFrame(this.autoScrollRaf);
      this.autoScrollRaf = null;
    }
  }

  onListDrop(event: CdkDragDrop<QueueItem[]>): void {
    this.stopAutoScrollLoop();
    if (event.previousIndex === event.currentIndex) return;

    const all = [...this.items()];
    const displayed = this.displayItems();
    const selected = this.selectedTaskIds();
    const draggedItem = displayed[event.previousIndex];
    if (!draggedItem) return;

    if (selected.size > 1 && selected.has(draggedItem.task_id)) {
      const selectedItems = all.filter((item) => selected.has(item.task_id));
      const remainingItems = all.filter((item) => !selected.has(item.task_id));
      const targetItem = displayed[event.currentIndex];
      let insertAt = remainingItems.indexOf(targetItem);
      if (insertAt === -1) insertAt = remainingItems.length;
      if (event.currentIndex > event.previousIndex) insertAt += 1;
      remainingItems.splice(insertAt, 0, ...selectedItems);
      this.reordered.emit(remainingItems.map((i) => i.task_id));
    } else {
      const fromIndex = all.indexOf(draggedItem);
      const targetItem = displayed[event.currentIndex];
      const toIndex = all.indexOf(targetItem);
      moveItemInArray(all, fromIndex, toIndex);
      this.reordered.emit(all.map((i) => i.task_id));
    }
  }

  onTrashDrop(event: CdkDragDrop<unknown>): void {
    this.trashHovered.set(false);
    this.stopAutoScrollLoop();
    const draggedId = this.draggedTaskId();
    if (!draggedId) return;

    const selected = this.selectedTaskIds();
    if (selected.has(draggedId)) {
      this.removeSelectedItems();
    } else {
      const item = this.items().find((i) => i.task_id === draggedId);
      if (item) this.remove.emit(item);
    }
  }

  removeSelectedItems(): void {
    const selected = this.selectedTaskIds();
    for (const item of this.items()) {
      if (selected.has(item.task_id)) this.remove.emit(item);
    }
    this.selectedTaskIds.set(new Set());
  }

  onDragStarted(item: QueueItem): void {
    const listEl = this.trackListElement()?.nativeElement;
    if (listEl) {
      const rect = listEl.getBoundingClientRect();
      document.documentElement.style.setProperty('--cdk-drag-width', `${rect.width}px`);
      this.listLeftX = rect.left;
    }
    this.isDragging.set(true);
    this.draggedTaskId.set(item.task_id);
    if (!this.selectedTaskIds().has(item.task_id)) {
      this.selectedTaskIds.set(new Set([item.task_id]));
    }
    window.addEventListener('pointermove', this.onDragPointerMove, { passive: true });
    this.startAutoScrollLoop();
  }

  private onDragPointerMove = (e: PointerEvent): void => {
    this.currentPointerY = e.clientY;
  };

  onDragEnded(): void {
    this.isDragging.set(false);
    this.draggedTaskId.set(null);
    this.trashHovered.set(false);
    this.stopAutoScrollLoop();
    window.removeEventListener('pointermove', this.onDragPointerMove);
  }

  onExternalDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes(KANTA_DRAG_TYPE) && !types.includes('Files')) return;
    event.preventDefault();
    this.overQueue.set(true);

    if (this.cachedRowMidpoints.length === 0) {
      const container = this.karaokeSection()?.nativeElement;
      const rows = Array.from(
        container?.querySelectorAll<HTMLElement>('li.queue-row:not(.phantom-row):not(.phantom-stack)') ?? [],
      );
      this.cachedRowMidpoints = rows.map((r) => {
        const rect = r.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
    }

    let calculatedIndex = this.cachedRowMidpoints.length;
    for (let i = 0; i < this.cachedRowMidpoints.length; i++) {
      if (event.clientY < this.cachedRowMidpoints[i]) {
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
      this.cachedRowMidpoints = [];
      this.dropIndex.set(null);
      this.overQueue.set(false);
    }
  }

  dropExternal(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.cachedRowMidpoints = [];
    const index = this.dropIndex() ?? this.items().length;
    this.dropIndex.set(null);
    this.overQueue.set(false);

    const songs = readDragPayload(event);
    if (!songs.length) return;

    this.layout.notifyDropped();

    const items = this.items();
    const afterTaskId = index > 0 ? (items[index - 1]?.task_id ?? null) : null;

    this.pendingDropped.set({ songs, index });

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

    const header = container.querySelector('.section-header') as HTMLElement | null;
    const headerHeight = header ? header.offsetHeight : 44;
    const containerRect = container.getBoundingClientRect();
    const rowRect = targetRow.getBoundingClientRect();
    const targetScrollTop = container.scrollTop + (rowRect.top - containerRect.top) - headerHeight - 6;

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  clearSelection(): void {
    this.selectedTaskIds.set(new Set());
  }
}