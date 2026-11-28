export interface ExplorerClickResult {
  selection: ReadonlySet<string>;
  anchorId: string | null;
  activate: boolean;
}

/**
 * Windows Explorer selection rules:
 * - Ctrl+click: toggle item, update anchor.
 * - Shift+click: select contiguous range [anchor..clicked], keep anchor fixed.
 * - Ctrl+Shift+click: add contiguous range [anchor..clicked] to existing selection, keep anchor fixed.
 * - Plain click: either select only the clicked item ('select-only') or clear multi-selection & activate ('clear-and-activate').
 */
export function applyExplorerClick(
  orderedSelectableIds: readonly string[],
  clickedId: string,
  currentSelection: ReadonlySet<string>,
  anchorId: string | null,
  mods: { ctrl: boolean; shift: boolean },
  plainClickBehavior: 'select-only' | 'clear-and-activate',
): ExplorerClickResult {
  const clickedIdx = orderedSelectableIds.indexOf(clickedId);
  if (clickedIdx === -1) {
    return { selection: currentSelection, anchorId, activate: false };
  }

  if (mods.shift) {
    const existingAnchorIdx = anchorId ? orderedSelectableIds.indexOf(anchorId) : -1;
    const effectiveAnchorIdx = existingAnchorIdx >= 0 ? existingAnchorIdx : clickedIdx;
    const nextAnchorId = existingAnchorIdx >= 0 ? anchorId : clickedId;
    const [from, to] =
      effectiveAnchorIdx <= clickedIdx
        ? [effectiveAnchorIdx, clickedIdx]
        : [clickedIdx, effectiveAnchorIdx];
    const range = orderedSelectableIds.slice(from, to + 1);

    if (mods.ctrl) {
      const next = new Set(currentSelection);
      for (const id of range) next.add(id);
      return { selection: next, anchorId: nextAnchorId, activate: false };
    }
    return { selection: new Set(range), anchorId: nextAnchorId, activate: false };
  }

  if (mods.ctrl) {
    const next = new Set(currentSelection);
    if (next.has(clickedId)) next.delete(clickedId);
    else next.add(clickedId);
    return { selection: next, anchorId: clickedId, activate: false };
  }

  if (plainClickBehavior === 'select-only') {
    return { selection: new Set([clickedId]), anchorId: clickedId, activate: false };
  }

  return { selection: new Set(), anchorId: clickedId, activate: true };
}

export interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarqueeTarget {
  id: string;
  element: HTMLElement;
}

export interface MarqueeControllerOptions {
  /** Positioned container that hosts the `.marquee-selection` overlay element. */
  getBoxHost: () => HTMLElement | null;
  /** Element that actually scrolls vertically (may equal `getBoxHost`). */
  getScrollContainer: () => HTMLElement | null;
  /** CSS selector for interactive/item elements that should NOT start a marquee drag. */
  ignoreSelector: string;
  /** Return selectable items currently rendered in the DOM. */
  getTargets: () => MarqueeTarget[];
  /** Current selection before marquee starts. */
  getSelection: () => ReadonlySet<string>;
  /** Apply updated selection during drag. */
  setSelection: (next: ReadonlySet<string>) => void;
  /** Called when marquee starts (e.g., to clear selections in other panels). */
  onMarqueeStart?: () => void;
  /** Called on a plain click (no drag, no Ctrl/Shift) on empty space/gaps. */
  onEmptyClick?: () => void;
  /** Called whenever the visual marquee rectangle changes (or null when hidden). */
  onBoxChange: (box: MarqueeBox | null) => void;
}

/**
 * Windows Explorer-style marquee box controller:
 * Start dragging anywhere outside items (padding, margins, gaps) without holding Ctrl.
 * - Plain drag: replaces selection with intersecting items.
 * - Shift+drag: adds intersecting items to existing selection.
 * - Ctrl+drag: toggles intersecting items against initial selection.
 */
export class MarqueeController {
  private pointerDown = false;
  private active = false;
  private mode: 'replace' | 'add' | 'toggle' = 'replace';
  private startClientX = 0;
  private startClientY = 0;
  private startHostX = 0;
  private startHostY = 0;
  private currentClientX = 0;
  private currentClientY = 0;
  private initialSelection = new Set<string>();
  private rafId: number | null = null;

