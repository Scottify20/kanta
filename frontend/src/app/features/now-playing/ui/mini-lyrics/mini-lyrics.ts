import { DecimalPipe } from '@angular/common';
import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { LucideALargeSmall, LucideExternalLink, LucideRotateCcw } from '@lucide/angular';
import { filter, map, startWith } from 'rxjs';

import { AudioPlayerService } from '../../../../shared/services/audio-player.service';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { songCover, songKey } from '../../../../shared/services/library.service';
import { LyricsService } from '../../../../shared/services/lyrics';
import { LyricsSizeService } from '../../../../shared/services/lyrics-size.service';
import { PopupStateService } from '../../../../shared/services/popup-state.service';
import { SongsService, songTitle } from '../../../../shared/services/songs.service';
import { ToastService } from '../../../../shared/services/toast.service';
import { LyricsStage } from '../lyrics-stage/lyrics-stage';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STORAGE_KEY = 'kanta.miniLyrics.bounds';
const MARGIN = 16;
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 240;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

@Component({
  selector: 'app-mini-lyrics',
  imports: [DecimalPipe, LyricsStage, RouterLink, PopupPanel, Tooltip, LucideALargeSmall, LucideExternalLink, LucideRotateCcw],
  templateUrl: './mini-lyrics.html',
  styleUrl: './mini-lyrics.scss',
})
export class MiniLyrics {
  readonly audio = inject(AudioPlayerService);
  readonly lyrics = inject(LyricsService);
  readonly size = inject(LyricsSizeService);
  private readonly popups = inject(PopupStateService);
  private readonly songs = inject(SongsService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly route = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  private readonly viewport = signal({ width: window.innerWidth, height: window.innerHeight });
  private readonly savedBounds = signal<Bounds | null>(this.loadBounds());
  private gesture: { pointerId: number; kind: 'move' | 'resize'; x: number; y: number; bounds: Bounds } | null = null;

  readonly song = this.songs.currentSong;
  readonly cover = computed(() => {
    const song = this.song();
    return song ? songCover(song) : null;
  });
  readonly title = computed(() => {
    const song = this.song();
    return song ? songTitle(song) : 'Now playing';
  });
  readonly key = computed(() => {
    const song = this.song();
    return song ? songKey(song) : '';
  });
  readonly time = computed(() => Math.max(0, this.audio.currentTime() - this.lyrics.offsetMs() / 1000));
  readonly visible = computed(() =>
    this.audio.isPlaying() && (this.router.parseUrl(this.route()).root.children['primary']?.segments.length ?? 0) > 0,
  );
  readonly bounds = computed(() => {
    const { width, height } = this.viewport();
    const saved = this.savedBounds();
    return this.constrain(saved ?? {
      x: width - DEFAULT_WIDTH - MARGIN,
      y: height - DEFAULT_HEIGHT - MARGIN,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    });
  });

  constructor() {
    effect(() => {
      if (!this.visible()) untracked(() => this.closeSizePopup());
    });
  }

  updateSize(event: Event): void {
    this.size.setMini(Number((event.target as HTMLInputElement).value));
  }

  private closeSizePopup(): void {
    this.popups.close('mini-lyrics', 'mini-lyrics-size');
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.viewport.set({ width: window.innerWidth, height: window.innerHeight });
  }

  startGesture(event: PointerEvent, kind: 'move' | 'resize'): void {
    if (event.button !== 0 || this.gesture) return;
    this.closeSizePopup();
    event.preventDefault();
    this.gesture = {
      pointerId: event.pointerId, kind, x: event.clientX, y: event.clientY, bounds: this.bounds(),
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  moveGesture(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const original = gesture.bounds;
    this.savedBounds.set(this.constrain(gesture.kind === 'move'
      ? { ...original, x: original.x + dx, y: original.y + dy }
      : { ...original, width: original.width + dx, height: original.height + dy }));
  }

  finishGesture(event: PointerEvent): void {
    if (this.gesture?.pointerId !== event.pointerId) return;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.gesture = null;
    this.saveBounds();
  }

  cancelGesture(event: PointerEvent): void {
    if (this.gesture?.pointerId !== event.pointerId) return;
    this.savedBounds.set(this.gesture.bounds);
    this.gesture = null;
  }

  onKeyboard(event: KeyboardEvent, kind: 'move' | 'resize'): void {
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    if (!dx && !dy) return;
    this.closeSizePopup();
    event.preventDefault();
    const bounds = this.bounds();
    this.savedBounds.set(this.constrain(kind === 'move'
      ? { ...bounds, x: bounds.x + dx, y: bounds.y + dy }
      : { ...bounds, width: bounds.width + dx, height: bounds.height + dy }));
    this.saveBounds();
  }

  private constrain(bounds: Bounds): Bounds {
    const viewport = this.viewport();
    const maxWidth = Math.max(0, viewport.width - 2 * MARGIN);
    const maxHeight = Math.max(0, viewport.height - 2 * MARGIN);
    const width = Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), bounds.width));
    const height = Math.min(maxHeight, Math.max(Math.min(MIN_HEIGHT, maxHeight), bounds.height));
    return {
      width, height,
      x: Math.max(MARGIN, Math.min(bounds.x, viewport.width - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(bounds.y, viewport.height - height - MARGIN)),
    };
  }

  private loadBounds(): Bounds | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (typeof value === 'object' && value !== null &&
          'x' in value && 'y' in value && 'width' in value && 'height' in value &&
          typeof value.x === 'number' && Number.isFinite(value.x) &&
          typeof value.y === 'number' && Number.isFinite(value.y) &&
          typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0 &&
          typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0) {
        return { x: value.x, y: value.y, width: value.width, height: value.height };
      }
      console.warn('Invalid saved mini lyrics bounds; using defaults.');
    } catch (error) {
      console.warn('Could not load mini lyrics position:', error);
    }
    return null;
  }

  private saveBounds(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bounds()));
    } catch (error) {
      console.warn('Could not save mini lyrics position:', error);
      this.toast.error('Could not save mini lyrics position and size.');
    }
  }
}
