import { Component, ViewEncapsulation, input, output, signal } from '@angular/core';
import { LucidePlus } from '@lucide/angular';

import { Playlist } from '../../services/playlists.service';

/** "New playlist" field plus a scrollable list of existing playlists; used inside popup menus. */
@Component({
  selector: 'app-playlist-picker',
  imports: [LucidePlus],
  templateUrl: './playlist-picker.html',
  styleUrl: './playlist-picker.scss',
  encapsulation: ViewEncapsulation.None,
})
export class PlaylistPicker {
  readonly playlists = input<Playlist[]>([]);
  readonly pick = output<string>();
  readonly create = output<string>();
  readonly name = signal('');

  submit(event: Event): void {
    event.preventDefault();
    const name = this.name().trim();
    if (!name) return;
    this.create.emit(name);
    this.name.set('');
  }
}
