import type { QueueItem } from '../../features/queue/interfaces/queue.models';
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

export type SongMetadataUpdate = Partial<Omit<SongManifest, 'stems' | 'lyrics' | 'covers' | 'master' | 'duration_seconds' | 'date_added' | 'max_offset_ms' | 'replaygain_track_gain' | 'replaygain_track_peak' | 'replaygain_album_gain' | 'replaygain_album_peak'>> & {
  replaygain_track_gain?: string | number | null;
  replaygain_track_peak?: string | number | null;
  replaygain_album_gain?: string | number | null;
  replaygain_album_peak?: string | number | null;
};

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
  album_artist?: string | null;
  year?: string | number | null;
  genre?: string | null;
  track_number?: number | null;
  disc_number?: number | null;
  comment?: string | null;
  composer?: string | null;
  bpm?: number | null;
  replaygain_track_gain?: string | null;
  replaygain_track_peak?: string | null;
  replaygain_album_gain?: string | null;
  replaygain_album_peak?: string | null;
  duration_seconds?: number | null;
  date_added?: string | null;
  max_offset_ms?: number | null;
}

@Injectable({ providedIn: 'root' })
export class SongsService {
  private readonly http = inject(HttpClient);
  readonly selectedSong = signal<SongManifest | null>(null);
  readonly selectedSongQueueTaskId = signal<string | null>(null);
  readonly playRequested = signal(false);
  readonly currentSong = signal<SongManifest | null>(null);
  readonly currentQueueTaskId = signal<string | null>(null);
  // A karaoke queue track picked from the shell-level queue; now-playing consumes it.
  readonly queueTrackRequest = signal<QueueItem | null>(null);

  requestQueueTrack(item: QueueItem): void {
    this.queueTrackRequest.set(item);
  }

  consumeQueueTrackRequest(): void {
    this.queueTrackRequest.set(null);
  }

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
    metadata: SongMetadataUpdate,
  ): Observable<SongManifest> {
    return this.http.patch<SongManifest>(
      `${this.songUrl(song)}/metadata`,
      metadata,
    );
  }

  uploadSongCover(song: Pick<SongManifest, 'artist' | 'album' | 'title'>, file: File): Observable<{ cover_url: string | null }> {
    const body = new FormData();
    body.append('file', file);
    return this.http.put<{ cover_url: string | null }>(`${this.songUrl(song)}/cover`, body);
  }

  deleteSongCover(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): Observable<{ cover_url: null }> {
    return this.http.delete<{ cover_url: null }>(`${this.songUrl(song)}/cover`);
  }

  uploadSongLyrics(song: Pick<SongManifest, 'artist' | 'album' | 'title'>, file: File): Observable<{ name: string; lyrics_level: LyricsLevel }> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<{ name: string; lyrics_level: LyricsLevel }>(`${this.songUrl(song)}/lyrics`, body);
  }

  deleteSongLyrics(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): Observable<{ lyrics_level: LyricsLevel }> {
    return this.http.delete<{ lyrics_level: LyricsLevel }>(`${this.songUrl(song)}/lyrics`);
  }

  analyzeSongReplayGain(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): Observable<Pick<SongManifest, 'replaygain_track_gain' | 'replaygain_track_peak'>> {
    return this.http.post<Pick<SongManifest, 'replaygain_track_gain' | 'replaygain_track_peak'>>(
      `${this.songUrl(song)}/replaygain/analyze`, {},
    );
  }

  private songUrl(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): string {
    return `${API_URL}/api/songs/${encodeURIComponent(song.artist)}/${encodeURIComponent(song.album)}/${encodeURIComponent(song.title)}`;
  }
}
