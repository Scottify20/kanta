import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { QueueService } from '../../features/queue/data-access/queue.service';
import { QueueItem } from '../../features/queue/interfaces/queue.models';
import { SongRef } from './library.service';
import { SongManifest, SongsService } from './songs.service';

type StemFile = SongManifest['stems'][number];

const stemNamed = (stems: StemFile[], kind: 'vocals' | 'instrumental'): StemFile | undefined =>
  stems.find((file) => new RegExp(`\\(${kind}\\)\\.[a-z0-9]+$`, 'i').test(file.name));

// Full mode also writes "(Lead Vocals)" / "(Backing Vocals)", so match the exact "(Vocals)" suffix.
export const findPlaybackStems = (stems: StemFile[]): { vocals: StemFile; instrumental: StemFile } | null => {
  const vocals = stemNamed(stems, 'vocals');
  const instrumental = stemNamed(stems, 'instrumental');
  return vocals && instrumental ? { vocals, instrumental } : null;
};

export const isPlayable = (song: Pick<SongManifest, 'stems'>): boolean =>
  findPlaybackStems(song.stems) !== null;

// Shared "play / enqueue" behaviour for the library, search results and playlists.
@Injectable({ providedIn: 'root' })
export class PlaybackActions {
  private readonly queue = inject(QueueService);
  private readonly songs = inject(SongsService);
  private readonly router = inject(Router);

  /** Replaces only the karaoke queue (never the processing queue) and starts the first song. */
  async playSongs(songs: SongManifest[]): Promise<void> {
    const playable = songs.filter(isPlayable);
    if (!playable.length) return;
    await firstValueFrom(this.queue.clearQueue(1));
    let afterTaskId: string | null = null;
    let firstTaskId: string | null = null;
    for (const song of playable) {
      const result: { item: QueueItem } = await firstValueFrom(
        this.queue.addProcessedTrack(song, false, afterTaskId),
      );
      const item = result.item;
      firstTaskId ??= item.task_id;
      afterTaskId = item.task_id;
    }
    this.songs.selectSong(playable[0], true, firstTaskId);
    void this.router.navigateByUrl('/');
  }

  /** Inserts songs into the karaoke queue after `afterTaskId` (front when null and `atFront`). */
  async enqueue(songs: SongRef[], afterTaskId: string | null = null, atFront = false): Promise<void> {
    let anchor = afterTaskId;
    let first = true;
    for (const song of songs) {
      const result: { item: QueueItem } = await firstValueFrom(
        this.queue.addProcessedTrack(song, atFront && first && !anchor, anchor),
      );
      anchor = result.item.task_id;
      first = false;
    }
  }
}
