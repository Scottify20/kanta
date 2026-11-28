import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { QueueService } from '../queue/data-access/queue.service';
import { LucideChevronDown, LucideChevronLeft, LucideListMusic, LucideMenu } from '@lucide/angular';

import { SearchBar } from '../../shared/components/search-bar/search-bar';
import { Tooltip } from '../../shared/directives/tooltip';
import { LayoutService } from '../../shared/services/layout.service';
import { ArtistInfoService } from '../../shared/services/artist-info.service';
import { LibraryService, songKey } from '../../shared/services/library.service';
import { EntryActionsService } from '../../shared/services/entry-actions.service';
import { PlaybackActions, isPlayable } from '../../shared/services/playback-actions.service';
import { PlaylistsService } from '../../shared/services/playlists.service';
import { SettingsService } from '../../shared/services/settings.service';
import { PartySessionService } from '../../shared/services/party-session.service';
import { SongManifest, SongsService, songArtist } from '../../shared/services/songs.service';
import { setQueueItemDragImage, writeDragPayload } from '../../shared/util/drag-payload';
import { MarqueeBox, MarqueeController, applyExplorerClick } from '../../shared/util/explorer-selection';
import {
  LibraryEntry,
  LibraryTab,
  SortMode,
  albumEntry,
  artistEntry,
  genreEntries,
  playlistEntry,
  songEntry,
  sortSongsByVocalFit,
  sortArtistSongs,
  sortEntries,
} from './data/library-entries';
import { EntryAction, LibraryItem } from './ui/library-item/library-item';
import { LibraryDetailHeader } from './ui/library-detail-header/library-detail-header';
import { LibraryToolbar } from './ui/library-toolbar/library-toolbar';

