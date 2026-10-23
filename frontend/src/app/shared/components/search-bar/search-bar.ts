import { CdkConnectedOverlay, CdkOverlayOrigin } from '@angular/cdk/overlay';
import { Component, ElementRef, HostListener, computed, inject, input, signal } from '@angular/core';
import { LucideSearch, LucideX } from '@lucide/angular';

import { LibraryService, SearchHit } from '../../services/library.service';
import { EntryActionsService } from '../../services/entry-actions.service';
import { PlaylistsService } from '../../services/playlists.service';
import { EntryAction, EntryMenu } from '../entry-menu/entry-menu';
import { songArtist, songTitle } from '../../services/songs.service';
import { PlaybackActions } from '../../services/playback-actions.service';
import { setQueueItemDragImage, writeDragPayload } from '../../util/drag-payload';
import { LayoutService } from '../../services/layout.service';

@Component({
  selector: 'app-search-bar',
  imports: [CdkConnectedOverlay, CdkOverlayOrigin, LucideSearch, LucideX, EntryMenu],
  templateUrl: './search-bar.html',
  styleUrl: './search-bar.scss',
})
export class SearchBar {
  private readonly library = inject(LibraryService);
  private readonly actions = inject(PlaybackActions);
  private readonly layout = inject(LayoutService);
  private readonly entryActions = inject(EntryActionsService);
  private readonly playlistsService = inject(PlaylistsService);
  readonly playlists = this.playlistsService.playlists;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly placeholder = input('Search songs, albums, artists');
  readonly query = signal('');
  readonly focused = signal(false);
  readonly activeIndex = signal(0);
  readonly hits = computed<SearchHit[]>(() => this.library.search(this.query()));
  readonly open = computed(() => this.focused() && this.query().trim().length > 0);

  onFocus(): void {
    this.focused.set(true);
    // The index is cached; this only hits the network the first time or after changes.
    void this.library.load();
    this.playlistsService.refresh();
  }

  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.activeIndex.set(0);
  }

  clear(input: HTMLInputElement): void {
    this.query.set('');
    input.focus();
  }

  onKeydown(event: KeyboardEvent): void {
    const count = this.hits().length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      this.activeIndex.update((i) => (i + 1) % count);
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      this.activeIndex.update((i) => (i - 1 + count) % count);
    } else if (event.key === 'Enter' && count) {
      event.preventDefault();
      this.play(this.hits()[this.activeIndex()]);
    } else if (event.key === 'Escape') {
      (event.target as HTMLInputElement).blur();
      this.focused.set(false);
    }
  }

  @HostListener('document:pointerdown', ['$event'])
  onOutside(event: PointerEvent): void {
    const target = event.target as Node;
    const overlayPane = document.querySelector('.kanta-search-pane');
    const menuPane = (target as Element).closest?.('.kanta-popup-pane');
    if (!this.host.nativeElement.contains(target) && !overlayPane?.contains(target) && !menuPane) {
      this.focused.set(false);
    }
  }

  play(hit: SearchHit): void {
    this.focused.set(false);
    void this.actions.playSongs(hit.songs);
  }

  onAction(hit: SearchHit, action: EntryAction): void {
    const target = { kind: hit.kind, title: hit.title, songs: hit.songs, playlistId: hit.playlistId };
    if (action === 'play' || action === 'shuffle' || action === 'open' || action === 'edit' || action.startsWith('go-')) {
      this.focused.set(false);
    }
    void this.entryActions.perform(target, action);
    if (action === 'queue' || action === 'play-next') this.layout.openQueue();
  }

  dragStart(event: DragEvent, hit: SearchHit): void {
    writeDragPayload(event, hit.songs);
    setQueueItemDragImage(event, {
      songs: hit.songs.map((song) => ({
        title: hit.kind === 'song' ? songTitle(song) : hit.title,
        artist: hit.kind === 'song' ? songArtist(song) : hit.subtitle,
        coverUrl: hit.coverUrl,
      })),
    });
    this.layout.beginDrag();
  }

  dragEnd(): void {
    this.layout.endDrag();
  }
}
