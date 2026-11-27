import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { EntryAction, EntryKind } from '../components/entry-menu/entry-menu';
import { genreKey } from '../../features/library/data/library-entries';
import { LibraryService } from './library.service';
import { PlaybackActions, isPlayable } from './playback-actions.service';
import { PlaylistsService } from './playlists.service';
import { ToastService } from './toast.service';
import { SettingsService } from './settings.service';
import { SongManifest, SongsService, songArtist } from './songs.service';
import { metadataValueKey, splitMetadataValues } from '../util/metadata-delimiters';

export interface ActionTarget {
  kind: EntryKind;
  title: string;
  songs: SongManifest[];
  playlistId?: string;
}

@Injectable({ providedIn: 'root' })
export class EntryActionsService {
  private readonly playback = inject(PlaybackActions);
  private readonly songsService = inject(SongsService);
  private readonly library = inject(LibraryService);
  private readonly playlists = inject(PlaylistsService);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly editingSong = signal<SongManifest | null>(null);
  private activeAnchor: HTMLElement | MouseEvent | null = null;

  setAnchor(anchor: HTMLElement | MouseEvent | null): void {
    this.activeAnchor = anchor;
  }

  async perform(target: ActionTarget, action: EntryAction, anchor?: HTMLElement | MouseEvent): Promise<boolean> {
    const effectiveAnchor = anchor ?? this.activeAnchor;
    this.activeAnchor = null;

    const playable = target.songs.filter(isPlayable);
    if (action === 'play') await this.playback.playSongs(target.songs, effectiveAnchor);
    else if (action === 'shuffle') await this.playback.playSongs(shuffled(target.songs), effectiveAnchor);
    else if (action === 'queue') await this.playback.enqueue(playable, null, false, effectiveAnchor);
    else if (action === 'play-next') {
      await this.playback.enqueue(playable, this.songsService.currentQueueTaskId(), true, effectiveAnchor);
    } else if (action === 'edit') this.editingSong.set(target.songs[0] ?? null);
    else if (action === 'open') this.open(this.keyOf(target));
    else if (action === 'go-album' && target.songs[0]) {
      this.open(`album:${target.songs[0].artist}\u0000${target.songs[0].album}`);
    } else if (action === 'go-artist' && target.songs[0]) {
      const artists = splitMetadataValues(songArtist(target.songs[0]), this.settings.artistDelimiters());
      const artist = artists[0] ?? songArtist(target.songs[0]);
      this.open(`artist:${metadataValueKey(artist)}`);
    } else if (action === 'delete') await this.deleteSongs(target);
    else if (action === 'delete-playlist' && target.playlistId) {
      if (!confirm(`Delete the playlist “${target.title}”?`)) return true;
      await firstValueFrom(this.playlists.delete(target.playlistId));
    } else if (action.startsWith('playlist:')) {
      await this.addToPlaylist(action.slice('playlist:'.length), target.songs);
    } else if (action.startsWith('new-playlist:')) {
      await this.addToNewPlaylist(action.slice('new-playlist:'.length), target.songs);
    } else return false;
    return true;
  }

  async addToPlaylist(id: string, songs: SongManifest[]): Promise<void> {
    try {
      const playlist = await firstValueFrom(this.playlists.addSongs(id, songs));
      this.toast.success(`Added to “${playlist.name}”`);
    } catch {
      this.toast.error('Could not add to the playlist');
    }
  }

  async addToNewPlaylist(name: string, songs: SongManifest[]): Promise<void> {
    try {
      const created = await firstValueFrom(this.playlists.create(name));
      await this.addToPlaylist(created.id, songs);
    } catch {
      this.toast.error('Could not create the playlist');
    }
  }

  open(entryKey: string): void {
    this.library.pendingOpen.set(entryKey);
    void this.router.navigateByUrl('/library');
  }

  private keyOf(target: ActionTarget): string {
    const first = target.songs[0];
    if (target.kind === 'playlist') return `playlist:${target.playlistId}`;
    if (target.kind === 'artist') return `artist:${first?.artist}`;
    if (target.kind === 'genre') return `genre:${genreKey(target.title)}`;
    return `album:${first?.artist}\u0000${first?.album}`;
  }

  private async deleteSongs(target: ActionTarget): Promise<void> {
    const count = target.songs.length;
    if (!count) return;
    const what = count === 1 ? `“${target.title}”` : `${count} songs (${target.title})`;
    if (!confirm(`Permanently delete ${what} from disk? This cannot be undone.`)) return;
    try {
      for (const song of target.songs) await firstValueFrom(this.songsService.deleteSong(song));
    } finally {
      await this.library.load(true);
      this.playlists.refresh();
    }
  }
}

const shuffled = <T>(items: T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};