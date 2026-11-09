import { Component, computed, model, output } from '@angular/core';
import { LucideChevronDown, LucideLayoutGrid, LucideList, LucidePlus } from '@lucide/angular';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { LibraryTab, LyricsFilter, SORT_LABELS, SORT_MODES, SortMode } from '../../data/library-entries';

@Component({
  selector: 'app-library-toolbar',
  imports: [PopupPanel, Tooltip, LucideChevronDown, LucideLayoutGrid, LucideList, LucidePlus],
  templateUrl: './library-toolbar.html',
  styleUrl: './library-toolbar.scss',
})
export class LibraryToolbar {
  readonly tab = model.required<LibraryTab>();
  readonly sort = model.required<SortMode>();
  readonly layout = model.required<'grid' | 'list'>();
  readonly lyricsFilter = model.required<LyricsFilter>();
  readonly createPlaylist = output<void>();

  readonly tabs: { id: LibraryTab; label: string }[] = [
    { id: 'songs', label: 'Songs' },
    { id: 'albums', label: 'Albums' },
    { id: 'artists', label: 'Artists' },
    { id: 'playlists', label: 'Playlists' },
  ];
  readonly sortModes = computed(() => SORT_MODES[this.tab()]);
  readonly sortLabel = computed(() => SORT_LABELS[this.sort()]);
  readonly labelOf = (mode: SortMode): string => SORT_LABELS[mode];
  readonly showLayoutToggle = computed(() => this.tab() !== 'songs');
  readonly lyricsFilters: { value: LyricsFilter; label: string }[] = [
    { value: 'all', label: 'All songs' },
    { value: 'word', label: 'Word synced' },
    { value: 'line', label: 'Line synced' },
    { value: 'duet', label: 'Duet Lyrics' },
    { value: 'none', label: 'No lyrics' },
  ];
  readonly filterLabel = computed(() =>
    this.lyricsFilters.find((option) => option.value === this.lyricsFilter())?.label ?? 'All songs',
  );

  selectFilter(value: LyricsFilter): void {
    this.lyricsFilter.set(this.lyricsFilter() === value ? 'all' : value);
  }
}
