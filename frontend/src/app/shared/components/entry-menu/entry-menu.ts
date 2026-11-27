import { Component, ViewEncapsulation, inject, input, output, viewChild } from '@angular/core';
import { LucideChevronRight, LucideMoreHorizontal } from '@lucide/angular';

import { Playlist } from '../../services/playlists.service';
import { PlaylistPicker } from '../playlist-picker/playlist-picker';
import { PopupPanel } from '../popup-panel/popup-panel';
import { ContextMenu } from '../context-menu/context-menu';
import { EntryActionsService } from '../../services/entry-actions.service';

export type EntryKind = 'song' | 'album' | 'artist' | 'genre' | 'playlist';

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

@Component({
  selector: 'app-entry-menu',
  imports: [PopupPanel, PlaylistPicker, ContextMenu, LucideMoreHorizontal, LucideChevronRight],
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

  private readonly popup = viewChild.required(PopupPanel);
  private readonly contextMenu = viewChild<ContextMenu>('menu');
  private readonly entryActions = inject(EntryActionsService, { optional: true });

  openAt(event: MouseEvent): void {
    this.contextMenu()?.reset();
    this.popup().openAt(event);
  }

  triggerAction(act: EntryAction, event: MouseEvent): void {
    this.entryActions?.setAnchor(event.currentTarget as HTMLElement);
    this.action.emit(act);
  }

  pickPlaylist(id: string, menu: ContextMenu): void {
    this.action.emit(`playlist:${id}`);
    menu.reset();
  }

  createPlaylist(name: string, menu: ContextMenu): void {
    this.action.emit(`new-playlist:${name}`);
    menu.reset();
  }
}