@Component({
  selector: 'app-library',
  imports: [
    SearchBar,
    Tooltip,
    LibraryItem,
    LibraryToolbar,
    LibraryDetailHeader,
    NgTemplateOutlet,
    LucideChevronLeft,
    LucideChevronDown,
    LucideListMusic,
    LucideMenu,
  ],
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library {
  protected readonly library = inject(LibraryService);
  private readonly songsService = inject(SongsService);
  private readonly actions = inject(PlaybackActions);
  private readonly entryActions = inject(EntryActionsService);
  private readonly playlistsService = inject(PlaylistsService);
  private readonly settingsService = inject(SettingsService);
  private readonly partySession = inject(PartySessionService);
  protected readonly layoutService = inject(LayoutService);
  private readonly router = inject(Router);
  private readonly queueService = inject(QueueService);
  private readonly artistInfo = inject(ArtistInfoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queueSnapshot = toSignal(this.queueService.queue$, { initialValue: null });

  readonly libraryPage = viewChild<ElementRef<HTMLElement>>('libraryPage');

  readonly artistProgress = computed(() => {
    const sums = new Map<string, { total: number; count: number }>();
    for (const item of this.queueSnapshot()?.processing_queue ?? []) {
      if (!['pending', 'processing', 'paused'].includes(item.status)) continue;
      const name = (item.raw_artist || item.artist || '').trim().toLowerCase();
      if (!name) continue;
      const slot = sums.get(name) ?? { total: 0, count: 0 };
      slot.total += item.status === 'pending' ? 0 : Number(item.progress) || 0;
      slot.count += 1;
      sums.set(name, slot);
    }
    return new Map([...sums].map(([name, { total, count }]) => [name, Math.round(total / count)]));
  });

  readonly processingSongs = computed(() => {
    const active = new Map<string, number>();
    for (const item of this.queueSnapshot()?.processing_queue ?? []) {
      if (!['pending', 'processing', 'paused', 'cancelling'].includes(item.status)) continue;
      active.set(songKey(item), item.status === 'pending' ? 0 : Number(item.progress) || 0);
    }
    return active;
  });

  songProcessing(song: SongManifest): boolean {
    return this.processingSongs().has(songKey(song));
  }

  entryProcessing(entry: LibraryEntry): boolean {
    return entry.kind === 'song' && this.songProcessing(entry.songs[0]);
  }

  songUnavailable(song: SongManifest): boolean {
    return !isPlayable(song) || this.songProcessing(song);
  }

  entryUnavailable(entry: LibraryEntry): boolean {
    return entry.kind === 'song' && this.songUnavailable(entry.songs[0]);
  }

  private withPhoto(entry: LibraryEntry): LibraryEntry {
    const photo = entry.kind === 'artist' ? this.artistInfo.info(entry.title)?.photo_url : null;
    return photo ? { ...entry, covers: [photo] } : entry;
  }

  readonly detailEntry = computed(() => {
    const current = this.detail();
    return current ? this.withPhoto(current) : null;
  });
  readonly detailBio = computed(() => {
    const current = this.detail();
    return current?.kind === 'artist' ? this.artistInfo.info(current.title) : null;
  });

  progressOf(entry: LibraryEntry): number | null {
    if (entry.kind === 'song') return this.processingSongs().get(songKey(entry.songs[0])) ?? null;
    if (entry.kind !== 'artist') return null;
    return this.artistProgress().get(entry.title.trim().toLowerCase()) ?? null;
  }

  readonly tab = this.library.activeTab;
  readonly sort = computed(() => this.library.sorts()[this.tab()]);
  readonly layout = signal<'grid' | 'list'>('grid');
  readonly lyricsFilter = this.library.lyricsFilter;
  readonly detail = signal<LibraryEntry | null>(null);
  readonly selection = signal<ReadonlySet<string>>(new Set());
  readonly selectedKind = signal<string | null>(null);
  readonly collapsedAlbums = signal<ReadonlySet<string>>(new Set());
  readonly playlistDraft = signal<{ id: string | null; name: string } | null>(null);
  readonly actionError = signal('');
  readonly playlists = this.playlistsService.playlists;
  readonly currentTaskId = this.songsService.currentQueueTaskId;
  readonly marqueeBox = signal<MarqueeBox | null>(null);
  readonly marqueeActive = computed(() => this.marqueeBox() !== null);

  private anchorId: string | null = null;
  private skipTabReset = false;
  private detailScrollTop: number | null = null;
  private detailScrollTab: LibraryTab | null = null;
  private previousProcessing = new Set<string>();
  private temporaryDragKey: string | null = null;

  private readonly marquee = new MarqueeController({
    getBoxHost: () => this.libraryPage()?.nativeElement ?? null,
    getScrollContainer: () => this.host.nativeElement.closest<HTMLElement>('.content'),
    ignoreSelector: 'app-library-item, .library-header, app-library-toolbar, app-library-detail-header, .album-heading, .playlist-form, .library-floating-pill, button, input, a',
    getTargets: () => {
      const container = this.libraryPage()?.nativeElement;
      if (!container) return [];
      const visible = this.visibleEntries();
      const elements = Array.from(container.querySelectorAll<HTMLElement>('app-library-item'));
      const targets: { id: string; element: HTMLElement }[] = [];
      elements.forEach((element, idx) => {
        const entry = visible[idx];
        if (entry && !this.entryProcessing(entry)) {
          targets.push({ id: entry.key, element });
        }
      });
      return targets;
    },
    getSelection: () => this.selection(),
    setSelection: (next) => {
      this.selection.set(next);
      if (next.size === 0) {
        this.selectedKind.set(null);
      } else {
        const firstKey = next.values().next().value;
        const firstEntry = this.visibleEntries().find((e) => e.key === firstKey);
        if (firstEntry) this.selectedKind.set(firstEntry.kind);
      }
    },
    onMarqueeStart: () => {
      this.layoutService.clearQueueSelection$.next();
      this.layoutService.clearProcessingSelection$.next();
    },
    onEmptyClick: () => this.clearSelection(),
    onBoxChange: (box) => this.marqueeBox.set(box),
  });

  readonly entries = computed<LibraryEntry[]>(() => {
    const detail = this.detail();
    if (detail) return this.detailSongs(detail);
    switch (this.tab()) {
      case 'albums':
        return sortEntries(this.library.albums().map(albumEntry), this.sort());
      case 'artists':
        return sortEntries(this.library.artists().map((a) => this.withPhoto(artistEntry(a))), this.sort());
      case 'genres':
        return sortEntries(genreEntries(this.library.songs(), this.settingsService.genreDelimiters()), this.sort());
      case 'playlists':
        return sortEntries(
          this.playlists().map((p) => playlistEntry(p, this.library.songByKey())),
          this.sort(),
        );
      default: {
        const songs = this.library.songs().filter((song) => {
          const level = song.lyrics_level ?? 'none';
          const filter = this.lyricsFilter();
          return filter === 'all' || (filter === 'duet' ? song.is_duet === true : level === filter);
        });
        if (this.sort() === 'best-fit') {
          return sortSongsByVocalFit(songs, this.partySession.singerForFitSorting()).map(songEntry);
        }
        return sortEntries(songs.map(songEntry), this.sort());
      }
    }
  });

  readonly effectiveLayout = computed(() =>
    this.detail() || this.tab() === 'songs' ? 'list' : this.layout(),
  );

  readonly visibleEntries = computed(() =>
    this.detail()?.kind === 'artist'
      ? this.entries().filter((entry) => !this.isAlbumCollapsed(entry))
      : this.entries(),
  );

  private readonly visibleIndices = computed(
    () => new Map(this.visibleEntries().map((entry, index) => [entry.key, index])),
  );

  readonly artistGroups = computed(() => {
    if (this.detail()?.kind !== 'artist') return [];
    const groups: { key: string; entries: LibraryEntry[] }[] = [];
    for (const entry of this.entries()) {
      const key = this.albumKey(entry);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.entries.push(entry);
      else groups.push({ key, entries: [entry] });
    }
    return groups;
  });

  albumKey(entry: LibraryEntry): string {
    const song = entry.songs[0];
    return `${this.detail()?.key ?? ''}\u0000${song.artist}\u0000${song.album}`;
  }

  isAlbumCollapsed(entry: LibraryEntry): boolean {
    return this.collapsedAlbums().has(this.albumKey(entry));
  }

  toggleAlbum(entry: LibraryEntry): void {
    const key = this.albumKey(entry);
    const collapsed = new Set(this.collapsedAlbums());
    if (collapsed.has(key)) {
      collapsed.delete(key);
    } else {
      collapsed.add(key);
      const hidden = new Set(this.entries().filter((item) => this.albumKey(item) === key).map((item) => item.key));
      this.selection.update((selected) => new Set([...selected].filter((item) => !hidden.has(item))));
    }
    this.collapsedAlbums.set(collapsed);
    this.anchorId = null;
  }

  visibleIndex(entry: LibraryEntry): number {
    return this.visibleIndices().get(entry.key) ?? -1;
  }

  constructor() {
    void this.library.load(true);
    this.playlistsService.refresh();

    this.layoutService.dropCompleted$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.clearSelection());

    this.layoutService.clearLibrarySelection$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.clearSelection());

    this.destroyRef.onDestroy(() => this.marquee.destroy());

    effect(() => {
      const detail = this.detail();
      if (detail?.kind === 'artist' && detail.songs[0]) this.artistInfo.request(detail.title, detail.songs[0].artist);
      else if (!detail && this.tab() === 'artists') {
        for (const artist of this.library.artists()) this.artistInfo.request(artist.displayArtist, artist.artist);
      }
    });

    effect(() => {
      const active = new Set(this.processingSongs().keys());
      if (untracked(() => [...this.previousProcessing].some((key) => !active.has(key)))) {
        void this.library.load(true).catch((error: unknown) => {
          console.error('Could not refresh library after processing:', error);
          this.actionError.set('Could not refresh the library after processing.');
        });
      }
      this.previousProcessing = active;
    });

    effect(() => {
      this.tab();
      if (this.skipTabReset) {
        this.skipTabReset = false;
        return;
      }
      this.detailScrollTop = null;
      this.detailScrollTab = null;
      this.detail.set(null);
      this.clearSelection();
    });

    effect(() => {
      this.lyricsFilter();
      this.clearSelection();
    });

    effect(() => {
      const key = this.library.pendingOpen();
      if (!key) return;
      const entry = this.findEntry(key);
      if (!entry) {
        if (this.library.loaded()) this.library.pendingOpen.set(null);
        return;
      }
      untracked(() => {
        const tab: LibraryTab =
          entry.kind === 'album' ? 'albums'
            : entry.kind === 'artist' ? 'artists'
              : entry.kind === 'genre' ? 'genres'
                : 'playlists';
        if (this.tab() !== tab) {
          this.skipTabReset = true;
          this.tab.set(tab);
        }
        this.clearSelection();
        this.detailScrollTop = null;
        this.detailScrollTab = null;
        this.detail.set(entry);
        this.library.pendingOpen.set(null);
      });
    });
  }

  @HostListener('pointerdown', ['$event'])
  startMarquee(event: PointerEvent): void {
    this.marquee.handlePointerDown(event);
  }

  clearSelection(): void {
    this.selection.set(new Set());
    this.selectedKind.set(null);
    this.anchorId = null;
  }

  selectOnly(entry: LibraryEntry): void {
    this.layoutService.clearQueueSelection$.next();
    this.layoutService.clearProcessingSelection$.next();
    this.selection.set(new Set([entry.key]));
    this.selectedKind.set(entry.kind);
    this.anchorId = entry.key;
  }

  setSort(mode: SortMode): void {
    this.library.sorts.update((sorts) => ({ ...sorts, [this.tab()]: mode }));
  }

back(): void {
  if (this.detail()) {
    const scrollTop = this.detailScrollTop;
    const tab = this.detailScrollTab;
    this.detailScrollTop = null;
    this.detailScrollTab = null;
    this.detail.set(null);
    this.clearSelection();
    if (scrollTop !== null && tab === this.tab()) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const content = this.host.nativeElement.closest<HTMLElement>('.content');
          if (content?.isConnected && !this.detail() && this.tab() === tab) {
            content.scrollTop = scrollTop;
          }
        });
      });
    }
  } else {
    void this.router.navigateByUrl('/');
  }
}

  isSelected(entry: LibraryEntry): boolean {
    return this.selection().has(entry.key);
  }

  isCurrent(entry: LibraryEntry): boolean {
    const song = this.songsService.currentSong();
    return !!song && entry.kind === 'song' && entry.key === `song:${songKey(song)}`;
  }

  activate(entry: LibraryEntry, _index: number, event: MouseEvent | KeyboardEvent): void {
    if (this.entryProcessing(entry)) return;
    this.layoutService.clearQueueSelection$.next();
    this.layoutService.clearProcessingSelection$.next();

    if (this.selectedKind() !== null && this.selectedKind() !== entry.kind) {
      this.clearSelection();
    }

    const selectableIds = this.visibleEntries()
      .filter((e) => !this.entryProcessing(e))
      .map((e) => e.key);

    const result = applyExplorerClick(
      selectableIds,
      entry.key,
      this.selection(),
      this.anchorId,
      { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
      'clear-and-activate',
    );
    this.anchorId = result.anchorId;
    this.selection.set(result.selection);
    this.selectedKind.set(result.selection.size ? entry.kind : null);

    if (result.activate && !this.entryUnavailable(entry)) {
      this.open(entry);
    }
  }

private open(entry: LibraryEntry): void {
  if (entry.kind === 'song') {
    void this.run(() => this.actions.playSongs(entry.songs));
  } else {
    const content = this.host.nativeElement.closest<HTMLElement>('.content');
    if (!this.detail()) {
      this.detailScrollTop = content?.scrollTop ?? null;
      this.detailScrollTab = this.tab();
    }
    this.detail.set(entry);
    this.clearSelection();
    requestAnimationFrame(() => {
      if (content?.isConnected) content.scrollTop = 0;
    });
  }
}

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if (event.key === 'Escape') {
      if (this.selection().size) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.clearSelection();
      } else if (this.detail()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.back();
      }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      const visible = this.visibleEntries().filter((e) => !this.entryProcessing(e));
      if (visible.length) {
        this.selection.set(new Set(visible.map((e) => e.key)));
        this.selectedKind.set(visible[0].kind);
        this.layoutService.clearQueueSelection$.next();
        this.layoutService.clearProcessingSelection$.next();
      }
    } else if (event.key === 'Enter' && this.selection().size && !event.defaultPrevented) {
      const songs = this.selectedSongs();
      if (songs.length) void this.run(() => this.actions.playSongs(songs));
    }
  }

  onDragStart(event: DragEvent, entry: LibraryEntry): void {
    if (event.ctrlKey || event.metaKey || this.entryUnavailable(entry)) {
      event.preventDefault();
      return;
    }

    let dragged = this.entries().filter((e) => this.selection().has(e.key));
    if (!this.selection().has(entry.key)) {
      dragged = [entry];
      this.temporaryDragKey = entry.key;
    } else {
      this.temporaryDragKey = null;
    }

    const songs = this.playable(this.uniqueSongs(dragged));
    if (!songs.length) {
      event.preventDefault();
      this.temporaryDragKey = null;
      return;
    }

    writeDragPayload(event, songs);
    setQueueItemDragImage(event, {
      songs: dragged.map((e) => ({
        title: e.title,
        artist: e.kind === 'song' ? songArtist(e.songs[0]) : e.subtitle,
        coverUrl: e.covers[0] ?? null,
      })),
      count: songs.length,
    });
    this.layoutService.beginDrag(songs);
  }

  onDragEnd(): void {
    this.layoutService.endDrag();
    if (this.temporaryDragKey) {
      this.selection.update((set) => {
        if (!set.has(this.temporaryDragKey!)) return set;
        const next = new Set(set);
        next.delete(this.temporaryDragKey!);
        return next;
      });
      this.temporaryDragKey = null;
    }
  }

  onAction(entry: LibraryEntry, action: EntryAction): void {
    if (this.entryProcessing(entry)) return;
    const isPlaybackAction = ['play', 'shuffle', 'play-next', 'queue'].includes(action);
    if (isPlaybackAction && this.entryUnavailable(entry)) return;

    if (action === 'rename-playlist' && entry.playlistId) {
      this.playlistDraft.set({ id: entry.playlistId, name: entry.title });
    } else if (action === 'remove-from-playlist') {
      this.removeFromPlaylist(entry);
    } else {
      const ownSongsOnly = ['edit', 'open', 'go-album', 'go-artist'].includes(action);
      const allowUnplayable = ['edit', 'open', 'go-album', 'go-artist', 'delete', 'delete-playlist'].includes(action);
      const source = ownSongsOnly ? entry.songs : this.actionSongs(entry);
      const songs = allowUnplayable ? source : this.playable(source);
      if (!songs.length && action !== 'delete-playlist') return;
      const target = { kind: entry.kind, title: entry.title, songs, playlistId: entry.playlistId };
void this.run(async () => {
     await this.entryActions.perform(target, action);
     if (action === 'delete') {
       this.dropDeletedFromDetail();
     } else if (['queue', 'play-next', 'play', 'shuffle'].includes(action)) {
       this.clearSelection();
     }
   });
    }
  }

  detailAction(action: 'play' | 'shuffle' | 'queue' | 'next', anchor?: HTMLElement | void): void {
    const detail = this.detail();
    if (!detail) return;
    let songs = this.playable(detail.songs);
    const targetAnchor = anchor instanceof HTMLElement ? anchor : null;
    if (action === 'shuffle') songs = [...songs].sort(() => Math.random() - 0.5);
    if (action === 'queue') void this.run(() => this.actions.enqueue(songs, null, false, targetAnchor));
    else if (action === 'next') {
      void this.run(() => this.actions.enqueue(songs, this.songsService.currentQueueTaskId(), true, targetAnchor));
    } else {
      void this.run(() => this.actions.playSongs(songs, targetAnchor));
    }
  }

  savePlaylist(name: string): void {
    const draft = this.playlistDraft();
    const trimmed = name.trim();
    if (!draft || !trimmed) return;
    const request = draft.id
      ? this.playlistsService.rename(draft.id, trimmed)
      : this.playlistsService.create(trimmed);
    request.subscribe({ next: () => this.playlistDraft.set(null) });
  }

  private removeFromPlaylist(entry: LibraryEntry): void {
    const detail = this.detail();
    if (!detail?.playlistId) return;
    const index = detail.songs.findIndex((song) => `song:${songKey(song)}` === entry.key);
    if (index < 0) return;
    this.playlistsService.removeSong(detail.playlistId, index).subscribe(() => {
      this.detail.update((d) =>
        d
          ? {
              ...d,
              songs: d.songs.filter((_, i) => i !== index),
              subtitle: `${d.songs.length - 1} songs`,
            }
          : d,
      );
    });
  }

  private dropDeletedFromDetail(): void {
    const index = this.library.songByKey();
    this.detail.update((d) =>
      d ? { ...d, songs: d.songs.filter((song) => index.has(songKey(song))) } : d,
    );
    this.clearSelection();
  }

  private findEntry(key: string): LibraryEntry | null {
    const album = this.library.albums().find((a) => `album:${a.key}` === key);
    if (album) return albumEntry(album);
    const artist = this.library.artists().find((a) => `artist:${a.key}` === key);
    if (artist) return artistEntry(artist);
    const genre = genreEntries(this.library.songs(), this.settingsService.genreDelimiters()).find((entry) => entry.key === key);
    if (genre) return genre;
    const playlist = this.playlists().find((p) => `playlist:${p.id}` === key);
    return playlist ? playlistEntry(playlist, this.library.songByKey()) : null;
  }

  private detailSongs(detail: LibraryEntry): LibraryEntry[] {
    const index = this.library.songByKey();
    const current = detail.songs.map((song) => index.get(songKey(song))).filter((song): song is SongManifest => !!song);
    const songs = detail.kind === 'artist' || detail.kind === 'genre' ? sortArtistSongs(current) : current;
    if (detail.kind === 'album') {
      songs.sort(
        (a, b) =>
          (a.disc_number ?? 1) - (b.disc_number ?? 1) ||
          (a.track_number ?? 0) - (b.track_number ?? 0),
      );
    }
    return songs.map(songEntry);
  }

  private selectedSongs(): SongManifest[] {
    return this.playable(this.uniqueSongs(this.entries().filter((e) => this.selection().has(e.key))));
  }

  private actionSongs(entry: LibraryEntry): SongManifest[] {
    return this.selection().has(entry.key) ? this.uniqueSongs(this.entries().filter((e) => this.selection().has(e.key))) : entry.songs;
  }

  private uniqueSongs(entries: LibraryEntry[]): SongManifest[] {
    const seen = new Map<string, SongManifest>();
    entries.forEach((e) => e.songs.forEach((song) => seen.set(songKey(song), song)));
    return [...seen.values()];
  }

  private playable(songs: SongManifest[]): SongManifest[] {
    return songs.filter((song) => !this.songUnavailable(song));
  }

  private async run(task: () => Promise<unknown>): Promise<void> {
    this.actionError.set('');
    try {
      await task();
    } catch {
      this.actionError.set('Could not complete that action.');
    }
  }
}