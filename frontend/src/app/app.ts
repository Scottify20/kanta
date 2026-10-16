import { Component, HostListener, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';

import { QueueSheet } from './features/queue/ui/queue-sheet/queue-sheet';
import { Backdrop } from './shared/components/backdrop/backdrop';
import { Sidebar } from './shared/components/sidebar/sidebar';
import { AudioPlayerService } from './shared/services/audio-player.service';
import { KANTA_DRAG_TYPE, LayoutService } from './shared/services/layout.service';
import { SongsService } from './shared/services/songs.service';
import { QueueItem } from './features/queue/interfaces/queue.models';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Backdrop, Sidebar, QueueSheet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly layout = inject(LayoutService);
  readonly songs = inject(SongsService);
  readonly audioPlayer = inject(AudioPlayerService);
  private readonly router = inject(Router);

  @HostListener('document:dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (types.includes(KANTA_DRAG_TYPE) || types.includes('Files')) {
      if (!this.layout.dragActive()) this.layout.beginDrag();
      event.preventDefault();
    }
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
