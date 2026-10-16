import { Injectable, signal } from '@angular/core';

export const KANTA_DRAG_TYPE = 'application/x-kanta-processed';

@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly sidebarOpen = signal(false);
  readonly queueOpen = signal(false);
  // True while a library item (or file) is being dragged towards the queue.
  readonly dragActive = signal(false);
  private queueAutoOpened = false;

  toggleSidebar(): void {
    this.sidebarOpen.update((open) => !open);
  }

  toggleQueue(): void {
    this.queueAutoOpened = false;
    this.queueOpen.update((open) => !open);
  }

  openQueue(): void {
    this.queueAutoOpened = false;
    this.queueOpen.set(true);
  }

  closeQueue(): void {
    this.queueAutoOpened = false;
    this.queueOpen.set(false);
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  beginDrag(): void {
    this.dragActive.set(true);
    if (!this.queueOpen()) {
      this.queueAutoOpened = true;
      this.queueOpen.set(true);
    }
  }

  endDrag(): void {
    this.dragActive.set(false);
    if (this.queueAutoOpened) {
      this.queueAutoOpened = false;
      this.queueOpen.set(false);
    }
  }
}
