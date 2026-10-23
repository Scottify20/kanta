import { Component, computed, input, output } from '@angular/core';
import { EntryAction, EntryMenu } from '../../../../shared/components/entry-menu/entry-menu';
import { Playlist } from '../../../../shared/services/playlists.service';
import { LibraryEntry } from '../../data/library-entries';

export type { EntryAction };

@Component({
  selector: 'app-library-item',
  imports: [EntryMenu],
  templateUrl: './library-item.html',
  styleUrl: './library-item.scss',
  host: {
    '[class.grid]': "layout() === 'grid'",
    '[class.list]': "layout() === 'list'",
    '[class.selected]': 'selected()',
    '[class.current]': 'current()',
    '[class.processing]': 'progress() !== null',
  },
})
export class LibraryItem {
  readonly entry = input.required<LibraryEntry>();
  readonly layout = input<'grid' | 'list'>('grid');
  readonly selected = input(false);
  readonly current = input(false);
  readonly playlists = input<Playlist[]>([]);
  readonly inPlaylist = input(false);
  // Percent complete while this entry's songs are still being processed; null otherwise.
  readonly progress = input<number | null>(null);

  readonly activate = output<MouseEvent | KeyboardEvent>();
  readonly action = output<EntryAction>();
  readonly dragStarted = output<DragEvent>();
  readonly dragEnded = output<void>();

  readonly lyricsLevel = computed(() => (this.entry().kind === 'song' ? (this.entry().songs[0]?.lyrics_level ?? 'none') : null));
  readonly round = computed(() => this.entry().kind === 'artist');
  readonly mosaic = computed(() => this.entry().kind === 'playlist' && this.entry().covers.length > 1);
  readonly mosaicCovers = computed(() => {
    const covers = this.entry().covers;
    return Array.from({ length: 4 }, (_, i) => covers[i % Math.max(covers.length, 1)] ?? null);
  });
}
