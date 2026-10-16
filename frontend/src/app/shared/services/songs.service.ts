import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { API_URL } from './settings.service';

export type LyricsLevel = 'word' | 'line' | 'none';

export interface SongFile {
  name: string;
  url: string;
  level?: LyricsLevel;
}

export interface SongManifest {
  artist: string;
  album: string;
  title: string;
  stems: SongFile[];
  lyrics: SongFile[];
  lyrics_level?: LyricsLevel;
  lyrics_offset_ms?: number;
  covers: SongFile[];
  master: string | null;
}

@Injectable({ providedIn: 'root' })
export class SongsService {
  private readonly http = inject(HttpClient);
  readonly selectedSong = signal<SongManifest | null>(null);
  readonly selectedSongQueueTaskId = signal<string | null>(null);
  readonly playRequested = signal(false);
  readonly currentSong = signal<SongManifest | null>(null);
  readonly currentQueueTaskId = signal<string | null>(null);

  setNowPlaying(song: SongManifest | null, queueTaskId: string | null = null): void {
    this.currentSong.set(song);
    this.currentQueueTaskId.set(queueTaskId);
  }

  selectSong(song: SongManifest, playImmediately = false, queueTaskId: string | null = null): void {
    this.selectedSong.set(song);
    this.selectedSongQueueTaskId.set(queueTaskId);
    this.playRequested.set(playImmediately);
  }

  consumePlayRequest(): void {
    this.playRequested.set(false);
  }

  getManifest(artist: string, album: string, title: string): Observable<SongManifest> {
    return this.http.get<SongManifest>(
      `${API_URL}/api/songs/${encodeURIComponent(artist)}/${encodeURIComponent(album)}/${encodeURIComponent(title)}`,
    );
  }

  listSongs(): Observable<SongManifest[]> {
    return this.http.get<SongManifest[]>(`${API_URL}/api/songs`);
  }

  saveLyricsTiming(
    song: Pick<SongManifest, 'artist' | 'album' | 'title'>,
    offsetMs: number,
  ): Observable<{ offset_ms: number }> {
    return this.http.put<{ offset_ms: number }>(
      `${API_URL}/api/songs/${encodeURIComponent(song.artist)}/${encodeURIComponent(song.album)}/${encodeURIComponent(song.title)}/lyrics-timing`,
      { offset_ms: offsetMs },
    );
  }

  updateSongMetadata(
    song: Pick<SongManifest, 'artist' | 'album' | 'title'>,
    metadata: Pick<SongManifest, 'artist' | 'album' | 'title'>,
  ): Observable<Pick<SongManifest, 'artist' | 'album' | 'title'>> {
    return this.http.patch<Pick<SongManifest, 'artist' | 'album' | 'title'>>(
      `${API_URL}/api/songs/${encodeURIComponent(song.artist)}/${encodeURIComponent(song.album)}/${encodeURIComponent(song.title)}/metadata`,
      metadata,
    );
  }
}
