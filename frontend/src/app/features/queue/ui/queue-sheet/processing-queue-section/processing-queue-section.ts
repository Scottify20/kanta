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
import { LayoutService } from '../../../../../shared/services/layout.service';
import { MarqueeBox, MarqueeController, applyExplorerClick } from '../../../../../shared/util/explorer-selection';
import { VerticalQueueDragController } from '../../../../../shared/util/queue-reorder';

@Component({
  selector: 'app-processing-queue-section',
  imports: [QueueTrackSummary, QueueItemActions],
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

  protected readonly layout = inject(LayoutService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sectionElement = viewChild<ElementRef<HTMLElement>>('sectionElement');
  readonly trackListElement = viewChild<ElementRef<HTMLElement>>('trackListElement');

  readonly isOver = signal(false);
  readonly selectedTaskIds = signal<ReadonlySet<string>>(new Set());
  readonly marqueeBox = signal<MarqueeBox | null>(null);
  private anchorId: string | null = null;

  readonly drag = new VerticalQueueDragController<QueueItem>({
    getItems: () => this.items(),
    getId: (item) => item.task_id,
    canDrag: (item) => this.canDragProcessing(item),
    getMinSlot: () => {
      // Pin non-pending items (processing/paused/cancelling) at the top
      const items = this.items();
      let pinned = 0;
      while (pinned < items.length && items[pinned].status !== 'pending') pinned++;
      return pinned;
    },
    getSelectedIds: () => this.selectedTaskIds(),
    setSelectedIds: (next) => {
      this.selectedTaskIds.set(next);
      if (next.size) {
        this.layout.clearLibrarySelection$.next();
        this.layout.clearQueueSelection$.next();
      }
    },
    getScrollContainer: () => this.sectionElement()?.nativeElement ?? null,
    getListElement: () => this.trackListElement()?.nativeElement ?? null,
    onDragStart: () => {
      this.layout.clearLibrarySelection$.next();
      this.layout.clearQueueSelection$.next();
    },
    onCommit: (orderedIds) => {
      this.reordered.emit(orderedIds.filter((id) => !id.startsWith('upload:')));
    },
  });

  private readonly marquee = new MarqueeController({
    getBoxHost: () => this.sectionElement()?.nativeElement ?? null,
    getScrollContainer: () => this.sectionElement()?.nativeElement ?? null,
    ignoreSelector: 'li.queue-row, button, a, input, .actions',
    getTargets: () => {
      const container = this.sectionElement()?.nativeElement;
      if (!container) return [];
      const selectable = new Set(this.items().filter((i) => this.canSelect(i)).map((i) => i.task_id));
      return Array.from(container.querySelectorAll<HTMLElement>('li.queue-row[data-task-id]'))
        .map((element) => ({ id: element.getAttribute('data-task-id')!, element }))
        .filter((t) => selectable.has(t.id));
    },
    getSelection: () => this.selectedTaskIds(),
    setSelection: (next) => this.selectedTaskIds.set(next),
    onMarqueeStart: () => {
      this.layout.clearLibrarySelection$.next();
      this.layout.clearQueueSelection$.next();
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

  constructor() {
    this.layout.clearProcessingSelection$
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

  canSelect(item: QueueItem): boolean {
    return item.status === 'pending';
  }

  canDragProcessing(item: QueueItem): boolean {
    return item.status === 'pending' && !this.isUpload(item);
  }

  isUpload(item: QueueItem): boolean {
    return item.task_id.startsWith('upload:');
  }

  rowShiftPx(item: QueueItem): number {
    return this.drag.shiftPxForIndex(this.remainingIndexMap().get(item.task_id) ?? -1);
  }

  onSectionPointerDown(event: PointerEvent): void {
    this.marquee.handlePointerDown(event);
  }

  handleRowClick(item: QueueItem, event: MouseEvent): void {
    if (this.drag.consumeClickSuppression() || !this.canSelect(item)) return;

    const pendingIds = this.items().filter((i) => this.canSelect(i)).map((i) => i.task_id);
    const result = applyExplorerClick(
      pendingIds,
      item.task_id,
      this.selectedTaskIds(),
      this.anchorId,
      { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
      'select-only',
    );
    this.anchorId = result.anchorId;
    this.selectedTaskIds.set(result.selection);

    if (result.selection.size > 0) {
      this.layout.clearLibrarySelection$.next();
      this.layout.clearQueueSelection$.next();
    }
  }

  handleContextMenu(item: QueueItem, event: MouseEvent, actions: QueueItemActions): void {
    if (this.isUpload(item)) return;
    if (this.canSelect(item) && !this.selectedTaskIds().has(item.task_id)) {
      this.selectedTaskIds.set(new Set([item.task_id]));
      this.anchorId = item.task_id;
      this.layout.clearLibrarySelection$.next();
      this.layout.clearQueueSelection$.next();
    }
    actions.openAt(event);
  }

  moveItem(index: number, direction: 'up' | 'down'): void {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    const all = [...this.items()];
    if (targetIndex < 0 || targetIndex >= all.length) return;
    if (all[targetIndex].status !== 'pending') return;
    const [moved] = all.splice(index, 1);
    all.splice(targetIndex, 0, moved);
    this.reordered.emit(all.filter((item) => !this.isUpload(item)).map((i) => i.task_id));
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

    if (event.key === 'Escape' && this.selectedTaskIds().size > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.clearSelection();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      const container = this.sectionElement()?.nativeElement;
      if (container && event.composedPath().includes(container)) {
        event.preventDefault();
        this.selectedTaskIds.set(new Set(this.items().filter((i) => this.canSelect(i)).map((i) => i.task_id)));
        this.layout.clearLibrarySelection$.next();
        this.layout.clearQueueSelection$.next();
      }
    }
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