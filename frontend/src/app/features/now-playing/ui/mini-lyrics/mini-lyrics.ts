import { DecimalPipe } from '@angular/common';
import { Component, HostListener, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  LucideALargeSmall,
  LucideChevronDown,
  LucideChevronUp,
  LucideExternalLink,
  LucidePause,
  LucidePlay,
  LucideRotateCcw,
  LucideSkipForward,
} from '@lucide/angular';

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
import { sizedImageUrl } from '../../../../shared/util/image-url';
import { LyricsStage } from '../lyrics-stage/lyrics-stage';

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
type GestureKind = 'move' | ResizeCorner;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AnchoredBounds {
  anchorX: 'left' | 'right';
  anchorY: 'top' | 'bottom';
  offsetX: number;
  offsetY: number;
  ratioX: number;
  ratioY: number;
  pinnedX: boolean;
  pinnedY: boolean;
  width: number;
  height: number;
}

const STORAGE_KEY = 'kanta.miniLyrics.bounds';
const MARGIN = 16;
const EDGE_PIN_THRESHOLD = 96;
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 240;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 160;
const PILL_HEIGHT = 48;

const DEFAULT_ANCHORED: AnchoredBounds = {
  anchorX: 'right',
  anchorY: 'bottom',
  offsetX: MARGIN,
  offsetY: MARGIN,
  ratioX: 1,
  ratioY: 1,
  pinnedX: true,
  pinnedY: true,
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
};

@Component({
  selector: 'app-mini-lyrics',
  imports: [
    DecimalPipe,
    LyricsStage,
    RouterLink,
    PopupPanel,
    Tooltip,
    LucideALargeSmall,
    LucideChevronDown,
    LucideChevronUp,
    LucideExternalLink,
    LucidePause,
    LucidePlay,
    LucideRotateCcw,
    LucideSkipForward,
  ],
  templateUrl: './mini-lyrics.html',
  styleUrl: './mini-lyrics.scss',
})
export class MiniLyrics implements OnDestroy {
  readonly playerVisible = input(false);
  readonly audio = inject(AudioPlayerService);
  readonly lyrics = inject(LyricsService);
  readonly size = inject(LyricsSizeService);
  readonly minimized = signal(false);
  readonly resizing = signal(false);
  readonly frozenStageSize = signal<{ width: number; height: number } | null>(null);
  private readonly popups = inject(PopupStateService);
  private readonly songs = inject(SongsService);
  private readonly toast = inject(ToastService);
  private readonly queue = toSignal(inject(QueueService).queue$, { initialValue: null });
  private readonly viewport = signal(this.readViewport());
  private readonly anchored = signal<AnchoredBounds>(this.loadAnchored());
  private gesture: {
    pointerId: number;
    kind: GestureKind;
    startX: number;
    startY: number;
    bounds: Bounds;
    anchored: AnchoredBounds;
    pillSize: { width: number; height: number } | null;
  } | null = null;

  private readonly onVisualViewportResize = (): void => {
    this.viewport.set(this.readViewport());
  };

