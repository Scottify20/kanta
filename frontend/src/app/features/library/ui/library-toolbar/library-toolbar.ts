import { Component, computed, inject, model, output } from '@angular/core';
import { LucideChevronDown, LucideLayoutGrid, LucideList, LucidePlus } from '@lucide/angular';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { LibraryTab, LyricsFilter, SORT_LABELS, SORT_MODES, SortMode } from '../../data/library-entries';
import { PartySessionService, UserProfile } from '../../../../shared/services/party-session.service';

@Component({
  selector: 'app-library-toolbar',
  imports: [PopupPanel, Tooltip, LucideChevronDown, LucideLayoutGrid, LucideList, LucidePlus],
  templateUrl: './library-toolbar.html',
  styleUrl: './library-toolbar.scss',
})
export class LibraryToolbar {
  readonly party = inject(PartySessionService, { optional: true });
  readonly tab = model.required<LibraryTab>();
  readonly sort = model.required<SortMode>();
  readonly layout = model.required<'grid' | 'list'>();
  readonly lyricsFilter = model.required<LyricsFilter>();
  readonly createPlaylist = output<void>();

  readonly tabs: { id: LibraryTab; label: string }[] = [
    { id: 'songs', label: 'Songs' },
    { id: 'albums', label: 'Albums' },
    { id: 'artists', label: 'Artists' },
    { id: 'genres', label: 'Genres' },
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

  readonly fitSinger = computed(() => this.party?.activeSinger() ?? null);
  
  readonly fitProfiles = computed(() => {
    const roster = this.party?.roster() ?? [];
    const ids = new Set(roster.map((profile) => profile.id));
    return [...roster, ...(this.party?.savedProfiles() ?? []).filter((profile) => !ids.has(profile.id))];
  });

  selectSinger(profile: UserProfile | null): void {
    if (!profile || !this.party) return;
    if (!this.party.roster().some((singer) => singer.id === profile.id)) {
      this.party.addSavedProfile(profile.id);
    }
    this.party.setActiveSinger(profile.id);
  }

  selectFilter(value: LyricsFilter): void {
    this.lyricsFilter.set(this.lyricsFilter() === value ? 'all' : value);
  }
}
