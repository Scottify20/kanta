import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { QueueService } from '../queue/data-access/queue.service';
import { LucideChevronDown, LucideChevronLeft, LucideListMusic, LucideMenu } from '@lucide/angular';

import { SearchBar } from '../../shared/components/search-bar/search-bar';
import { Tooltip } from '../../shared/directives/tooltip';
import { LayoutService } from '../../shared/services/layout.service';
import { ArtistInfoService } from '../../shared/services/artist-info.service';
import { LibraryService, SongRef, songKey } from '../../shared/services/library.service';
import { EntryActionsService } from '../../shared/services/entry-actions.service';
import { PlaybackActions, isPlayable } from '../../shared/services/playback-actions.service';
import { PlaylistsService } from '../../shared/services/playlists.service';
import { SongManifest, SongsService, songArtist } from '../../shared/services/songs.service';
import { setQueueItemDragImage, writeDragPayload } from '../../shared/util/drag-payload';
import {
  LibraryEntry,
  LibraryTab,
  SortMode,
  albumEntry,
  artistEntry,
  playlistEntry,
  songEntry,
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
  protected readonly layoutService = inject(LayoutService);
  private readonly router = inject(Router);
  private readonly queueService = inject(QueueService);
  private readonly artistInfo = inject(ArtistInfoService);
  private readonly queueSnapshot = toSignal(this.queueService.queue$, { initialValue: null });

  // Average processing progress per artist (lower-cased name) for songs still in the processing queue.
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

  songUnavailable(song: SongManifest): boolean {
    return !isPlayable(song) || this.processingSongs().has(songKey(song));
  }

  entryUnavailable(entry: LibraryEntry): boolean {
    return entry.kind === 'song' && this.songUnavailable(entry.songs[0]);
  }

  private withPhoto(entry: LibraryEntry): LibraryEntry {
    const photo = entry.kind === 'artist' ? this.artistInfo.info(entry.title)?.photo_url : null;
    return photo ? { ...entry, covers: [photo] } : entry;
  }

  // The open detail entry; artists get their photo and biography from the lookup service.
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

  readonly tab = signal<LibraryTab>('songs');
  readonly sort = computed(() => this.library.sorts()[this.tab()]);
  readonly layout = signal<'grid' | 'list'>('grid');
  readonly lyricsFilter = this.library.lyricsFilter;
  readonly detail = signal<LibraryEntry | null>(null);
  readonly selection = signal<ReadonlySet<string>>(new Set());
  readonly collapsedAlbums = signal<ReadonlySet<string>>(new Set());
  readonly playlistDraft = signal<{ id: string | null; name: string } | null>(null);
  readonly actionError = signal('');
  readonly playlists = this.playlistsService.playlists;
  readonly currentTaskId = this.songsService.currentQueueTaskId;
  private anchorIndex = -1;
  private skipTabReset = false;
  private previousProcessing = new Set<string>();

  private readonly songIndex = computed(
    () => new Map(this.library.songs().map((song) => [songKey(song), song])),
  );

  readonly entries = computed<LibraryEntry[]>(() => {
    const detail = this.detail();
    if (detail) return this.detailSongs(detail);
    switch (this.tab()) {
      case 'albums':
        return sortEntries(this.library.albums().map(albumEntry), this.sort());
      case 'artists':
        return sortEntries(this.library.artists().map((a) => this.withPhoto(artistEntry(a))), this.sort());
      case 'playlists':
        return sortEntries(
          this.playlists().map((p) => playlistEntry(p, this.songIndex())),
          this.sort(),
        );
      default:
        return sortEntries(
          this.library.songs().filter((song) => {
            const level = song.lyrics_level ?? 'none';
            const filter = this.lyricsFilter();
            return filter === 'all' || (filter === 'duet' ? song.is_duet === true : level === filter);
          }).map(songEntry),
          this.sort(),
        );
    }
  });
  readonly effectiveLayout = computed(() =>
    this.detail() || this.tab() === 'songs' ? 'list' : this.layout(),
  );
  readonly visibleEntries = computed(() => this.detail()?.kind === 'artist'
    ? this.entries().filter((entry) => !this.isAlbumCollapsed(entry))
    : this.entries());
  private readonly visibleIndices = computed(() => new Map(this.visibleEntries().map((entry, index) => [entry.key, index])));
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
    this.anchorIndex = -1;
  }

  visibleIndex(entry: LibraryEntry): number {
    return this.visibleIndices().get(entry.key) ?? -1;
  }

  constructor() {
    void this.library.load(true);
    this.playlistsService.refresh();
    effect(() => {
      // Look up photos and bios for the artists on screen.
      const detail = this.detail();
      if (detail?.kind === 'artist') this.artistInfo.request(detail.title);
      else if (!detail && this.tab() === 'artists') {
        for (const artist of this.library.artists()) this.artistInfo.request(artist.displayArtist);
      }
    });
    effect(() => {
      // New songs land in the library as processing finishes.
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
      // Switching tabs resets the drill-down and the selection.
      this.tab();
      if (this.skipTabReset) {
        this.skipTabReset = false;
        return;
      }
      this.detail.set(null);
      this.selection.set(new Set());
    });
    effect(() => {
      this.lyricsFilter();
      this.selection.set(new Set());
      this.anchorIndex = -1;
    });
    effect(() => {
      // "View album / Go to artist…" from a menu or search result opens that entry here.
      const key = this.library.pendingOpen();
      if (!key) return;
      const entry = this.findEntry(key);
      if (!entry) {
        if (this.library.loaded()) this.library.pendingOpen.set(null);
        return;
      }
      untracked(() => {
        const tab: LibraryTab =
          entry.kind === 'album' ? 'albums' : entry.kind === 'artist' ? 'artists' : 'playlists';
        if (this.tab() !== tab) {
          this.skipTabReset = true;
          this.tab.set(tab);
        }
        this.selection.set(new Set());
        this.detail.set(entry);
        this.library.pendingOpen.set(null);
      });
    });
  }

  setSort(mode: SortMode): void {
    this.library.sorts.update((sorts) => ({ ...sorts, [this.tab()]: mode }));
  }

  back(): void {
    if (this.detail()) {
      this.detail.set(null);
      this.selection.set(new Set());
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

  activate(entry: LibraryEntry, index: number, event: MouseEvent | KeyboardEvent): void {
    if (this.entryUnavailable(entry)) return;
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && this.anchorIndex >= 0) {
      const [from, to] = [this.anchorIndex, index].sort((a, b) => a - b);
      this.selection.set(
        new Set(
          this.visibleEntries()
            .slice(from, to + 1)
            .filter((e) => !this.entryUnavailable(e))
            .map((e) => e.key),
        ),
      );
      return;
    }
    if (additive || this.selection().size > 0) {
      this.toggleSelection(entry);
      this.anchorIndex = index;
      return;
    }
    this.anchorIndex = index;
    this.open(entry);
  }

  private toggleSelection(entry: LibraryEntry): void {
    const next = new Set(this.selection());
    next.has(entry.key) ? next.delete(entry.key) : next.add(entry.key);
    this.selection.set(next);
  }

  private open(entry: LibraryEntry): void {
    if (entry.kind === 'song') {
      void this.run(() => this.actions.playSongs(entry.songs));
    } else {
      this.detail.set(entry);
      this.selection.set(new Set());
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selection.set(new Set(this.visibleEntries().filter((e) => !this.entryUnavailable(e)).map((e) => e.key)));
    } else if (event.key === 'Escape') {
      if (this.selection().size) this.selection.set(new Set());
      else if (this.detail()) this.back();
    } else if (event.key === 'Enter' && this.selection().size && !event.defaultPrevented) {
      const songs = this.selectedSongs();
      if (songs.length) void this.run(() => this.actions.playSongs(songs));
    }
  }

  onDragStart(event: DragEvent, entry: LibraryEntry): void {
    if (this.entryUnavailable(entry)) { event.preventDefault(); return; }
    let dragged = this.entries().filter((e) => this.selection().has(e.key));
    if (!this.selection().has(entry.key)) {
      dragged = [entry];
      this.selection.set(new Set([entry.key]));
    }
    const songs = this.playable(this.uniqueSongs(dragged));
    if (!songs.length) {
      event.preventDefault();
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
    this.layoutService.beginDrag();
  }

  onDragEnd(): void {
    this.layoutService.endDrag();
  }

  onAction(entry: LibraryEntry, action: EntryAction): void {
    if (this.entryUnavailable(entry)) return;
    if (action === 'rename-playlist' && entry.playlistId) {
      this.playlistDraft.set({ id: entry.playlistId, name: entry.title });
    } else if (action === 'remove-from-playlist') this.removeFromPlaylist(entry);
    else {
      const ownSongsOnly = ['edit', 'open', 'go-album', 'go-artist'].includes(action);
      const songs = ownSongsOnly ? entry.songs : this.playable(this.actionSongs(entry));
      const target = { kind: entry.kind, title: entry.title, songs, playlistId: entry.playlistId };
      void this.run(async () => {
        await this.entryActions.perform(target, action);
        if (action === 'delete') this.dropDeletedFromDetail();
      });
    }
  }

  detailAction(action: 'play' | 'shuffle' | 'queue' | 'next'): void {
    const detail = this.detail();
    if (!detail) return;
    let songs = this.playable(detail.songs);
    if (action === 'shuffle') songs = [...songs].sort(() => Math.random() - 0.5);
    if (action === 'queue') void this.run(() => this.actions.enqueue(songs));
    else if (action === 'next') {
      void this.run(() => this.actions.enqueue(songs, this.songsService.currentQueueTaskId(), true));
    }
    else void this.run(() => this.actions.playSongs(songs));
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
    const index = this.songIndex();
    this.detail.update((d) =>
      d ? { ...d, songs: d.songs.filter((song) => index.has(songKey(song))) } : d,
    );
    this.selection.set(new Set());
  }

  private findEntry(key: string): LibraryEntry | null {
    const album = this.library.albums().find((a) => `album:${a.key}` === key);
    if (album) return albumEntry(album);
    const artist = this.library.artists().find((a) => `artist:${a.key}` === key);
    if (artist) return artistEntry(artist);
    const playlist = this.playlists().find((p) => `playlist:${p.id}` === key);
    return playlist ? playlistEntry(playlist, this.songIndex()) : null;
  }

  private detailSongs(detail: LibraryEntry): LibraryEntry[] {
    const current = detail.songs.map((song) => this.songIndex().get(songKey(song))).filter((song): song is SongManifest => !!song);
    const songs = detail.kind === 'artist' ? sortArtistSongs(current) : current;
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
    return this.selection().has(entry.key) ? this.selectedSongs() : entry.songs;
  }

  private uniqueSongs(entries: LibraryEntry[]): SongManifest[] {
    const seen = new Map<string, SongManifest>();
    entries.forEach((e) => e.songs.forEach((song) => seen.set(songKey(song), song)));
    return [...seen.values()];
  }

  private playable(songs: SongManifest[]): SongManifest[] {
    return songs.filter((song) => !this.songUnavailable(song));
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.actionError.set('');
    try {
      await task();
    } catch {
      this.actionError.set('Could not complete that action.');
    }
  }
}
