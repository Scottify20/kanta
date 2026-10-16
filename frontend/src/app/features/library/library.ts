import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Observable, switchMap } from 'rxjs';
import { LucideMoreHorizontal } from '@lucide/angular';

import { PopupPanel } from '../../shared/components/popup-panel/popup-panel';
import { LyricsLevel, SongManifest, SongsService } from '../../shared/services/songs.service';
import { QueueSheet } from '../queue/ui/queue-sheet/queue-sheet';
import { QueueService } from '../queue/data-access/queue.service';
import { QueueItem } from '../queue/interfaces/queue.models';
import { MetadataEditor } from './ui/metadata-editor/metadata-editor';

@Component({
  selector: 'app-library',
  imports: [
    AsyncPipe,
    NgFor,
    NgIf,
    RouterLink,
    QueueSheet,
    MetadataEditor,
    PopupPanel,
    LucideMoreHorizontal,
  ],
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library {
  private readonly songsService = inject(SongsService);
  private readonly router = inject(Router);
  private readonly queueService = inject(QueueService);
  songs$: Observable<SongManifest[]> = this.songsService.listSongs();
  readonly pageArtwork = computed(() => this.songsService.currentSong()?.covers[0]?.url ?? null);
  readonly activeTaskId = computed(() => this.songsService.currentQueueTaskId());
  readonly queueOpen = signal(false);
  readonly processedItemDrag = signal(false);
  readonly editingSong = signal<SongManifest | null>(null);
  readonly savingMetadata = signal(false);
  readonly actionError = signal('');

  startDrag(event: DragEvent, song: SongManifest): void {
    if (!this.isPlayable(song)) {
      event.preventDefault();
      return;
    }
    this.processedItemDrag.set(true);
    event.dataTransfer?.setData('application/x-kanta-processed', JSON.stringify(song));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
    }
  }

  playSong(song: SongManifest): void {
    if (!this.isPlayable(song)) {
      return;
    }
    this.actionError.set('');
    this.queueService
      .clearAllQueue()
      .pipe(switchMap(() => this.queueService.addProcessedTrack(song)))
      .subscribe({
        next: ({ item }) => this.navigateToSong(song, item.task_id),
        error: () => this.actionError.set('Could not queue this song for playback.'),
      });
  }

  selectQueueTrack(item: QueueItem): void {
    const artist = item.artist || item.raw_artist;
    const album = item.album || item.raw_album;
    const title = item.title || item.raw_title;
    if (!artist || !album || !title) return;

    this.songsService.getManifest(artist, album, title).subscribe({
      next: (manifest) => this.navigateToSong(manifest, item.task_id),
      error: () => this.actionError.set('Could not load track. It may still be processing.'),
    });
  }

  playNext(song: SongManifest): void {
    if (!this.isPlayable(song)) return;
    this.queueService
      .addProcessedTrack(song, true, this.songsService.currentQueueTaskId())
      .subscribe({
        error: () => this.actionError.set('Could not add this song to play next.'),
      });
  }

  addToKaraokeQueue(song: SongManifest): void {
    if (!this.isPlayable(song)) {
      return;
    }
    this.queueService.addProcessedTrack(song).subscribe();
  }

  editMetadata(song: SongManifest): void {
    this.actionError.set('');
    this.editingSong.set(song);
  }

  closeMetadataEditor(): void {
    this.editingSong.set(null);
  }

  saveMetadata(metadata: Pick<SongManifest, 'artist' | 'album' | 'title'>): void {
    const song = this.editingSong();
    if (!song) return;
    const updatedMetadata = {
      artist: metadata.artist.trim(),
      album: metadata.album.trim(),
      title: metadata.title.trim(),
    };
    if (!updatedMetadata.artist || !updatedMetadata.album || !updatedMetadata.title) {
      this.actionError.set('Artist, album, and title are required.');
      return;
    }
    this.savingMetadata.set(true);
    this.actionError.set('');
    this.songsService.updateSongMetadata(song, updatedMetadata).subscribe({
      next: (updated) => {
        this.editingSong.set(null);
        this.savingMetadata.set(false);
        this.songs$ = this.songsService.listSongs();
        const current = this.songsService.currentSong();
        if (
          current?.artist === song.artist &&
          current.album === song.album &&
          current.title === song.title
        ) {
          this.songsService.getManifest(updated.artist, updated.album, updated.title).subscribe({
            next: (manifest) =>
              this.songsService.setNowPlaying(manifest, this.songsService.currentQueueTaskId()),
          });
        }
      },
      error: (error) => {
        this.actionError.set(error.error?.detail ?? 'Could not update song metadata.');
        this.savingMetadata.set(false);
      },
    });
  }

  isPlayable(song: SongManifest): boolean {
    return (
      song.stems.some((file) => file.name.toLowerCase().includes('vocals')) &&
      song.stems.some((file) => file.name.toLowerCase().includes('instrumental'))
    );
  }

  lyricsLevelLabel(level?: LyricsLevel): string {
    if (level === 'word') return 'Word-level lyrics';
    if (level === 'line') return 'Line-level lyrics';
    return 'No lyrics';
  }

  private navigateToSong(song: SongManifest, queueTaskId: string): void {
    this.songsService.selectSong(song, true, queueTaskId);
    void this.router.navigateByUrl('/');
  }

  handleDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    this.processedItemDrag.set(types.includes('application/x-kanta-processed'));
    if (types.includes('Files') || types.includes('application/x-kanta-processed')) {
      event.preventDefault();
      this.queueOpen.set(true);
    }
  }

  endDrag(): void {
    this.processedItemDrag.set(false);
  }

  closeQueue(): void {
    this.queueOpen.set(false);
  }
}
