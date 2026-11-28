import { signal } from '@angular/core';

export interface QueueDragPreview<T> {
  left: number;
  top: number;
  width: number;
  height: number;
  items: T[];
  primary: T;
}

export interface VerticalQueueDragOptions<T> {
  getItems: () => T[];
  getId: (item: T) => string;
  canDrag: (item: T) => boolean;
  getMinSlot: () => number;
  getSelectedIds: () => ReadonlySet<string>;
  setSelectedIds: (next: ReadonlySet<string>) => void;
  getScrollContainer: () => HTMLElement | null;
  getListElement: () => HTMLElement | null;
  onDragStart?: () => void;
  onCommit: (orderedIds: string[], movedIds: string[]) => void;
}

export class VerticalQueueDragController<T> {
  readonly active = signal(false);
  readonly draggedIds = signal<ReadonlySet<string>>(new Set());
  readonly dropSlot = signal(0);
  readonly slotHeight = signal(64);
  readonly preview = signal<QueueDragPreview<T> | null>(null);
  readonly justDroppedIds = signal<ReadonlySet<string>>(new Set());

  private pointerDown = false;
  private suppressClick = false;
  private startClientX = 0;
  private startClientY = 0;
  private currentClientY = 0;
  private grabOffsetY = 0;
  private rowHeight = 60;
  private pendingItem: T | null = null;
  private pendingRowEl: HTMLElement | null = null;
  private draggedItemsList: T[] = [];
  private remainingItemsList: T[] = [];
  private rafId: number | null = null;
  private unstackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: VerticalQueueDragOptions<T>) {}

  consumeClickSuppression(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  handleRowPointerDown(item: T, event: PointerEvent): void {
    if (event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!this.options.canDrag(item)) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, .actions, app-queue-item-actions, app-queue-party-controls')) {
      return;
    }
    const rowEl = (event.currentTarget as HTMLElement | null) ?? target?.closest<HTMLElement>('li.queue-row');
    if (!rowEl) return;

    this.pointerDown = true;
    this.pendingItem = item;
    this.pendingRowEl = rowEl;
    this.startClientX = event.clientX;
    this.startClientY = event.clientY;
    this.currentClientY = event.clientY;
    this.grabOffsetY = event.clientY - rowEl.getBoundingClientRect().top;

    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp, { once: true });
    window.addEventListener('pointercancel', this.onCancel, { once: true });
    window.addEventListener('keydown', this.onKeyDown);
  }

  shiftPxForIndex(remainingIndex: number): number {
    if (!this.active() || remainingIndex < 0) return 0;
    return remainingIndex >= this.dropSlot() ? this.slotHeight() : 0;
  }

  destroy(): void {
    this.teardown();
    if (this.unstackTimer) {
      clearTimeout(this.unstackTimer);
      this.unstackTimer = null;
    }
  }

  private beginDrag(): void {
    const primary = this.pendingItem;
    const rowEl = this.pendingRowEl;
    const listEl = this.options.getListElement();
    const scroller = this.options.getScrollContainer();
    if (!primary || !rowEl || !listEl || !scroller) return;

    const all = this.options.getItems();
    const getId = this.options.getId;
    const primaryId = getId(primary);
    const selected = this.options.getSelectedIds();

    let idsToMove: Set<string>;
    if (selected.has(primaryId) && selected.size > 1) {
      idsToMove = new Set(
        all
          .filter((item) => selected.has(getId(item)) && this.options.canDrag(item))
          .map(getId),
      );
      idsToMove.add(primaryId);
    } else {
      idsToMove = new Set([primaryId]);
      this.options.setSelectedIds(new Set([primaryId]));
    }

    const draggedItems = all.filter((item) => idsToMove.has(getId(item)));
    const remainingItems = all.filter((item) => !idsToMove.has(getId(item)));
    this.draggedItemsList = draggedItems;
    this.remainingItemsList = remainingItems;

    const rowRect = rowEl.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(listEl).rowGap || '4') || 4;
    this.rowHeight = Math.round(rowRect.height);
    const pitch = Math.round(rowRect.height + gap);

    const primaryIdx = all.findIndex((i) => getId(i) === primaryId);
    let initialSlot = 0;
    for (let i = 0; i < primaryIdx; i++) {
      if (!idsToMove.has(getId(all[i]))) initialSlot++;
    }
    initialSlot = Math.max(this.options.getMinSlot(), Math.min(remainingItems.length, initialSlot));

    const scrollerRect = scroller.getBoundingClientRect();
    const listRect = listEl.getBoundingClientRect();
    const viewportTop = this.computePreviewViewportTop(pitch);

    this.slotHeight.set(pitch);
    this.draggedIds.set(idsToMove);
    this.dropSlot.set(initialSlot);
    this.active.set(true);
    this.preview.set({
      left: listRect.left - scrollerRect.left + scroller.scrollLeft,
      top: viewportTop - scrollerRect.top + scroller.scrollTop,
      width: listRect.width,
      height: this.rowHeight,
      items: draggedItems,
      primary,
    });

    this.options.onDragStart?.();
    this.startAutoScrollLoop();
  }

  private computePreviewViewportTop(pitch: number): number {
    const scroller = this.options.getScrollContainer();
    const rawTop = this.currentClientY - this.grabOffsetY;
    if (!scroller) return rawTop;
    const rect = scroller.getBoundingClientRect();
    return Math.max(rect.top + 2, Math.min(rect.bottom - pitch + 4, rawTop));
  }

  private updatePositionAndSlot(): void {
    const listEl = this.options.getListElement();
    const scroller = this.options.getScrollContainer();
    const currentPreview = this.preview();
    if (!listEl || !scroller || !currentPreview) return;

    const pitch = this.slotHeight();
    const scrollerRect = scroller.getBoundingClientRect();
    const listRect = listEl.getBoundingClientRect();
    const viewportTop = this.computePreviewViewportTop(pitch);

    this.preview.set({
      ...currentPreview,
      left: listRect.left - scrollerRect.left + scroller.scrollLeft,
      top: viewportTop - scrollerRect.top + scroller.scrollTop,
      width: listRect.width,
      height: this.rowHeight,
    });

    const centerInListY = viewportTop + pitch / 2 - listRect.top;
    const dragged = this.draggedIds();
    const rows = Array.from(listEl.querySelectorAll<HTMLElement>('li.queue-row[data-task-id]')).filter(
      (row) => !dragged.has(row.getAttribute('data-task-id') ?? ''),
    );

    let slot = 0;
    for (let i = 0; i < rows.length; i++) {
      if (centerInListY > rows[i].offsetTop + pitch) {
        slot = i + 1;
      } else {
        break;
      }
    }

    const minSlot = this.options.getMinSlot();
    const clamped = Math.max(minSlot, Math.min(this.remainingItemsList.length, slot));
    if (this.dropSlot() !== clamped) {
      this.dropSlot.set(clamped);
    }
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pointerDown) return;
    this.currentClientY = event.clientY;

    if (!this.active()) {
      if (Math.hypot(event.clientX - this.startClientX, event.clientY - this.startClientY) < 5) {
        return;
      }
      this.beginDrag();
    }

    event.preventDefault();
    this.updatePositionAndSlot();
  };

  private onPointerUp = (): void => {
    if (!this.active()) {
      this.teardown();
      return;
    }

    const all = this.options.getItems();
    const getId = this.options.getId;
    const slot = Math.max(
      this.options.getMinSlot(),
      Math.min(this.remainingItemsList.length, this.dropSlot()),
    );
    const movedIds = this.draggedItemsList.map(getId);

    const nextItems = [...this.remainingItemsList];
    nextItems.splice(slot, 0, ...this.draggedItemsList);
    const nextIds = nextItems.map(getId);
    const prevIds = all.map(getId);

    this.teardown();
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 80);

    if (nextIds.length !== prevIds.length || new Set(nextIds).size !== prevIds.length) {
      console.error('Queue reorder permutation check failed');
      return;
    }

    const changed = nextIds.some((id, idx) => id !== prevIds[idx]);
    if (changed) {
      this.options.onCommit(nextIds, movedIds);
      this.justDroppedIds.set(new Set(movedIds));
      if (this.unstackTimer) clearTimeout(this.unstackTimer);
      this.unstackTimer = setTimeout(() => {
        this.justDroppedIds.set(new Set());
        this.unstackTimer = null;
      }, 320);
    }
  };

  private onCancel = (): void => {
    this.teardown();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.active()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.teardown();
    }
  };

  private startAutoScrollLoop(): void {
    this.stopAutoScrollLoop();
    const tick = (): void => {
      if (!this.active()) return;
      const scroller = this.options.getScrollContainer();
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const threshold = 85;
        const topDist = this.currentClientY - rect.top;
        const bottomDist = rect.bottom - this.currentClientY;
        let delta = 0;

        if (topDist < threshold) {
          const ratio = Math.min(1, Math.max(0, (threshold - topDist) / threshold));
          delta = -Math.round(ratio * ratio * 30 + 3);
        } else if (bottomDist < threshold) {
          const ratio = Math.min(1, Math.max(0, (threshold - bottomDist) / threshold));
          delta = Math.round(ratio * ratio * 30 + 3);
        }

        if (delta !== 0) {
          const before = scroller.scrollTop;
          scroller.scrollTop += delta;
          if (scroller.scrollTop !== before) {
            this.updatePositionAndSlot();
          }
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopAutoScrollLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private teardown(): void {
    this.pointerDown = false;
    this.pendingItem = null;
    this.pendingRowEl = null;
    this.draggedItemsList = [];
    this.remainingItemsList = [];
    this.active.set(false);
    this.draggedIds.set(new Set());
    this.preview.set(null);
    this.stopAutoScrollLoop();
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('keydown', this.onKeyDown);
  }
}