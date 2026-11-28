import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { QueueService } from '../../features/queue/data-access/queue.service';
import { QueueItem } from '../../features/queue/interfaces/queue.models';
import { LibraryService, SongRef, songKey } from './library.service';
import { SongManifest, SongsService, songTitle } from './songs.service';
import { PartySessionService, QueueSingerAssignment } from './party-session.service';
import { AssignmentAnchor, SongAssignmentService } from './song-assignment.service';
import { ToastService } from './toast.service';

type StemFile = SongManifest['stems'][number];

const stemNamed = (stems: StemFile[], kind: 'vocals' | 'instrumental'): StemFile | undefined =>
  stems.find((file) => new RegExp(`\\(${kind}\\)\\.[a-z0-9]+$`, 'i').test(file.name));

export const findPlaybackStems = (stems: StemFile[]): { vocals: StemFile; instrumental: StemFile } | null => {
  const vocals = stemNamed(stems, 'vocals');
  const instrumental = stemNamed(stems, 'instrumental');
  return vocals && instrumental ? { vocals, instrumental } : null;
};

export const isPlayable = (song: Pick<SongManifest, 'stems'>): boolean =>
  findPlaybackStems(song.stems) !== null;

@Injectable({ providedIn: 'root' })
export class PlaybackActions {
  private readonly queue = inject(QueueService);
  private readonly songs = inject(SongsService);
  private readonly library = inject(LibraryService);
  private readonly party = inject(PartySessionService);
  private readonly router = inject(Router);
  private readonly assignmentService = inject(SongAssignmentService);
  private readonly toast = inject(ToastService);

  /** Replaces only the karaoke queue and starts the first song. Returns the created task IDs. */
  async playSongs(
    songs: SongManifest[],
    anchor?: AssignmentAnchor,
  ): Promise<string[]> {
    const playable = songs.filter(isPlayable);
    if (!playable.length) {
      this.toast.error('No playable songs selected.');
      return [];
    }

    const batchAnchor = this.assignmentService.captureAnchor(anchor);
    const total = playable.length;
    const staged: { song: SongManifest; assignment: QueueSingerAssignment }[] = [];
    for (let i = 0; i < total; i++) {
      const song = playable[i];
      const assignment = await this.assignmentService.resolveAssignment(
        song,
        song.is_duet === true,
        batchAnchor,
        i + 1,
        total,
      );
      staged.push({ song, assignment });
    }

    try {
      await firstValueFrom(this.queue.clearQueue(1));
      const createdTaskIds: string[] = [];
      let afterTaskId: string | null = null;
      let firstTaskId: string | null = null;

      for (const { song, assignment } of staged) {
        const result: { item: QueueItem } = await firstValueFrom(
          this.queue.addProcessedTrack(song, false, afterTaskId, true),
        );
        const item = result.item;
        this.party.setExplicitQueueAssignment(item.task_id, assignment);
        createdTaskIds.push(item.task_id);
        firstTaskId ??= item.task_id;
        afterTaskId = item.task_id;
      }

      this.songs.selectSong(playable[0], true, firstTaskId);
      await this.reorderQueueRoundRobin(createdTaskIds);
      void this.router.navigateByUrl('/');

      if (staged.length === 1) {
        const label = this.singerLabel(staged[0].assignment);
        const title = songTitle(staged[0].song);
        this.toast.success(label ? `Playing “${title}” · ${label}` : `Playing “${title}”`);
      } else {
        this.toast.success(`Added ${staged.length} songs to queue`);
      }

      return createdTaskIds;
    } catch (error) {
      console.error('Could not start playback:', error);
      this.toast.error('Could not add songs to the queue.');
      throw error;
    }
  }

  /** Enqueues songs sequentially through the assignment prompt and returns the created task IDs. */
  async enqueue(
    songs: SongRef[],
    afterTaskId: string | null = null,
    atFront = false,
    anchor?: AssignmentAnchor,
  ): Promise<string[]> {
    if (!songs.length) return [];

    const batchAnchor = this.assignmentService.captureAnchor(anchor);
    const byKey = this.library.songByKey();
    let anchorTaskId = afterTaskId;
    let first = true;
    const createdTaskIds: string[] = [];
    const total = songs.length;
    let lastAssignment: QueueSingerAssignment | null = null;

    try {
      for (let i = 0; i < total; i++) {
        const ref = songs[i];
        const fullSong = byKey.get(songKey(ref)) ?? (ref as SongManifest);
        const isDuet = fullSong.is_duet === true;
        const assignment = await this.assignmentService.resolveAssignment(
          fullSong,
          isDuet,
          batchAnchor,
          i + 1,
          total,
        );
        lastAssignment = assignment;

        const result: { item: QueueItem } = await firstValueFrom(
          this.queue.addProcessedTrack(ref, atFront && first && !anchorTaskId, anchorTaskId, true),
        );
        this.party.setExplicitQueueAssignment(result.item.task_id, assignment);
        createdTaskIds.push(result.item.task_id);
        anchorTaskId = result.item.task_id;
        first = false;
      }

      if (!atFront) {
        await this.reorderQueueRoundRobin(createdTaskIds);
      }

      if (createdTaskIds.length === 1) {
        const ref = songs[0];
        const fullSong = byKey.get(songKey(ref));
        const title = fullSong ? songTitle(fullSong) : ('display_title' in ref ? songTitle(ref as SongManifest) : ref.title);
        const label = lastAssignment ? this.singerLabel(lastAssignment) : null;
        const verb = atFront ? 'Up next:' : 'Queued';
        this.toast.success(label ? `${verb} “${title}” for ${label}` : `${verb} “${title}”`);
      } else if (createdTaskIds.length > 1) {
        this.toast.success(
          atFront
            ? `Queued ${createdTaskIds.length} songs up next`
            : `Added ${createdTaskIds.length} songs to queue`,
        );
      }

      return createdTaskIds;
    } catch (error) {
      console.error('Could not enqueue songs:', error);
      this.toast.error(
        total === 1 ? `Could not add “${songs[0].title}” to queue.` : 'Could not add songs to queue.',
      );
      throw error;
    }
  }

  /** Reorders the karaoke queue into round-robin singer turns if enabled. */
  async reorderQueueRoundRobin(justAddedTaskIds: readonly string[] = []): Promise<void> {
    if (!this.party.roundRobinEnabled()) return;
    try {
      const snapshot = await firstValueFrom(this.queue.queue$);
      const existing = snapshot.karaoke_queue.map((i) => ({ task_id: i.task_id }));
      const existingSet = new Set(existing.map((i) => i.task_id));
      for (const id of justAddedTaskIds) {
        if (!existingSet.has(id)) existing.push({ task_id: id });
      }
      const ordered = this.party.computeRoundRobinOrder(
        existing,
        this.songs.currentQueueTaskId(),
      );
      if (ordered) {
        await firstValueFrom(this.queue.reorderKaraokeTracks(ordered));
        this.queue.refresh(true);
      }
    } catch (error) {
      console.warn('Could not apply round-robin queue order:', error);
    }
  }

  private singerLabel(assignment: QueueSingerAssignment): string | null {
    const roster = this.party.roster();
    const s1 = roster.find((s) => s.id === assignment.primarySingerId);
    const s2 = roster.find((s) => s.id === assignment.secondarySingerId);
    if (s1 && s2) return `${s1.name} & ${s2.name}`;
    return s1?.name ?? null;
  }
}