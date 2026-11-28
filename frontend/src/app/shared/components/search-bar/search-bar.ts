import { CdkConnectedOverlay, CdkOverlayOrigin } from '@angular/cdk/overlay';
import { Component, ElementRef, HostListener, computed, effect, inject, input, signal } from '@angular/core';
import { LucideSearch, LucideX } from '@lucide/angular';

import { LibraryService, SearchHit } from '../../services/library.service';
import { EntryActionsService } from '../../services/entry-actions.service';
import { PlaylistsService } from '../../services/playlists.service';
import { EntryAction, EntryMenu } from '../entry-menu/entry-menu';
import { songArtist, songTitle } from '../../services/songs.service';
import { PlaybackActions, isPlayable } from '../../services/playback-actions.service';
import { setQueueItemDragImage, writeDragPayload } from '../../util/drag-payload';
import { sizedImageUrl } from '../../util/image-url';
import { LayoutService } from '../../services/layout.service';
import { ArtistInfoService } from '../../services/artist-info.service';

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
  private readonly artistInfo = inject(ArtistInfoService);
  readonly playlists = this.playlistsService.playlists;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly placeholder = input('Search songs, albums, artists');
  readonly query = signal('');
  readonly focused = signal(false);
  readonly activeIndex = signal(0);
  readonly hits = computed<SearchHit[]>(() =>
    this.library.search(this.query()).map((hit) => this.withArtistPhoto(hit)),
  );
  readonly open = computed(() => this.focused() && this.query().trim().length > 0);

  constructor() {
    effect(() => {
      if (!this.open()) return;
      for (const hit of this.hits()) {
        if (hit.kind === 'artist') this.artistInfo.request(hit.title, hit.songs[0]?.artist);
      }
    });
  }

  onFocus(): void {
    this.focused.set(true);
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
      this.activate(this.hits()[this.activeIndex()]);
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

  activate(hit: SearchHit): void {
    this.focused.set(false);
    if (hit.kind === 'song') {
      void this.actions.playSongs(hit.songs);
    } else {
      this.entryActions.open(hit.key);
    }
  }

  private withArtistPhoto(hit: SearchHit): SearchHit {
    const rawCover = hit.kind === 'artist'
      ? (this.artistInfo.info(hit.title)?.photo_url ?? hit.coverUrl)
      : hit.coverUrl;
    return { ...hit, coverUrl: sizedImageUrl(rawCover, 128) };
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
    const playable = hit.songs.filter(isPlayable);
    if (!playable.length) {
      event.preventDefault();
      return;
    }
    writeDragPayload(event, playable);
    setQueueItemDragImage(event, {
      songs: playable.map((song) => ({
        title: hit.kind === 'song' ? songTitle(song) : hit.title,
        artist: hit.kind === 'song' ? songArtist(song) : hit.subtitle,
        coverUrl: hit.coverUrl,
      })),
    });
    this.layout.beginDrag(playable);
  }

  dragEnd(): void {
    this.layout.endDrag();
  }
}