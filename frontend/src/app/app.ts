import { Component, ElementRef, HostListener, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';

import { QueueSheet } from './features/queue/ui/queue-sheet/queue-sheet';
import { Backdrop } from './shared/components/backdrop/backdrop';
import { SetupModal } from './shared/components/setup-modal/setup-modal';
import { Sidebar } from './shared/components/sidebar/sidebar';
import { AudioPlayerService } from './shared/services/audio-player.service';
import { KANTA_DRAG_TYPE, LayoutService } from './shared/services/layout.service';
import { OverlayScrollbarService } from './shared/services/overlay-scrollbar.service';
import { autoScrollDuringDrag } from './shared/util/drag-autoscroll';
import { SetupService } from './shared/services/setup.service';
import { SongsService } from './shared/services/songs.service';
import { QueueItem } from './features/queue/interfaces/queue.models';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Backdrop, Sidebar, QueueSheet, SetupModal],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly layout = inject(LayoutService);
  readonly songs = inject(SongsService);
  readonly audioPlayer = inject(AudioPlayerService);
  readonly setup = inject(SetupService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlayScrollbar = inject(OverlayScrollbarService);

  @HostListener('document:dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (types.includes(KANTA_DRAG_TYPE) || types.includes('Files')) {
      if (!this.layout.dragActive()) this.layout.beginDrag();
      event.preventDefault();
      autoScrollDuringDrag(event, this.host.nativeElement.querySelectorAll<HTMLElement>('.content, .queue-section'));
    }
  }

  // Clicking the content area dismisses open panels; overlays, toggles and drags are ignored.
  @HostListener('document:pointerdown', ['$event'])
  onOutsidePointer(event: PointerEvent): void {
    if (!this.layout.sidebarOpen() && !this.layout.queueOpen()) return;
    if (this.layout.dragActive() || event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target?.isConnected) return;
    if (target.closest('.panel, .cdk-overlay-container, [aria-expanded], [role="dialog"], dialog')) return;
    this.layout.closeSidebar();
    this.layout.closeQueue();
  }

  @HostListener('document:dragend')
  @HostListener('document:drop')
  onDragFinished(): void {
    if (this.layout.dragActive()) this.layout.endDrag();
  }

  selectQueueTrack(item: QueueItem): void {
    this.songs.requestQueueTrack(item);
    void this.router.navigateByUrl('/');
  }
}
