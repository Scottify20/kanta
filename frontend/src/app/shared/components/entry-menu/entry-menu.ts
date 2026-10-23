import { Component, ViewEncapsulation, input, output, signal } from '@angular/core';
import { LucideChevronLeft, LucideChevronRight, LucideMoreHorizontal } from '@lucide/angular';

import { Playlist } from '../../services/playlists.service';
import { PlaylistPicker } from '../playlist-picker/playlist-picker';
import { PopupPanel } from '../popup-panel/popup-panel';

export type EntryKind = 'song' | 'album' | 'artist' | 'playlist';

export type EntryAction =
  | 'play'
  | 'shuffle'
  | 'play-next'
  | 'queue'
  | 'edit'
  | 'delete'
  | 'open'
  | 'go-album'
  | 'go-artist'
  | 'delete-playlist'
  | 'rename-playlist'
  | 'remove-from-playlist'
  | `playlist:${string}`
  | `new-playlist:${string}`;

/** The "…" options menu shared by library items and search results. */
@Component({
  selector: 'app-entry-menu',
  imports: [PopupPanel, PlaylistPicker, LucideMoreHorizontal, LucideChevronLeft, LucideChevronRight],
  templateUrl: './entry-menu.html',
  styleUrl: './entry-menu.scss',
  encapsulation: ViewEncapsulation.None,
  host: { '[class.reveal]': 'revealOnHover()' },
})
export class EntryMenu {
  readonly kind = input.required<EntryKind>();
  readonly popupId = input.required<string>();
  readonly group = input('library');
  readonly playlists = input<Playlist[]>([]);
  readonly inPlaylist = input(false);
  readonly canRename = input(true);
  readonly revealOnHover = input(false);
  readonly action = output<EntryAction>();

  // Nested menu: "Add to playlist" swaps the list for the playlist picker in place.
  readonly view = signal<'main' | 'playlists'>('main');

  pickPlaylist(id: string): void {
    this.action.emit(`playlist:${id}`);
    this.view.set('main');
  }

  createPlaylist(name: string): void {
    this.action.emit(`new-playlist:${name}`);
    this.view.set('main');
  }
}
