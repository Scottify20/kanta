import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { LibraryService, songKey } from '../../../../shared/services/library.service';
import { PartySessionService, UserProfile } from '../../../../shared/services/party-session.service';
import { PopupStateService } from '../../../../shared/services/popup-state.service';
import { SongManifest, SongsService, hasVocalRange, hasVocalStem } from '../../../../shared/services/songs.service';
import { ToastService } from '../../../../shared/services/toast.service';
import { QueueItem } from '../../interfaces/queue.models';

@Component({
  selector: 'app-queue-party-controls',
  imports: [PopupPanel],
  templateUrl: './queue-party-controls.html',
  styleUrl: './queue-party-controls.scss',
})
export class QueuePartyControls {
  readonly item = input.required<QueueItem>();
  readonly isDuet = input(false);
  readonly showDuetPrompt = input(false);
  readonly duetPromptHandled = output<void>();

  protected readonly party = inject(PartySessionService);
  private readonly library = inject(LibraryService);
  private readonly popups = inject(PopupStateService);
  private readonly songsService = inject(SongsService);
  private readonly toast = inject(ToastService);
  private lastAnalysisTaskId: string | null = null;
  private lastManifestTaskId: string | null = null;
  private readonly fetchedSong = signal<{ taskId: string; song: SongManifest } | null>(null);

  readonly song = computed(() => {
    const item = this.item();
    return this.library.songs().find((candidate) => songKey(candidate) === songKey(item))
      ?? (this.fetchedSong()?.taskId === item.task_id ? this.fetchedSong()?.song ?? null : null);
  });
  readonly assignment = computed(() => this.party.queueAssignment(this.item().task_id));
  readonly primarySinger = computed(() =>
    this.party.queueSinger(this.item().task_id, 'primary'),
  );
  readonly secondarySinger = computed(() =>
    this.party.queueSinger(this.item().task_id, 'secondary'),
  );
  readonly popupId = computed(() => `queue-singers:${this.item().task_id}`);
  readonly recommendation = computed(() => {
    const song = this.song();
    if (!song) return null;
    const manifest: SongManifest = this.isDuet() && !song.is_duet
      ? { ...song, is_duet: true }
      : song;
    return this.party.recommendQueueItem(this.item().task_id, manifest);
  });
  readonly rangeFit = computed(() => {
    const fit = this.recommendation();
    if (
      !fit
      || fit.unanalyzed
      || ('uncalibrated' in fit ? fit.uncalibrated : fit.status === 'uncalibrated')
    ) return null;
    if ('status' in fit) return fit.status;
    if (fit.conflict || fit.hitsPhysicalLimit || Math.abs(fit.semitones) > 3) return 'reach';
    return fit.semitones === 0 ? 'natural' : 'adjusted';
  });
  readonly keyShiftLabel = computed(() => {
    const fit = this.recommendation();
    if (
      !fit
      || fit.unanalyzed
      || ('uncalibrated' in fit ? fit.uncalibrated : fit.status === 'uncalibrated')
    ) return null;
    return `${fit.semitones > 0 ? '+' : ''}${fit.semitones} ST`;
  });

  constructor() {
    effect(() => {
      const item = this.item();
      if (!this.showDuetPrompt() || this.party.roster().length < 2) return;
      if (item.status !== 'completed') {
        if (['failed', 'cancelled', 'cancelling'].includes(item.status)) {
          this.duetPromptHandled.emit();
        }
        return;
      }
      if (!this.song()) return;
      this.party.ensureQueueAssignment(item.task_id, this.isDuet());
      this.popups.open('queue-party', this.popupId());
      this.duetPromptHandled.emit();
    });
    effect(() => {
      const item = this.item();
      const song = this.song();
      if (
        item.status === 'completed'
        && !song
        && this.lastManifestTaskId !== item.task_id
      ) {
        this.lastManifestTaskId = item.task_id;
        void firstValueFrom(this.songsService.getManifest(item.artist, item.album, item.title))
          .then((manifest) => {
            if (this.item().task_id === item.task_id) {
              this.fetchedSong.set({ taskId: item.task_id, song: manifest });
            }
          })
          .catch((error: unknown) => {
            console.error('Could not load a queue song manifest:', error);
            this.toast.error('Could not load song details for this queue item.');
            if (this.showDuetPrompt()) this.duetPromptHandled.emit();
          });
      }
      if (
        item.status !== 'completed'
        || !song
        || hasVocalRange(song)
        || !hasVocalStem(song)
        || this.lastAnalysisTaskId === item.task_id
      ) return;
      this.lastAnalysisTaskId = item.task_id;
      void this.library.requestVocalRangeAnalysis(song)
        .then((updated) => {
          if (
            updated
            && !this.library.songs().some((candidate) => songKey(candidate) === songKey(updated))
            && this.item().task_id === item.task_id
          ) this.fetchedSong.set({ taskId: item.task_id, song: updated });
        })
        .catch(() => undefined);
    });
  }

  singerInitial(singer: UserProfile | null): string {
    return singer?.initials || singer?.name.slice(0, 1).toUpperCase() || '+';
  }

  assignSinger(singerId: string, part: 'primary' | 'secondary'): void {
    this.party.assignQueueSinger(this.item().task_id, singerId, part);
  }

  clearSinger(part: 'primary' | 'secondary'): void {
    this.party.clearQueueSinger(this.item().task_id, part);
  }

  prioritizeSinger(singerId: string): void {
    this.party.setQueueKeyPriority(this.item().task_id, singerId);
  }

  canAssign(singer: UserProfile, part: 'primary' | 'secondary'): boolean {
    const otherSingerId = part === 'primary'
      ? this.assignment().secondarySingerId
      : this.assignment().primarySingerId;
    return singer.id !== otherSingerId;
  }

  isPriority(singerId: string): boolean {
    return this.assignment().prioritySingerId === singerId;
  }
}