  readonly song = this.songs.currentSong;
  readonly cover = computed(() => {
    const song = this.song();
    return song ? sizedImageUrl(songCover(song), 128) : null;
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
      && this.audio.hasLoadedSources({
        vocals: stems.vocals.url,
        instrumental: stems.instrumental.url,
        master: song?.master,
      });
  }

  private readonly playableQueue = computed(() =>
    (this.queue()?.karaoke_queue ?? []).filter(
      (item) => !['failed', 'cancelled', 'cancelling'].includes(item.status),
    ),
  );

  readonly selectedTrack = computed(() => {
    const items = this.queue()?.karaoke_queue ?? [];
    const taskId = this.songs.currentQueueTaskId();
    return taskId ? items.find((item) => item.task_id === taskId) ?? null : items[0] ?? null;
  });

  readonly canResume = computed(() => this.selectedTrack()?.status === 'completed');

  readonly hasNext = computed(() => {
    const items = this.playableQueue();
    const taskId = this.songs.currentQueueTaskId();
    if (!taskId) return false;
    const index = items.findIndex((item) => item.task_id === taskId);
    const upcoming = index >= 0 ? items[index + 1] : null;
    return !!upcoming && upcoming.status === 'completed';
  });

  readonly bounds = computed<Bounds>(() => this.resolveBounds(this.anchored(), this.viewport()));

  // Anchors the minimized pill cleanly to whichever screen corner/edge the expanded panel uses.
  readonly pillStyle = computed(() => {
    const b = this.bounds();
    const vp = this.viewport();
    const a = this.anchored();

    const rightOffset = Math.max(MARGIN, vp.width - (b.x + b.width));
    const leftOffset = Math.max(MARGIN, b.x);
    const bottomOffset = Math.max(MARGIN, vp.height - (b.y + b.height));
    const topOffset = Math.max(MARGIN, b.y);

    return {
      left: a.anchorX === 'left' ? leftOffset : null,
      right: a.anchorX === 'right' ? rightOffset : null,
      top: a.anchorY === 'top' ? topOffset : null,
      bottom: a.anchorY === 'bottom' ? bottomOffset : null,
      maxWidth: Math.max(
        MIN_WIDTH,
        a.anchorX === 'right' ? vp.width - rightOffset - MARGIN : vp.width - leftOffset - MARGIN,
      ),
    };
  });

  constructor() {
    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.onVisualViewportResize);
    }
    effect(() => {
      if (!this.visible()) untracked(() => this.closeSizePopup());
    });
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.onVisualViewportResize);
    }
  }

  updateSize(event: Event): void {
    this.size.setMini(Number((event.target as HTMLInputElement).value));
  }

  toggleMinimized(): void {
    this.closeSizePopup();
    this.minimized.update((current) => !current);
  }

  playNext(): void {
    if (!this.hasNext()) return;
    this.audio.trackNavigation.next('next');
  }

  async resume(): Promise<void> {
    const track = this.selectedTrack();
    if (!track || track.status !== 'completed' || this.audio.isPlaying()) return;
    try {
      const song = this.song();
      const stems = song ? findPlaybackStems(song.stems) : null;
      if (
        this.songs.currentQueueTaskId() === track.task_id
        && stems
        && this.audio.hasLoadedSources({
          vocals: stems.vocals.url,
          instrumental: stems.instrumental.url,
          master: song?.master,
        })
      ) {
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
    this.viewport.set(this.readViewport());
  }

  startGesture(event: PointerEvent, kind: GestureKind): void {
    if (event.button !== 0 || this.gesture) return;
    this.closeSizePopup();
    event.preventDefault();
    event.stopPropagation();

    const hostEl = (event.currentTarget as HTMLElement).closest('.mini-lyrics');
    const rect = this.minimized() && hostEl ? hostEl.getBoundingClientRect() : null;

    if (kind !== 'move' && hostEl) {
      const contentEl = hostEl.querySelector<HTMLElement>('.mini-content');
      if (contentEl) {
        const contentRect = contentEl.getBoundingClientRect();
        this.frozenStageSize.set({
          width: Math.round(contentRect.width),
          height: Math.round(contentRect.height),
        });
      }
      this.resizing.set(true);
    }

    this.gesture = {
      pointerId: event.pointerId,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      bounds: rect
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        : this.bounds(),
      anchored: this.anchored(),
      pillSize: rect ? { width: rect.width, height: rect.height } : null,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  moveGesture(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const vp = this.viewport();

    if (gesture.pillSize) {
      const pillBounds = this.constrainRect(
        {
          x: gesture.bounds.x + dx,
          y: gesture.bounds.y + dy,
          width: gesture.pillSize.width,
          height: gesture.pillSize.height,
        },
        vp,
        gesture.pillSize.width,
        PILL_HEIGHT,
      );
      this.anchored.set(
        this.anchorFromRect(
          pillBounds,
          vp,
          gesture.anchored.width,
          gesture.anchored.height,
        ),
      );
      return;
    }

    const nextBounds = this.applyGestureToBounds(gesture.bounds, gesture.kind, dx, dy, vp);
    this.anchored.set(this.anchorFromRect(nextBounds, vp, nextBounds.width, nextBounds.height));
  }

  finishGesture(event: PointerEvent): void {
    if (this.gesture?.pointerId !== event.pointerId) return;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.gesture = null;
    this.resizing.set(false);
    this.frozenStageSize.set(null);
    this.saveAnchored();
  }

  cancelGesture(event: PointerEvent): void {
    if (this.gesture?.pointerId !== event.pointerId) return;
    this.anchored.set(this.gesture.anchored);
    this.gesture = null;
    this.resizing.set(false);
    this.frozenStageSize.set(null);
  }

  onKeyboard(event: KeyboardEvent, kind: GestureKind): void {
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    if (!dx && !dy) return;

    this.closeSizePopup();
    event.preventDefault();
    const vp = this.viewport();

    if (kind === 'move' && this.minimized()) {
      const rect = (event.currentTarget as HTMLElement).closest('.mini-lyrics')?.getBoundingClientRect();
      if (!rect) return;
      const pillBounds = this.constrainRect(
        { x: rect.left + dx, y: rect.top + dy, width: rect.width, height: rect.height },
        vp,
        rect.width,
        PILL_HEIGHT,
      );
      const cur = this.anchored();
      this.anchored.set(this.anchorFromRect(pillBounds, vp, cur.width, cur.height));
      this.saveAnchored();
      return;
    }

    const next = this.applyGestureToBounds(this.bounds(), kind, dx, dy, vp);
    this.anchored.set(this.anchorFromRect(next, vp, next.width, next.height));
    this.saveAnchored();
  }

  private applyGestureToBounds(
    original: Bounds,
    kind: GestureKind,
    dx: number,
    dy: number,
    vp: { width: number; height: number },
  ): Bounds {
    if (kind === 'move') {
      return this.constrainRect(
        { ...original, x: original.x + dx, y: original.y + dy },
        vp,
        MIN_WIDTH,
        MIN_HEIGHT,
      );
    }

    const right = original.x + original.width;
    const bottom = original.y + original.height;
    const maxW = Math.max(0, vp.width - 2 * MARGIN);
    const maxH = Math.max(0, vp.height - 2 * MARGIN);
    const minW = Math.min(MIN_WIDTH, maxW);
    const minH = Math.min(MIN_HEIGHT, maxH);

    let x = original.x;
    let y = original.y;
    let width = original.width;
    let height = original.height;

    if (kind === 'se' || kind === 'ne') {
      width = Math.max(minW, Math.min(vp.width - MARGIN - x, original.width + dx));
    } else {
      width = Math.max(minW, Math.min(right - MARGIN, original.width - dx));
      x = right - width;
    }

    if (kind === 'se' || kind === 'sw') {
      height = Math.max(minH, Math.min(vp.height - MARGIN - y, original.height + dy));
    } else {
      height = Math.max(minH, Math.min(bottom - MARGIN, original.height - dy));
      y = bottom - height;
    }

    return { x, y, width, height };
  }

  private anchorFromRect(
    rect: Bounds,
    vp: { width: number; height: number },
    expandedWidth: number,
    expandedHeight: number,
  ): AnchoredBounds {
    const distLeft = Math.max(MARGIN, rect.x);
    const distRight = Math.max(MARGIN, vp.width - (rect.x + rect.width));
    const distTop = Math.max(MARGIN, rect.y);
    const distBottom = Math.max(MARGIN, vp.height - (rect.y + rect.height));

    const anchorX: 'left' | 'right' = distRight <= distLeft ? 'right' : 'left';
    const anchorY: 'top' | 'bottom' = distBottom <= distTop ? 'bottom' : 'top';
    const offsetX = anchorX === 'left' ? distLeft : distRight;
    const offsetY = anchorY === 'top' ? distTop : distBottom;

    const travelX = Math.max(1, vp.width - rect.width - 2 * MARGIN);
    const travelY = Math.max(1, vp.height - rect.height - 2 * MARGIN);

    return {
      anchorX,
      anchorY,
      offsetX,
      offsetY,
      ratioX: Math.max(0, Math.min(1, (rect.x - MARGIN) / travelX)),
      ratioY: Math.max(0, Math.min(1, (rect.y - MARGIN) / travelY)),
      pinnedX: offsetX <= EDGE_PIN_THRESHOLD,
      pinnedY: offsetY <= EDGE_PIN_THRESHOLD,
      width: expandedWidth,
      height: expandedHeight,
    };
  }

  private resolveBounds(a: AnchoredBounds, vp: { width: number; height: number }): Bounds {
    const maxW = Math.max(0, vp.width - 2 * MARGIN);
    const maxH = Math.max(0, vp.height - 2 * MARGIN);
    const width = Math.min(maxW, Math.max(Math.min(MIN_WIDTH, maxW), a.width));
    const height = Math.min(maxH, Math.max(Math.min(MIN_HEIGHT, maxH), a.height));

    const travelX = Math.max(0, vp.width - width - 2 * MARGIN);
    const travelY = Math.max(0, vp.height - height - 2 * MARGIN);

    const rawX = a.pinnedX
      ? a.anchorX === 'right'
        ? vp.width - width - a.offsetX
        : a.offsetX
      : MARGIN + a.ratioX * travelX;

    const rawY = a.pinnedY
      ? a.anchorY === 'bottom'
        ? vp.height - height - a.offsetY
        : a.offsetY
      : MARGIN + a.ratioY * travelY;

    return {
      width,
      height,
      x: Math.max(MARGIN, Math.min(rawX, vp.width - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(rawY, vp.height - height - MARGIN)),
    };
  }

  private constrainRect(
    rect: Bounds,
    vp: { width: number; height: number },
    minW: number,
    minH: number,
  ): Bounds {
    const maxW = Math.max(0, vp.width - 2 * MARGIN);
    const maxH = Math.max(0, vp.height - 2 * MARGIN);
    const width = Math.min(maxW, Math.max(Math.min(minW, maxW), rect.width));
    const height = Math.min(maxH, Math.max(Math.min(minH, maxH), rect.height));
    return {
      width,
      height,
      x: Math.max(MARGIN, Math.min(rect.x, vp.width - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(rect.y, vp.height - height - MARGIN)),
    };
  }

  private readViewport(): { width: number; height: number } {
    if (typeof window === 'undefined') return { width: 1280, height: 720 };
    return {
      width: Math.round(window.visualViewport?.width ?? window.innerWidth),
      height: Math.round(window.visualViewport?.height ?? window.innerHeight),
    };
  }

  private loadAnchored(): AnchoredBounds {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_ANCHORED;
      const v = JSON.parse(raw) as Partial<AnchoredBounds & Bounds>;
      if (
        (v.anchorX === 'left' || v.anchorX === 'right')
        && (v.anchorY === 'top' || v.anchorY === 'bottom')
        && typeof v.offsetX === 'number' && Number.isFinite(v.offsetX)
        && typeof v.offsetY === 'number' && Number.isFinite(v.offsetY)
        && typeof v.width === 'number' && Number.isFinite(v.width) && v.width > 0
        && typeof v.height === 'number' && Number.isFinite(v.height) && v.height > 0
      ) {
        return {
          anchorX: v.anchorX,
          anchorY: v.anchorY,
          offsetX: v.offsetX,
          offsetY: v.offsetY,
          ratioX: typeof v.ratioX === 'number' && Number.isFinite(v.ratioX) ? v.ratioX : 1,
          ratioY: typeof v.ratioY === 'number' && Number.isFinite(v.ratioY) ? v.ratioY : 1,
          pinnedX: typeof v.pinnedX === 'boolean' ? v.pinnedX : true,
          pinnedY: typeof v.pinnedY === 'boolean' ? v.pinnedY : true,
          width: v.width,
          height: v.height,
        };
      }
      // Migrate legacy { x, y, width, height } format automatically
      if (
        typeof v.x === 'number' && Number.isFinite(v.x)
        && typeof v.y === 'number' && Number.isFinite(v.y)
        && typeof v.width === 'number' && Number.isFinite(v.width) && v.width > 0
        && typeof v.height === 'number' && Number.isFinite(v.height) && v.height > 0
      ) {
        return this.anchorFromRect(
          { x: v.x, y: v.y, width: v.width, height: v.height },
          this.readViewport(),
          v.width,
          v.height,
        );
      }
    } catch (error) {
      console.warn('Could not load mini lyrics position:', error);
    }
    return DEFAULT_ANCHORED;
  }

  private saveAnchored(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.anchored()));
    } catch (error) {
      console.warn('Could not save mini lyrics position:', error);
      this.toast.error('Could not save mini lyrics position and size.');
    }
  }
}