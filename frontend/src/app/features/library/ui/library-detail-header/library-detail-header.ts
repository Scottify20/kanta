import { Component, computed, input, output, signal } from '@angular/core';
import { LucidePlay, LucideListPlus, LucideShuffle, LucideSkipForward } from '@lucide/angular';

import { ArtistInfo } from '../../../../shared/services/artist-info.service';
import { sizedImageUrl } from '../../../../shared/util/image-url';
import { LibraryEntry, formatRuntime } from '../../data/library-entries';

@Component({
  selector: 'app-library-detail-header',
  imports: [LucidePlay, LucideListPlus, LucideShuffle, LucideSkipForward],
  templateUrl: './library-detail-header.html',
  styleUrl: './library-detail-header.scss',
})
export class LibraryDetailHeader {
  readonly entry = input.required<LibraryEntry>();
  readonly artistInfo = input<ArtistInfo | null>(null);
  readonly bioExpanded = signal(false);

  readonly playAll = output<HTMLElement | void>();
  readonly shuffle = output<HTMLElement | void>();
  readonly addToQueue = output<HTMLElement | void>();
  readonly playNext = output<HTMLElement | void>();

  readonly single = computed(() => this.entry().covers.length <= 1);
  readonly covers = computed(() => {
    const covers = this.entry().covers;
    const width = this.single() ? 768 : 384;
    return Array.from({ length: 4 }, (_, i) =>
      sizedImageUrl(covers[i % Math.max(covers.length, 1)] ?? null, width),
    );
  });
  readonly summary = computed(() => {
    const songs = this.entry().songs;
    const seconds = songs.reduce((sum, song) => sum + (song.duration_seconds ?? 0), 0);
    const count = `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`;
    return seconds ? `${count} • ${formatRuntime(seconds)}` : count;
  });
}