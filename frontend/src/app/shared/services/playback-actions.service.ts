import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { QueueService } from '../../features/queue/data-access/queue.service';
import { QueueItem } from '../../features/queue/interfaces/queue.models';
import { SongRef } from './library.service';
import { SongManifest, SongsService } from './songs.service';
import { PartySessionService, QueueSingerAssignment } from './party-session.service';
import { SongAssignmentService } from './song-assignment.service';

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
  private readonly party = inject(PartySessionService);
  private readonly router = inject(Router);
  private readonly assignmentService = inject(SongAssignmentService);

  /** Replaces only the karaoke queue and starts the first song. Returns the created task IDs. */
  async playSongs(
    songs: SongManifest[],
    anchor?: HTMLElement | MouseEvent | null,
  ): Promise<string[]> {
    const playable = songs.filter(isPlayable);
    if (!playable.length) return [];

    const total = playable.length;
    const staged: { song: SongManifest; assignment: QueueSingerAssignment }[] = [];
    for (let i = 0; i < total; i++) {
      const song = playable[i];
      const assignment = await this.assignmentService.resolveAssignment(
        song,
        song.is_duet === true,
        anchor,
        i + 1,
        total,
      );
      staged.push({ song, assignment });
    }

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
    void this.router.navigateByUrl('/');
    return createdTaskIds;
  }

  /** Enqueues songs sequentially through the assignment prompt and returns the created task IDs. */
  async enqueue(
    songs: SongRef[],
    afterTaskId: string | null = null,
    atFront = false,
    anchor?: HTMLElement | MouseEvent | null,
  ): Promise<string[]> {
    let anchorTaskId = afterTaskId;
    let first = true;
    const createdTaskIds: string[] = [];
    const total = songs.length;

    for (let i = 0; i < total; i++) {
      const song = songs[i];
      const isDuet = song.is_duet === true;
      const assignment = await this.assignmentService.resolveAssignment(
        song as SongManifest,
        isDuet,
        anchor,
        i + 1,
        total,
      );

      const result: { item: QueueItem } = await firstValueFrom(
        this.queue.addProcessedTrack(song, atFront && first && !anchorTaskId, anchorTaskId, true),
      );
      this.party.setExplicitQueueAssignment(result.item.task_id, assignment);
      createdTaskIds.push(result.item.task_id);
      anchorTaskId = result.item.task_id;
      first = false;
    }

    return createdTaskIds;
  }
}