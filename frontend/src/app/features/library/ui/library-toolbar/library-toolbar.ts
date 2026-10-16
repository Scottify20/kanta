import { Component, computed, input, model, output } from '@angular/core';
import { LucideChevronDown, LucideLayoutGrid, LucideList, LucidePlus } from '@lucide/angular';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { LibraryTab, SortMode } from '../../data/library-entries';

const SORT_LABELS: Record<SortMode, string> = { az: 'A → Z', za: 'Z → A', recent: 'Recently added' };

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
  readonly createPlaylist = output<void>();

  readonly tabs: { id: LibraryTab; label: string }[] = [
    { id: 'songs', label: 'Songs' },
    { id: 'albums', label: 'Albums' },
    { id: 'artists', label: 'Artists' },
    { id: 'playlists', label: 'Playlists' },
  ];
  readonly sortModes = Object.keys(SORT_LABELS) as SortMode[];
  readonly sortLabel = computed(() => SORT_LABELS[this.sort()]);
  readonly labelOf = (mode: SortMode): string => SORT_LABELS[mode];
  readonly showLayoutToggle = computed(() => this.tab() !== 'songs');
}
