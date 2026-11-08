import { Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';

import { MetadataEditor } from './features/library/ui/metadata-editor/metadata-editor';
import { QueueSheet } from './features/queue/ui/queue-sheet/queue-sheet';
import { MiniLyrics } from './features/now-playing/ui/mini-lyrics/mini-lyrics';
import { NowPlaying } from './features/now-playing/now-playing';
import { Backdrop } from './shared/components/backdrop/backdrop';
import { ToastHost } from './shared/components/toast-host/toast-host';
import { SetupModal } from './shared/components/setup-modal/setup-modal';
import { Sidebar } from './shared/components/sidebar/sidebar';
import { AudioPlayerService } from './shared/services/audio-player.service';
import { FullscreenService } from './shared/services/fullscreen.service';
import { KANTA_DRAG_TYPE, LayoutService } from './shared/services/layout.service';
import { OverlayScrollbarService } from './shared/services/overlay-scrollbar.service';
import { autoScrollDuringDrag } from './shared/util/drag-autoscroll';
import { EntryActionsService } from './shared/services/entry-actions.service';
import { LibraryService } from './shared/services/library.service';
import { SetupService } from './shared/services/setup.service';
import { SongsService } from './shared/services/songs.service';
import { QueueItem } from './features/queue/interfaces/queue.models';
import { PopupStateService } from './shared/services/popup-state.service';
import { ToastService } from './shared/services/toast.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Backdrop, Sidebar, QueueSheet, SetupModal, ToastHost, MetadataEditor, MiniLyrics, NowPlaying],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly layout = inject(LayoutService);
  readonly songs = inject(SongsService);
  readonly audioPlayer = inject(AudioPlayerService);
  readonly setup = inject(SetupService);
  readonly entryActions = inject(EntryActionsService);
  readonly library = inject(LibraryService);
  private readonly router = inject(Router);
  private readonly route = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  readonly playerVisible = computed(() =>
    (this.router.parseUrl(this.route()).root.children['primary']?.segments.length ?? 0) === 0,
  );
  private readonly fullscreen = inject(FullscreenService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlayScrollbar = inject(OverlayScrollbarService);
  private readonly popups = inject(PopupStateService);
  private readonly toast = inject(ToastService);
  readonly contextMenu = signal<{
    x: number;
    y: number;
    input: HTMLInputElement | HTMLTextAreaElement | null;
    selection: string;
    start: number;
    end: number;
    value: string;
  } | null>(null);
  // The developer log window loads /logs directly and shows only the log viewer, without the app chrome.
  readonly logsWindow = typeof location !== 'undefined' && location.pathname.startsWith('/logs');

  @HostListener('document:contextmenu', ['$event'])
  onContextMenu(event: MouseEvent): void {
    if (event.defaultPrevented) {
      this.contextMenu.set(null);
      return;
    }
    event.preventDefault();
    this.popups.closeAll();
    const target = event.target instanceof Element ? event.target.closest('input, textarea') : null;
    const candidate = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
    const input = candidate && candidate.selectionStart !== null ? candidate : null;
    const secret = input instanceof HTMLInputElement && input.type === 'password';
    const selection = input
      ? secret ? '' : input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)
      : window.getSelection()?.toString() ?? '';
    this.contextMenu.set({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 200)),
      input,
      selection,
      start: input?.selectionStart ?? 0,
      end: input?.selectionEnd ?? 0,
      value: input?.value ?? '',
    });
  }

  @HostListener('document:click')
  @HostListener('document:keydown.escape')
  closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  async clipboardAction(action: 'copy' | 'cut' | 'paste'): Promise<void> {
    const context = this.contextMenu();
    if (!context) return;
    this.contextMenu.set(null);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable');
      if (action === 'paste') {
        const text = await navigator.clipboard.readText();
        if (!context.input || context.input.readOnly || context.input.disabled) {
          throw new Error('The text field is no longer editable');
        }
        if (context.input.value !== context.value) throw new Error('Text changed while accessing the clipboard');
        context.input.setRangeText(text, context.start, context.end, 'end');
        context.input.dispatchEvent(new Event('input', { bubbles: true }));
        context.input.focus();
      } else {
        await navigator.clipboard.writeText(context.selection);
        if (action === 'cut') {
          if (!context.input || context.input.readOnly || context.input.disabled) {
            throw new Error('The text field is no longer editable');
          }
          if (context.input.value !== context.value) throw new Error('Text changed while accessing the clipboard');
          context.input.setRangeText('', context.start, context.end, 'end');
          context.input.dispatchEvent(new Event('input', { bubbles: true }));
          context.input.focus();
        }
      }
    } catch (error) {
      console.error(`Clipboard ${action} failed:`, error);
      this.toast.error(`Could not ${action}. Check clipboard permissions and try again.`);
    }
  }

  selectContextInput(): void {
    const input = this.contextMenu()?.input;
    this.contextMenu.set(null);
    input?.focus();
    input?.select();
  }

  openContextLibrary(): void {
    this.contextMenu.set(null);
    void this.router.navigateByUrl('/library');
  }

  openContextQueue(): void {
    this.contextMenu.set(null);
    this.layout.toggleQueue();
  }

  @HostListener('document:keydown', ['$event'])
  onPlaybackShortcut(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (
      this.logsWindow || event.code !== 'Space' || event.repeat || event.defaultPrevented ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      target?.isContentEditable || target?.closest('input, textarea, select, button, a, [role="button"], [role="slider"]')
    ) return;
    if (this.audioPlayer.isPlaying()) {
      event.preventDefault();
      this.audioPlayer.pause();
    } else if (this.audioPlayer.hasStems) {
      event.preventDefault();
      void this.audioPlayer.play().catch((error) => console.error('Playback failed:', error));
    } else {
      const song = this.songs.currentSong();
      if (!song) return;
      event.preventDefault();
      this.songs.selectSong(song, true, this.songs.currentQueueTaskId());
      void this.router.navigateByUrl('/');
    }
  }

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
    // Pressing a draggable item may be the start of a drag towards the queue, so it must not dismiss the sheet.
    if (target.closest('[draggable="true"]')) return;
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
