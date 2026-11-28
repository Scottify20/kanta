import { Component, computed, inject, input, output, viewChild } from '@angular/core';
import { EntryAction, EntryMenu } from '../../../../shared/components/entry-menu/entry-menu';
import { PartySessionService } from '../../../../shared/services/party-session.service';
import { Playlist } from '../../../../shared/services/playlists.service';
import { LibraryEntry } from '../../data/library-entries';
import { recommendSoloKey } from '../../../../shared/services/vocal-fit';
import { sizedImageUrl } from '../../../../shared/util/image-url';

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
    '[class.unavailable]': 'disabled()',
  },
})
export class LibraryItem {
  private readonly partySession = inject(PartySessionService);
  readonly entry = input.required<LibraryEntry>();
  readonly layout = input<'grid' | 'list'>('grid');
  readonly selected = input(false);
  readonly current = input(false);
  readonly disabled = input(false);
  readonly playlists = input<Playlist[]>([]);
  readonly inPlaylist = input(false);
  readonly progress = input<number | null>(null);
  readonly selectedCount = input(0);

  readonly activate = output<MouseEvent | KeyboardEvent>();
  readonly action = output<EntryAction>();
  readonly dragStarted = output<DragEvent>();
  readonly dragEnded = output<void>();
  readonly selectOnly = output<void>();

  private readonly menu = viewChild(EntryMenu);

  onContextMenu(event: MouseEvent): void {
    if (this.progress() !== null) return;
    if (!this.selected()) {
      this.selectOnly.emit();
    }
    this.menu()?.openAt(event);
  }

  onEnter(event: Event): void {
    this.activate.emit(event as KeyboardEvent);
  }

  readonly coverSrc = computed(() =>
    sizedImageUrl(this.entry().covers[0], this.layout() === 'list' ? 128 : 384),
  );

  readonly vocalFit = computed(() => {
    const entry = this.entry();
    const singer = this.partySession.singerForFitSorting();
    return entry.kind === 'song' && singer
      ? recommendSoloKey(entry.songs[0], singer)
      : null;
  });

  readonly vocalFitLabel = computed(() => {
    const fit = this.vocalFit();
    if (!fit || fit.unanalyzed || fit.status === 'uncalibrated') return null;
    if (fit.status === 'natural') return 'Natural Fit';
    if (fit.status === 'adjusted') return `Key ${fit.semitones > 0 ? '+' : ''}${fit.semitones}`;
    return fit.semitones < 0 ? 'High Reach' : 'Low Reach';
  });

  readonly lyricsLevel = computed(() => (this.entry().kind === 'song' ? (this.entry().songs[0]?.lyrics_level ?? 'none') : null));
  readonly round = computed(() => this.entry().kind === 'artist');
  readonly mosaic = computed(() => ['playlist', 'genre'].includes(this.entry().kind) && this.entry().covers.length > 1);
  readonly mosaicCovers = computed(() => {
    const covers = this.entry().covers;
    return Array.from({ length: 4 }, (_, i) => sizedImageUrl(covers[i % Math.max(covers.length, 1)], 256));
  });
}