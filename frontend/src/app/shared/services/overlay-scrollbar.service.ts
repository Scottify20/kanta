import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

const MIN_THUMB = 32;
const IDLE_HIDE_MS = 900;

// Native scrollbars are hidden globally (see styles/_scrollbars.scss); this draws a floating thumb above the
// content so scrollbars never take layout space and grow when hovered.
@Injectable({ providedIn: 'root' })
export class OverlayScrollbarService {
  private readonly doc = inject(DOCUMENT);
  private layer: HTMLElement | null = null;
  private thumb: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  private dragging = false;
  private dragStartY = 0;
  private dragStartScroll = 0;

  constructor() {
    const win = this.doc.defaultView;
    if (!win || typeof win.requestAnimationFrame !== 'function') return;
    this.layer = this.doc.createElement('div');
    this.layer.className = 'kanta-overlay-scrollbar';
    this.thumb = this.doc.createElement('div');
    this.thumb.className = 'kanta-overlay-scrollbar-thumb';
    this.layer.appendChild(this.thumb);
    this.doc.body.appendChild(this.layer);

    this.doc.addEventListener('pointerover', (event) => this.onPointerOver(event), true);
    this.doc.addEventListener('scroll', (event) => this.onScroll(event), true);
    win.addEventListener('resize', () => this.update());
    this.thumb.addEventListener('pointerdown', (event) => this.startDrag(event));
    this.thumb.addEventListener('pointermove', (event) => this.moveDrag(event));
    this.thumb.addEventListener('pointerup', (event) => this.endDrag(event));
    this.thumb.addEventListener('pointercancel', (event) => this.endDrag(event));
    this.thumb.addEventListener('pointerenter', () => this.cancelHide());
    this.thumb.addEventListener('pointerleave', () => this.scheduleHide());
  }

  private onPointerOver(event: PointerEvent): void {
    const node = event.target as Node | null;
    if (!node || (this.layer && this.layer.contains(node)) || this.dragging) return;
    const scroller = this.findScrollable(node instanceof HTMLElement ? node : node.parentElement);
    if (scroller !== this.target) {
      this.target = scroller;
      this.update();
    }
    if (scroller) this.scheduleHide(); else this.hide();
  }

  private onScroll(event: Event): void {
    const el = event.target;
    if (!(el instanceof HTMLElement) || (this.layer && this.layer.contains(el))) return;
    if (this.dragging && el !== this.target) return;
    if (el !== this.target) {
      if (!this.isScrollable(el)) return;
      this.target = el;
    }
    this.update();
    this.scheduleHide();
  }

  private findScrollable(start: HTMLElement | null): HTMLElement | null {
    for (let el = start; el && el !== this.doc.body && el !== this.doc.documentElement; el = el.parentElement) {
      if (this.isScrollable(el)) return el;
    }
    return null;
  }

  private isScrollable(el: HTMLElement): boolean {
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    const style = getComputedStyle(el);
    if (style.getPropertyValue('--no-overlay-scrollbar').trim()) return false;
    const overflow = style.overflowY;
    return overflow === 'auto' || overflow === 'scroll';
  }

  private update(): void {
    const { target, thumb } = this;
    if (!thumb) return;
    if (!target || !target.isConnected || target.scrollHeight <= target.clientHeight + 1) {
      this.hide();
      return;
    }
    const rect = target.getBoundingClientRect();
    const view = this.doc.defaultView;
    // Hidden, collapsed or off-screen targets (e.g. a closing panel) must not leave a stray thumb behind.
    if (
      rect.width < 40 || rect.height < 40 || target.closest('[inert]') ||
      (view && (rect.right <= 0 || rect.left >= view.innerWidth || rect.bottom <= 0 || rect.top >= view.innerHeight))
    ) {
      this.target = null;
      this.hide();
      return;
    }
    const trackHeight = rect.height;
    const ratio = target.clientHeight / target.scrollHeight;
    const thumbHeight = Math.max(MIN_THUMB, trackHeight * ratio);
    const maxScroll = target.scrollHeight - target.clientHeight;
    const top = rect.top + (maxScroll ? (target.scrollTop / maxScroll) * (trackHeight - thumbHeight) : 0);
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translate(${rect.right - 14}px, ${top}px)`;
    thumb.classList.add('visible');
    this.track();
  }

  // Follow the target while visible so layout animations never strand the thumb.
  private track(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.thumb?.classList.contains('visible')) this.update();
    });
  }

  private hide(): void {
    this.cancelHide();
    if (!this.dragging) this.thumb?.classList.remove('visible');
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      if (!this.dragging && !this.thumb?.matches(':hover')) this.hide();
    }, IDLE_HIDE_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private startDrag(event: PointerEvent): void {
    if (!this.target || !this.thumb) return;
    event.preventDefault();
    this.dragging = true;
    this.dragStartY = event.clientY;
    this.dragStartScroll = this.target.scrollTop;
    this.thumb.classList.add('dragging');
    this.thumb.setPointerCapture(event.pointerId);
  }

  private moveDrag(event: PointerEvent): void {
    const { target, thumb } = this;
    if (!this.dragging || !target || !thumb) return;
    const trackHeight = target.clientHeight;
    const thumbHeight = thumb.offsetHeight;
    const scrollable = target.scrollHeight - target.clientHeight;
    const travel = trackHeight - thumbHeight;
    if (travel <= 0) return;
    target.scrollTop = this.dragStartScroll + ((event.clientY - this.dragStartY) / travel) * scrollable;
  }

  private endDrag(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.thumb?.classList.remove('dragging');
    if (this.thumb?.hasPointerCapture(event.pointerId)) this.thumb.releasePointerCapture(event.pointerId);
    this.scheduleHide();
  }
}
