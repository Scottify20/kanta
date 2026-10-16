import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { LucideChevronLeft, LucideMenu } from '@lucide/angular';

import { SearchBar } from '../../shared/components/search-bar/search-bar';
import { Tooltip } from '../../shared/directives/tooltip';
import { LayoutService } from '../../shared/services/layout.service';
import { LibraryService, SongRef, songKey } from '../../shared/services/library.service';
import { PlaybackActions, isPlayable } from '../../shared/services/playback-actions.service';
import { PlaylistsService } from '../../shared/services/playlists.service';
import { SongManifest, SongsService, songArtist } from '../../shared/services/songs.service';
import { setQueueItemDragImage, writeDragPayload } from '../../shared/util/drag-payload';
import {
  LibraryEntry,
  LibraryTab,
  SORT_MODES,
  SortMode,
  albumEntry,
  artistEntry,
  playlistEntry,
  songEntry,
  sortEntries,
} from './data/library-entries';
import { EntryAction, LibraryItem } from './ui/library-item/library-item';
import { LibraryDetailHeader } from './ui/library-detail-header/library-detail-header';
import { LibraryToolbar } from './ui/library-toolbar/library-toolbar';
import { MetadataEditor } from './ui/metadata-editor/metadata-editor';

@Component({
  selector: 'app-library',
  imports: [
    SearchBar,
    Tooltip,
    LibraryItem,
    LibraryToolbar,
    LibraryDetailHeader,
    MetadataEditor,
    LucideChevronLeft,
    LucideMenu,
  ],
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library {
  private readonly library = inject(LibraryService);
  private readonly songsService = inject(SongsService);
  private readonly actions = inject(PlaybackActions);
  private readonly playlistsService = inject(PlaylistsService);
  protected readonly layoutService = inject(LayoutService);
  private readonly router = inject(Router);

  readonly tab = signal<LibraryTab>('songs');
  readonly sort = signal<SortMode>('az');
  readonly layout = signal<'grid' | 'list'>('grid');
  readonly detail = signal<LibraryEntry | null>(null);
  readonly selection = signal<ReadonlySet<string>>(new Set());
  readonly editingSong = signal<SongManifest | null>(null);
  readonly playlistDraft = signal<{ id: string | null; name: string } | null>(null);
  readonly actionError = signal('');
  readonly playlists = this.playlistsService.playlists;
  readonly currentTaskId = this.songsService.currentQueueTaskId;
  private anchorIndex = -1;

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
        return sortEntries(this.library.artists().map(artistEntry), this.sort());
      case 'playlists':
        return sortEntries(
          this.playlists().map((p) => playlistEntry(p, this.songIndex())),
          this.sort(),
        );
      default:
        return sortEntries(this.library.songs().map(songEntry), this.sort());
    }
  });
  readonly effectiveLayout = computed(() =>
    this.detail() || this.tab() === 'songs' ? 'list' : this.layout(),
  );

  constructor() {
    void this.library.load(true);
    this.playlistsService.refresh();
    effect(() => {
      // Switching tabs resets the drill-down and the selection.
      const tab = this.tab();
      if (!SORT_MODES[tab].includes(untracked(this.sort))) this.sort.set('az');
      this.detail.set(null);
      this.selection.set(new Set());
    });
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
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey && this.anchorIndex >= 0) {
      const [from, to] = [this.anchorIndex, index].sort((a, b) => a - b);
      this.selection.set(
        new Set(
          this.entries()
            .slice(from, to + 1)
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
      this.selection.set(new Set(this.entries().map((e) => e.key)));
    } else if (event.key === 'Escape') {
      if (this.selection().size) this.selection.set(new Set());
      else if (this.detail()) this.back();
    } else if (event.key === 'Enter' && this.selection().size && !event.defaultPrevented) {
      const songs = this.selectedSongs();
      if (songs.length) void this.run(() => this.actions.playSongs(songs));
    }
  }

  onDragStart(event: DragEvent, entry: LibraryEntry): void {
    let dragged = this.entries().filter((e) => this.selection().has(e.key));
    if (!this.selection().has(entry.key)) {
      dragged = [entry];
      this.selection.set(new Set([entry.key]));
    }
    const songs = this.uniqueSongs(dragged).filter(isPlayable);
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
    const songs = this.actionSongs(entry);
    if (action === 'play') void this.run(() => this.actions.playSongs(songs));
    else if (action === 'queue') void this.run(() => this.actions.enqueue(this.playable(songs)));
    else if (action === 'play-next') {
      void this.run(() =>
        this.actions.enqueue(this.playable(songs), this.songsService.currentQueueTaskId(), true),
      );
    } else if (action === 'edit') this.editingSong.set(entry.songs[0]);
    else if (action === 'delete-playlist' && entry.playlistId) {
      this.playlistsService.delete(entry.playlistId).subscribe();
    } else if (action === 'rename-playlist' && entry.playlistId) {
      this.playlistDraft.set({ id: entry.playlistId, name: entry.title });
    } else if (action === 'remove-from-playlist') this.removeFromPlaylist(entry);
    else if (action.startsWith('playlist:')) {
      this.playlistsService.addSongs(action.slice('playlist:'.length), songs).subscribe({
        error: () => this.actionError.set('Could not add to the playlist.'),
      });
    }
  }

  detailAction(action: 'play' | 'shuffle' | 'queue'): void {
    const detail = this.detail();
    if (!detail) return;
    let songs = this.playable(detail.songs);
    if (action === 'shuffle') songs = [...songs].sort(() => Math.random() - 0.5);
    if (action === 'queue') void this.run(() => this.actions.enqueue(songs));
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

  onSongSaved(): void {
    void this.library.load(true);
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

  private detailSongs(detail: LibraryEntry): LibraryEntry[] {
    const songs = [...detail.songs];
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
    return this.uniqueSongs(this.entries().filter((e) => this.selection().has(e.key)));
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
    return songs.filter(isPlayable);
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
