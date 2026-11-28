import { Component, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, ElementRef, computed, effect, inject, input, output } from '@angular/core';
import { LyricsSizeService } from '../../../../shared/services/lyrics-size.service';
import { LyricsColorService, paletteFromCanvas } from '../../../../shared/services/lyrics-color.service';
import { LyricsDisplayService } from '../../../../shared/services/lyrics-display.service';
import { lyricsForDisplay } from '../../../../shared/util/lyrics-display';
import { sizedImageUrl } from '../../../../shared/util/image-url';
import type { BraccatoLyricsElement } from '@braccato/core/element';
import type { Lyric } from '@braccato/parsers';
import { stabilizeLyricsLayout } from './lyrics-layout';

@Component({
  selector: 'app-lyrics-stage',
  templateUrl: './lyrics-stage.html',
  styleUrl: './lyrics-stage.scss',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class LyricsStage {
  protected readonly size = inject(LyricsSizeService);
  protected readonly colors = inject(LyricsColorService);
  protected readonly lyricDisplay = inject(LyricsDisplayService);
  readonly coverUrl = input<string | null>(null);
  readonly coverAlt = input('Current album cover');
  readonly lyrics = input<Lyric[] | null>(null);
  readonly currentTime = input(0);
  readonly playing = input(false);
  readonly fullscreen = input(false);
  readonly collapsed = input(false);
  readonly effectiveSemitones = input(0);
  readonly compact = input(false);
  readonly songKey = input('');
  readonly lyricsKey = computed(
    () => `${this.songKey()}|${this.lyrics() ? 'lyrics' : 'none'}|${this.lyricDisplay.mode()}`,
  );
  readonly displayLyrics = computed(() =>
    lyricsForDisplay(
      this.lyrics(),
      this.lyricDisplay.mode(),
      this.lyricDisplay.transliteratedLines(),
    ),
  );
  readonly lyricClick = output<Event>();

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let observed: BraccatoLyricsElement | null = null;
    let stopObserving: (() => void) | null = null;
    const onLyricsLoaded = (event: Event): void => {
      if (!(event.target instanceof HTMLElement) || event.target.tagName !== 'BRACCATO-LYRICS') return;
      const element = event.target as BraccatoLyricsElement;
      const options = element.tickOptions;
      // The renderer emits this before its first tick; position without animating from the top.
      element.tickOptions = { ...options, smoothScroll: false };
      element.currentTime = this.currentTime();
      element.tickOptions = options;
      element.renderer?.scheduleLyricPositionUpdate(
        () => element.isConnected,
        () => {
          if (element.isConnected) element.currentTime = this.currentTime();
        },
      );
      if (element !== observed) {
        stopObserving?.();
        observed = element;
        stopObserving = stabilizeLyricsLayout(element);
      }
    };
    host.addEventListener('braccato:lyrics-loaded', onLyricsLoaded);
    inject(DestroyRef).onDestroy(() => {
      host.removeEventListener('braccato:lyrics-loaded', onLyricsLoaded);
      stopObserving?.();
    });

    effect(() => this.lyricDisplay.prepareLyrics(this.lyrics(), this.lyricDisplay.mode()));

    effect((onCleanup) => {
      const cover = this.coverUrl();
      const mode = this.colors.mode();
      const isDuet = this.lyrics()?.some((line) =>
        line.agent === 'v2' || line.agent === 'v3' || line.agent === 'v1000',
      ) ?? false;
      this.colors.automatic.set(['#f8f8f8', '#f8f8f8']);
      this.colors.automaticUsesCustom.set(isDuet);
      this.colors.automaticInactiveColors.set(['#f8f8f8', '#f8f8f8']);
      this.colors.automaticInactiveOpacities.set([0.4, 0.4, 0.4]);
      if (!cover || mode !== 'automatic') return;
      let cancelled = false;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (cancelled) return;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 64;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('Canvas is unavailable');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const palette = paletteFromCanvas(canvas, isDuet);
          this.colors.automatic.set(palette.colors);
          this.colors.automaticInactiveColors.set(palette.inactiveColors);
          this.colors.automaticInactiveOpacities.set(palette.inactiveOpacities);
          this.colors.automaticUsesCustom.set(palette.useCustomColors);
        } catch (error) {
          console.warn('Could not extract album lyric colors:', error);
        }
      };
      image.onerror = () => {
        if (!cancelled) console.warn('Could not load album cover for lyric colors:', cover);
      };
      const sampleUrl = new URL(sizedImageUrl(cover, 128) ?? cover, document.baseURI);
      if (sampleUrl.protocol === 'http:' || sampleUrl.protocol === 'https:') {
        // Override any larger ?w= (e.g. w=768 from NowPlaying) so the 64x64 sampler always uses a 128px thumbnail.
        if (
          sampleUrl.pathname.includes('/media/')
          || sampleUrl.pathname.includes('/media-roots/')
          || sampleUrl.pathname.includes('/api/artists/photo/')
        ) {
          sampleUrl.searchParams.set('w', '128');
        }
        // Keep CORS sampling separate from cached non-CORS artwork requests.
        sampleUrl.searchParams.set('kanta-palette', '1');
      }
      image.src = sampleUrl.href;
      onCleanup(() => { cancelled = true; image.onload = null; image.onerror = null; });
    });
  }
}