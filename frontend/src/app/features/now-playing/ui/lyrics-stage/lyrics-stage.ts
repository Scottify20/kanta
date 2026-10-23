import { Component, CUSTOM_ELEMENTS_SCHEMA, computed, inject, input, output } from '@angular/core';
import { LyricsSizeService } from '../../../../shared/services/lyrics-size.service';
import type { Lyric } from '@braccato/parsers';

@Component({
  selector: 'app-lyrics-stage',
  templateUrl: './lyrics-stage.html',
  styleUrl: './lyrics-stage.scss',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class LyricsStage {
  protected readonly size = inject(LyricsSizeService);
  readonly coverUrl = input<string | null>(null);
  readonly coverAlt = input('Current album cover');
  readonly lyrics = input<Lyric[] | null>(null);
  readonly currentTime = input(0);
  readonly playing = input(false);
  readonly fullscreen = input(false);
  readonly collapsed = input(false);
  readonly songKey = input('');
  readonly lyricsKey = computed(() => `${this.songKey()}|${this.lyrics() ? 'lyrics' : 'none'}`);
  readonly lyricClick = output<Event>();
}
