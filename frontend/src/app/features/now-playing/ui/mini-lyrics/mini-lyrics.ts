import { DecimalPipe } from '@angular/common';
import { Component, HostListener, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { LucideALargeSmall, LucideChevronDown, LucideChevronUp, LucideExternalLink, LucidePause, LucidePlay, LucideRotateCcw } from '@lucide/angular';

import { QueueService } from '../../../queue/data-access/queue.service';
import { AudioPlayerService } from '../../../../shared/services/audio-player.service';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { songCover, songKey } from '../../../../shared/services/library.service';
import { LyricsService } from '../../../../shared/services/lyrics';
import { LyricsSizeService } from '../../../../shared/services/lyrics-size.service';
import { PopupStateService } from '../../../../shared/services/popup-state.service';
import { findPlaybackStems } from '../../../../shared/services/playback-actions.service';
import { SongsService, songTitle } from '../../../../shared/services/songs.service';
import { ToastService } from '../../../../shared/services/toast.service';
import { LyricsStage } from '../lyrics-stage/lyrics-stage';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

const STORAGE_KEY = 'kanta.miniLyrics.bounds';
const MARGIN = 16;
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 240;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;
const PILL_HEIGHT = 48;

@Component({
  selector: 'app-mini-lyrics',
  imports: [DecimalPipe, LyricsStage, RouterLink, PopupPanel, Tooltip, LucideALargeSmall, LucideChevronDown, LucideChevronUp, LucideExternalLink, LucidePause, LucidePlay, LucideRotateCcw],
  templateUrl: './mini-lyrics.html',
  styleUrl: './mini-lyrics.scss',
})
export class MiniLyrics {
  readonly playerVisible = input(false);
  readonly audio = inject(AudioPlayerService);
  readonly lyrics = inject(LyricsService);
  readonly size = inject(LyricsSizeService);
  readonly minimized = signal(false);
  private readonly popups = inject(PopupStateService);
  private readonly songs = inject(SongsService);
  private readonly toast = inject(ToastService);
  private readonly queue = toSignal(inject(QueueService).queue$, { initialValue: null });
  private readonly viewport = signal({ width: window.innerWidth, height: window.innerHeight });
  private readonly savedBounds = signal<Bounds | null>(this.loadBounds());
  private readonly pillAnchor = signal<Point | null>(null);
  private gesture: {
    pointerId: number; kind: 'move' | 'resize'; x: number; y: number; bounds: Bounds;
    pill: { anchor: Point; width: number; height: number } | null;
  } | null = null;

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
  readonly visible = computed(() => this.isVisible());

  private isVisible(): boolean {
    const taskId = this.songs.currentQueueTaskId();
    const song = this.song();
    const stems = song ? findPlaybackStems(song.stems) : null;
    return !this.playerVisible() && !!taskId && !!stems && this.audio.playbackStarted()
      && (this.queue()?.karaoke_queue.some((item) => item.task_id === taskId && item.status === 'completed') ?? false)
      && this.audio.hasLoadedSources({ vocals: stems.vocals.url, instrumental: stems.instrumental.url });
  }
  readonly selectedTrack = computed(() => {
    const items = this.queue()?.karaoke_queue ?? [];
    const taskId = this.songs.currentQueueTaskId();
    return taskId ? items.find((item) => item.task_id === taskId) ?? null : items[0] ?? null;
  });
  readonly canResume = computed(() => this.selectedTrack()?.status === 'completed');
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
  readonly minimizedAnchor = computed(() => {
    const bounds = this.bounds();
    const anchor = this.pillAnchor() ?? { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    const viewport = this.viewport();
    return {
      x: Math.max(MARGIN, Math.min(anchor.x, viewport.width - MARGIN)),
      y: Math.max(MARGIN + PILL_HEIGHT, Math.min(anchor.y, viewport.height - MARGIN)),
    };
  });

  constructor() {
    effect(() => {
      if (!this.visible()) untracked(() => this.closeSizePopup());
    });
  }

  updateSize(event: Event): void {
    this.size.setMini(Number((event.target as HTMLInputElement).value));
  }

  toggleMinimized(): void {
    this.closeSizePopup();
    if (this.minimized()) {
      this.savePillPosition(this.minimizedAnchor());
      this.pillAnchor.set(null);
      this.minimized.set(false);
      this.saveBounds();
    } else {
      const bounds = this.bounds();
      this.pillAnchor.set({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      this.minimized.set(true);
    }
  }

  async resume(): Promise<void> {
    const track = this.selectedTrack();
    if (!track || track.status !== 'completed' || this.audio.isPlaying()) return;
    try {
      const song = this.song();
      const stems = song ? findPlaybackStems(song.stems) : null;
      if (this.songs.currentQueueTaskId() === track.task_id && stems
          && this.audio.hasLoadedSources({ vocals: stems.vocals.url, instrumental: stems.instrumental.url })) {
        await this.audio.play();
      } else {
        this.songs.requestQueueTrack(track);
      }
    } catch (error) {
      console.error('Could not resume playback:', error);
      this.toast.error('Could not resume playback.');
    }
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
    const rect = this.minimized() ? (event.currentTarget as HTMLElement).closest('.mini-lyrics')?.getBoundingClientRect() : null;
    this.gesture = {
      pointerId: event.pointerId, kind, x: event.clientX, y: event.clientY, bounds: this.bounds(),
      pill: rect ? { anchor: this.minimizedAnchor(), width: rect.width, height: rect.height } : null,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  moveGesture(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.pill) {
      this.movePill(gesture.pill.anchor, dx, dy, gesture.pill.width, gesture.pill.height);
      return;
    }
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
    if (this.gesture.pill) this.pillAnchor.set(this.gesture.pill.anchor);
    this.gesture = null;
  }

  onKeyboard(event: KeyboardEvent, kind: 'move' | 'resize'): void {
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    if (!dx && !dy) return;
    this.closeSizePopup();
    event.preventDefault();
    if (kind === 'move' && this.minimized()) {
      const rect = (event.currentTarget as HTMLElement).closest('.mini-lyrics')?.getBoundingClientRect();
      if (rect) {
        this.movePill(this.minimizedAnchor(), dx, dy, rect.width, rect.height);
        this.saveBounds();
      }
      return;
    }
    const bounds = this.bounds();
    this.savedBounds.set(this.constrain(kind === 'move'
      ? { ...bounds, x: bounds.x + dx, y: bounds.y + dy }
      : { ...bounds, width: bounds.width + dx, height: bounds.height + dy }));
    this.saveBounds();
  }

  private movePill(anchor: Point, dx: number, dy: number, width: number, height: number): void {
    const viewport = this.viewport();
    const next = {
      x: Math.max(Math.min(viewport.width - MARGIN, MARGIN + width), Math.min(anchor.x + dx, viewport.width - MARGIN)),
      y: Math.max(Math.min(viewport.height - MARGIN, MARGIN + height), Math.min(anchor.y + dy, viewport.height - MARGIN)),
    };
    this.pillAnchor.set(next);
    this.savePillPosition(next);
  }

  private savePillPosition(anchor: Point): void {
    const bounds = this.bounds();
    this.savedBounds.set(this.constrain({ ...bounds, x: anchor.x - bounds.width, y: anchor.y - bounds.height }));
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
