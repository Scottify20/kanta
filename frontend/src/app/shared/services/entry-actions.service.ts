import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { firstValueFrom } from 'rxjs';

import { EntryAction, EntryKind } from '../components/entry-menu/entry-menu';
import { ConfirmDialog } from '../components/confirm-dialog/confirm-dialog';
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
  private readonly overlay = inject(Overlay);

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
      const ok = await this.confirmAction(
        'Delete playlist',
        `Delete the playlist “${target.title}”?`,
      );
      if (!ok) return true;
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
    if (target.kind === 'artist') return `artist:${metadataValueKey(target.title)}`;
    if (target.kind === 'genre') return `genre:${genreKey(target.title)}`;
    return `album:${first?.artist}\u0000${first?.album}`;
  }

  private confirmAction(title: string, message: string, confirmLabel = 'Delete'): Promise<boolean> {
    return new Promise((resolve) => {
      const overlayRef = this.overlay.create({
        hasBackdrop: true,
        backdropClass: 'cdk-overlay-dark-backdrop',
        positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
        scrollStrategy: this.overlay.scrollStrategies.block(),
      });
      const ref = overlayRef.attach(new ComponentPortal(ConfirmDialog));
      ref.setInput('title', title);
      ref.setInput('message', message);
      ref.setInput('confirmLabel', confirmLabel);

      const finish = (result: boolean): void => {
        overlayRef.dispose();
        resolve(result);
      };
      ref.instance.confirmed.subscribe(() => finish(true));
      ref.instance.cancelled.subscribe(() => finish(false));
      overlayRef.backdropClick().subscribe(() => finish(false));
    });
  }

  private async deleteSongs(target: ActionTarget): Promise<void> {
    const count = target.songs.length;
    if (!count) return;
    const what = count === 1 ? `“${target.title}”` : `${count} songs`;
    const ok = await this.confirmAction(
      'Delete from disk',
      `Permanently delete ${what} from disk? This cannot be undone.`,
    );
    if (!ok) return;

    const deleted: SongManifest[] = [];
    let failed = 0;
    for (const song of target.songs) {
      try {
        await firstValueFrom(this.songsService.deleteSong(song));
        deleted.push(song);
      } catch (error: unknown) {
        console.error(`Could not delete "${song.title}":`, error);
        failed++;
      }
    }

    if (deleted.length) {
      this.library.removeSongs(deleted);
      this.playlists.refresh();
      this.toast.success(
        deleted.length === 1 ? `Deleted “${target.title}”.` : `Deleted ${deleted.length} songs.`,
      );
    }
    if (failed) {
      this.toast.error(`Could not delete ${failed} ${failed === 1 ? 'song' : 'songs'}.`);
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