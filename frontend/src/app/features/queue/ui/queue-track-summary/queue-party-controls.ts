import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { LibraryService, songKey } from '../../../../shared/services/library.service';
import { PartySessionService, UserProfile } from '../../../../shared/services/party-session.service';
import { SongManifest, SongsService, hasVocalRange, hasVocalStem } from '../../../../shared/services/songs.service';
import { QueueItem } from '../../interfaces/queue.models';
import { recommendSoloKey } from '../../../../shared/services/vocal-fit';
import { SongAssignmentService } from '../../../../shared/services/song-assignment.service';

@Component({
  selector: 'app-queue-party-controls',
  imports: [],
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
  private readonly songsService = inject(SongsService);
  private readonly assignmentService = inject(SongAssignmentService);

  private lastAnalysisTaskId: string | null = null;
  private lastManifestTaskId: string | null = null;
  private readonly fetchedSong = signal<{ taskId: string; song: SongManifest } | null>(null);

  readonly song = computed(() => {
    const item = this.item();
    return (
      this.library.songs().find((candidate) => songKey(candidate) === songKey(item)) ??
      (this.fetchedSong()?.taskId === item.task_id ? this.fetchedSong()?.song ?? null : null)
    );
  });

  readonly assignment = computed(() => this.party.queueAssignment(this.item().task_id));
  readonly primarySinger = computed(() =>
    this.party.queueSinger(this.item().task_id, 'primary'),
  );
  readonly secondarySinger = computed(() =>
    this.party.queueSinger(this.item().task_id, 'secondary'),
  );

  readonly isDuetMode = computed(() => this.isDuet() || this.assignment().secondarySingerId !== null);

  readonly recommendation = computed(() => {
    const song = this.song();
    if (!song) return null;
    const manifest: SongManifest =
      this.isDuetMode() && !song.is_duet ? { ...song, is_duet: true } : song;
    return this.party.recommendQueueItem(this.item().task_id, manifest);
  });

  readonly hasVocalConflict = computed(() => {
    const rec = this.recommendation();
    return !!(rec && rec.kind === 'duet' && rec.conflict && this.primarySinger() && this.secondarySinger());
  });

  readonly rangeFit = computed(() => {
    const fit = this.recommendation();
    if (
      !fit ||
      fit.unanalyzed ||
      ('uncalibrated' in fit ? fit.uncalibrated : fit.status === 'uncalibrated')
    )
      return null;
    if ('status' in fit) return fit.status;
    if (fit.conflict || fit.hitsPhysicalLimit || Math.abs(fit.semitones) > 3) return 'reach';
    return fit.semitones === 0 ? 'natural' : 'adjusted';
  });

  readonly keyShiftLabel = computed(() => {
    const fit = this.recommendation();
    if (
      !fit ||
      fit.unanalyzed ||
      ('uncalibrated' in fit ? fit.uncalibrated : fit.status === 'uncalibrated')
    )
      return null;
    return `${fit.semitones > 0 ? '+' : ''}${fit.semitones} ST`;
  });

  constructor() {
    effect(() => {
      const item = this.item();
      const song = this.song();
      if (item.status === 'completed' && !song && this.lastManifestTaskId !== item.task_id) {
        this.lastManifestTaskId = item.task_id;
        void firstValueFrom(this.songsService.getManifest(item.artist, item.album, item.title))
          .then((manifest) => {
            if (this.item().task_id === item.task_id) {
              this.fetchedSong.set({ taskId: item.task_id, song: manifest });
            }
          })
          .catch((error: unknown) => {
            console.error('Could not load queue song manifest:', error);
            if (this.showDuetPrompt()) this.duetPromptHandled.emit();
          });
      }
      if (
        item.status !== 'completed' ||
        !song ||
        hasVocalRange(song) ||
        !hasVocalStem(song) ||
        this.lastAnalysisTaskId === item.task_id
      )
        return;
      this.lastAnalysisTaskId = item.task_id;
      void this.library
        .requestVocalRangeAnalysis(song)
        .then((updated) => {
          if (
            updated &&
            !this.library.songs().some((candidate) => songKey(candidate) === songKey(updated)) &&
            this.item().task_id === item.task_id
          )
            this.fetchedSong.set({ taskId: item.task_id, song: updated });
        })
        .catch(() => undefined);
    });
  }

  singerInitial(singer: UserProfile | null): string {
    return singer?.initials || singer?.name.slice(0, 1).toUpperCase() || '+';
  }

  async openAssignment(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    let currentSong = this.song();
    if (!currentSong) {
      const item = this.item();
      currentSong = {
        artist: item.raw_artist || item.artist,
        album: item.raw_album || item.album,
        title: item.raw_title || item.title,
        stems: [],
        lyrics: [],
        covers: [],
        master: null,
      };
    }

    const updated = await this.assignmentService.resolveAssignment(
      currentSong,
      this.isDuetMode(),
      event.currentTarget as HTMLElement,
      1,
      1,
      true,
      this.assignment(),
    );

    this.party.setExplicitQueueAssignment(this.item().task_id, updated);
  }
}