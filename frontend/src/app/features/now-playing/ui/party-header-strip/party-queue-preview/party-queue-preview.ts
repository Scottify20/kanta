import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { PartySessionService, UserProfile } from '../../../../../shared/services/party-session.service';
import { QueueItem } from '../../../../queue/interfaces/queue.models';

interface RenderedTrack {
  item: QueueItem;
  state: 'entering' | 'idle' | 'leaving';
  wasUpNext: boolean;
  staggerMs: number;
}

// Wait 2s after a track change so cover, lyrics, and audio worklets finish settling.
const TRACK_SWAP_DELAY_MS = 500;
const LEAVE_DURATION_MS = 520;
const ENTER_SETTLE_MS = 720;

@Component({
  selector: 'app-party-queue-preview',
  templateUrl: 'party-queue-preview.html',
  styleUrl: 'party-queue-preview.scss',
})
export class PartyQueuePreview {
  readonly queuePreview = input<QueueItem[]>([]);
  readonly playing = input(false);
  readonly currentTime = input(0);
  readonly duration = input(0);

  private readonly party = inject(PartySessionService);
  private readonly destroyRef = inject(DestroyRef);

  readonly renderedTracks = signal<RenderedTrack[]>([]);
  // Holds the previous "Up next" ID during the 2s swap delay so chips don't jitter before reconciling.
  private readonly frozenUpNextId = signal<string | null>(null);
  private readonly swapPending = signal(false);

  private readonly liveUpNextTaskId = computed<string | null>(() => {
    const first = this.queuePreview()[0];
    const duration = this.duration();
    const remaining = duration - this.currentTime();
    if (!first || !this.playing() || duration <= 0 || remaining < 0 || remaining > 18) {
      return null;
    }
    return first.task_id;
  });

  readonly upNextTaskId = computed<string | null>(() =>
    this.swapPending() ? this.frozenUpNextId() : this.liveUpNextTaskId(),
  );

  readonly hasActiveUpNext = computed(() => {
    const activeId = this.upNextTaskId();
    return activeId !== null && this.renderedTracks().some((t) => t.state !== 'leaving' && t.item.task_id === activeId);
  });

  private initialized = false;
  private lastUpNextId: string | null = null;
  private swapTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private enterTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const id = this.liveUpNextTaskId();
      if (id !== null) this.lastUpNextId = id;
    });

    effect(() => {
      const incoming = this.queuePreview();
      untracked(() => this.scheduleReconcile(incoming));
    });

    this.destroyRef.onDestroy(() => {
      this.clearTimers();
    });
  }

  private scheduleReconcile(incoming: QueueItem[]): void {
    if (!this.initialized) {
      this.initialized = true;
      this.renderedTracks.set(
        incoming.map((item) => ({ item, state: 'idle', wasUpNext: false, staggerMs: 0 })),
      );
      return;
    }

    const current = this.renderedTracks();
    const currentLive = current.filter((t) => t.state !== 'leaving');
    const sameOrder =
      currentLive.length === incoming.length
      && currentLive.every((t, i) => t.item.task_id === incoming[i].task_id);

    if (sameOrder) {
      const byId = new Map(incoming.map((item) => [item.task_id, item]));
      this.renderedTracks.set(
        current.map((t) => (byId.has(t.item.task_id) ? { ...t, item: byId.get(t.item.task_id)! } : t)),
      );
      return;
    }

    // Freeze the current visual "Up next" chip during the 2s delay so nothing moves prematurely.
    if (!this.swapPending()) {
      const stillVisibleUpNext = this.lastUpNextId
        && currentLive.some((t) => t.item.task_id === this.lastUpNextId)
        ? this.lastUpNextId
        : null;
      this.frozenUpNextId.set(stillVisibleUpNext);
      this.swapPending.set(true);
    }

    if (this.swapTimer) clearTimeout(this.swapTimer);
    this.swapTimer = setTimeout(() => {
      this.swapTimer = null;
      const previousUpNext = this.frozenUpNextId();
      this.swapPending.set(false);
      this.frozenUpNextId.set(null);
      this.reconcile(this.queuePreview(), previousUpNext);
    }, TRACK_SWAP_DELAY_MS);
  }

  private reconcile(incoming: QueueItem[], previousUpNext: string | null): void {
    const prev = this.renderedTracks();
    const incomingIds = new Set(incoming.map((i) => i.task_id));
    const prevLiveIds = new Set(prev.filter((t) => t.state !== 'leaving').map((t) => t.item.task_id));
    const activeUpNext = previousUpNext ?? this.liveUpNextTaskId() ?? this.lastUpNextId;

    const leaving: RenderedTrack[] = [];
    for (const entry of prev) {
      if (!incomingIds.has(entry.item.task_id)) {
        const wasUpNext = entry.wasUpNext || entry.item.task_id === activeUpNext;
        leaving.push({
          ...entry,
          state: 'leaving',
          wasUpNext,
          staggerMs: 0,
        });
      }
    }

    let enterIndex = 0;
    const nextLive: RenderedTrack[] = incoming.map((item) => {
      const isNew = !prevLiveIds.has(item.task_id);
      const staggerMs = isNew ? enterIndex++ * 70 : 0;
      return {
        item,
        state: isNew ? 'entering' : 'idle',
        wasUpNext: false,
        staggerMs,
      };
    });

    this.renderedTracks.set([...leaving, ...nextLive]);

    if (leaving.length) {
      if (this.leaveTimer) clearTimeout(this.leaveTimer);
      this.leaveTimer = setTimeout(() => {
        this.leaveTimer = null;
        this.renderedTracks.update((list) => list.filter((t) => t.state !== 'leaving'));
        if (this.liveUpNextTaskId() === null) this.lastUpNextId = null;
      }, LEAVE_DURATION_MS);
    }

    if (nextLive.some((t) => t.state === 'entering')) {
      if (this.enterTimer) clearTimeout(this.enterTimer);
      this.enterTimer = setTimeout(() => {
        this.enterTimer = null;
        this.renderedTracks.update((list) =>
          list.map((t) => (t.state === 'entering' ? { ...t, state: 'idle', staggerMs: 0 } : t)),
        );
      }, ENTER_SETTLE_MS);
    }
  }

  private clearTimers(): void {
    if (this.swapTimer) clearTimeout(this.swapTimer);
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    if (this.enterTimer) clearTimeout(this.enterTimer);
  }

  primarySingerFor(item: QueueItem): UserProfile | null {
    return this.party.queueSinger(item.task_id, 'primary') ?? this.party.activeSinger();
  }

  secondarySingerFor(item: QueueItem): UserProfile | null {
    return this.party.queueSinger(item.task_id, 'secondary');
  }

  isDuetTrack(item: QueueItem): boolean {
    return item.is_duet === true || this.secondarySingerFor(item) !== null;
  }

  upNextSingersLabel(item: QueueItem): string {
    const s1 = this.primarySingerFor(item);
    const s2 = this.secondarySingerFor(item);
    if (s1 && s2) return `${s1.name} & ${s2.name}`;
    return s1?.name ?? 'Singer';
  }

  isUpNext(track: RenderedTrack): boolean {
    return track.state !== 'leaving' && this.upNextTaskId() === track.item.task_id;
  }
}