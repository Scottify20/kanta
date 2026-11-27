import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { SongRef } from './library.service';
import { activeDragSongs } from '../util/drag-payload';

export const KANTA_DRAG_TYPE = 'application/x-kanta-processed';

@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly sidebarOpen = signal(false);
  readonly queueOpen = signal(false);
  readonly dragActive = signal(false);

  readonly dropCompleted$ = new Subject<void>();

  notifyDropped(): void {
    this.dropCompleted$.next();
  }

  toggleSidebar(): void {
    const next = !this.sidebarOpen();
    if (next) this.closeQueue();
    this.sidebarOpen.set(next);
  }

  toggleQueue(): void {
    const next = !this.queueOpen();
    if (next) this.sidebarOpen.set(false);
    this.queueOpen.set(next);
  }

  openQueue(): void {
    this.sidebarOpen.set(false);
    this.queueOpen.set(true);
  }

  closeQueue(): void {
    this.queueOpen.set(false);
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  beginDrag(songs: SongRef[] = []): void {
    if (songs.length) activeDragSongs.set(songs);
    this.dragActive.set(true);
    if (!this.queueOpen()) {
      this.sidebarOpen.set(false);
      this.queueOpen.set(true);
    }
  }

  endDrag(): void {
    this.dragActive.set(false);
    activeDragSongs.set([]);
  }
}