  constructor(private readonly options: MarqueeControllerOptions) {}

  handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest(this.options.ignoreSelector)) return;

    const host = this.options.getBoxHost();
    if (!host) return;

    this.pointerDown = true;
    this.active = false;
    this.mode = event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace';
    this.startClientX = event.clientX;
    this.startClientY = event.clientY;
    this.currentClientX = event.clientX;
    this.currentClientY = event.clientY;

    const hostRect = host.getBoundingClientRect();
    this.startHostX = event.clientX - hostRect.left + host.scrollLeft;
    this.startHostY = event.clientY - hostRect.top + host.scrollTop;
    this.initialSelection = new Set(this.options.getSelection());

    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp, { once: true });
    window.addEventListener('pointercancel', this.onPointerUp, { once: true });
  }

  destroy(): void {
    this.cleanup();
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pointerDown) return;
    this.currentClientX = event.clientX;
    this.currentClientY = event.clientY;

    if (!this.active) {
      const dist = Math.hypot(event.clientX - this.startClientX, event.clientY - this.startClientY);
      if (dist < 4) return;
      this.active = true;
      this.options.onMarqueeStart?.();
      this.startAutoScrollLoop();
    }

    event.preventDefault();
    this.updateBoxAndSelection();
  };

  private onPointerUp = (): void => {
    const wasActive = this.active;
    const mode = this.mode;
    this.cleanup();
    if (!wasActive && mode === 'replace') {
      this.options.onEmptyClick?.();
    }
  };

  private updateBoxAndSelection(): void {
    const host = this.options.getBoxHost();
    if (!host) return;

    const hostRect = host.getBoundingClientRect();
    const curX = this.currentClientX - hostRect.left + host.scrollLeft;
    const curY = this.currentClientY - hostRect.top + host.scrollTop;

    const left = Math.min(this.startHostX, curX);
    const top = Math.min(this.startHostY, curY);
    const width = Math.abs(curX - this.startHostX);
    const height = Math.abs(curY - this.startHostY);
    const right = left + width;
    const bottom = top + height;

    this.options.onBoxChange({ left, top, width, height });

    const intersecting = new Set<string>();
    for (const { id, element } of this.options.getTargets()) {
      const r = element.getBoundingClientRect();
      const itemLeft = r.left - hostRect.left + host.scrollLeft;
      const itemTop = r.top - hostRect.top + host.scrollTop;
      const itemRight = itemLeft + r.width;
      const itemBottom = itemTop + r.height;

      if (left < itemRight && right > itemLeft && top < itemBottom && bottom > itemTop) {
        intersecting.add(id);
      }
    }

    if (this.mode === 'replace') {
      this.options.setSelection(intersecting);
    } else if (this.mode === 'add') {
      const next = new Set(this.initialSelection);
      for (const id of intersecting) next.add(id);
      this.options.setSelection(next);
    } else {
      // Ctrl+marquee: XOR toggle relative to selection at drag start (Windows Explorer behavior)
      const next = new Set(this.initialSelection);
      for (const id of intersecting) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      this.options.setSelection(next);
    }
  }

  private startAutoScrollLoop(): void {
    this.stopAutoScrollLoop();
    const tick = (): void => {
      if (!this.active) return;
      const scroller = this.options.getScrollContainer();
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const threshold = 85;
        const topDist = this.currentClientY - rect.top;
        const bottomDist = rect.bottom - this.currentClientY;
        let delta = 0;

        if (topDist < threshold) {
          const ratio = Math.min(1, Math.max(0, (threshold - topDist) / threshold));
          delta = -Math.round(ratio * ratio * 28 + 3);
        } else if (bottomDist < threshold) {
          const ratio = Math.min(1, Math.max(0, (threshold - bottomDist) / threshold));
          delta = Math.round(ratio * ratio * 28 + 3);
        }

        if (delta !== 0) {
          const before = scroller.scrollTop;
          scroller.scrollTop += delta;
          if (scroller.scrollTop !== before) {
            this.updateBoxAndSelection();
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

  private cleanup(): void {
    this.pointerDown = false;
    this.active = false;
    this.stopAutoScrollLoop();
    this.options.onBoxChange(null);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }
}