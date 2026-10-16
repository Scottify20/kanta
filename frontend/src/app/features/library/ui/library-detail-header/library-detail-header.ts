import { Component, computed, input, output } from '@angular/core';
import { LucidePlay, LucideListPlus, LucideShuffle } from '@lucide/angular';

import { LibraryEntry, formatRuntime } from '../../data/library-entries';

@Component({
  selector: 'app-library-detail-header',
  imports: [LucidePlay, LucideListPlus, LucideShuffle],
  templateUrl: './library-detail-header.html',
  styleUrl: './library-detail-header.scss',
})
export class LibraryDetailHeader {
  readonly entry = input.required<LibraryEntry>();
  readonly playAll = output<void>();
  readonly shuffle = output<void>();
  readonly addToQueue = output<void>();

  readonly covers = computed(() => {
    const covers = this.entry().covers;
    return Array.from({ length: 4 }, (_, i) => covers[i % Math.max(covers.length, 1)] ?? null);
  });
  readonly single = computed(() => this.entry().covers.length <= 1);
  readonly summary = computed(() => {
    const songs = this.entry().songs;
    const seconds = songs.reduce((sum, song) => sum + (song.duration_seconds ?? 0), 0);
    const count = `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`;
    return seconds ? `${count} • ${formatRuntime(seconds)}` : count;
  });
}
