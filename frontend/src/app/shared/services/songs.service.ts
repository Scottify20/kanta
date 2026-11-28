import type { QueueItem } from '../../features/queue/interfaces/queue.models';
import type { DuetVocalRanges } from './vocal-fit';
import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, firstValueFrom, map } from 'rxjs';

import { API_URL } from '../../app.config';

export type LyricsLevel = 'word' | 'line' | 'none';

export interface LyricsCandidate {
  found: boolean;
  provider?: string;
  level?: LyricsLevel;
  format?: 'ttml' | 'lrc';
  content?: string;
}

export interface SongFile {
  name: string;
  url: string;
  level?: LyricsLevel;
}

export interface BatchSongAnalysisOptions {
  vocal_range: boolean;
  musical_key: boolean;
  bpm: boolean;
  replaygain: boolean;
  missing_only: boolean;
}

export interface AnalysisTaskStatus {
  task_id: string;
  status: string;
  progress: number;
  step: string;
  total?: number;
  processed?: number;
  analyzed?: number;
  skipped?: number;
  error?: string;
}

export type SongMetadataUpdate = Partial<
  Omit<
    SongManifest,
    | 'stems'
    | 'lyrics'
    | 'covers'
    | 'cover_url'
    | 'master'
    | 'duration_seconds'
    | 'date_added'
    | 'max_offset_ms'
    | 'vocal_min_hz'
    | 'vocal_max_hz'
    | 'vocal_min_note'
    | 'vocal_max_note'
    | 'vocal_tessitura_min_hz'
    | 'vocal_tessitura_max_hz'
    | 'vocal_tessitura_min_note'
    | 'vocal_tessitura_max_note'
    | 'vocal_voice_type'
    | 'duet_vocal_ranges'
    | 'replaygain_track_gain'
    | 'replaygain_track_peak'
    | 'replaygain_album_gain'
    | 'replaygain_album_peak'
  >
> & {
  replaygain_track_gain?: string | number | null;
  replaygain_track_peak?: string | number | null;
  replaygain_album_gain?: string | number | null;
  replaygain_album_peak?: string | number | null;
};

export interface SongManifest {
  artist: string;
  album: string;
  title: string;
  display_title?: string;
  display_artist?: string;
  display_album?: string;
  stems: SongFile[];
  lyrics: SongFile[];
  lyrics_level?: LyricsLevel;
  is_duet?: boolean;
  lyrics_offset_ms?: number;
  covers: SongFile[];
  cover_url?: string | null;
  master: string | null;
  album_artist?: string | null;
  year?: string | number | null;
  genre?: string | null;
  track_number?: number | null;
  disc_number?: number | null;
  comment?: string | null;
  composer?: string | null;
  bpm?: number | null;
  musical_key?: string | null;
  replaygain_track_gain?: string | number | null;
  replaygain_track_peak?: string | number | null;
  replaygain_album_gain?: string | number | null;
  replaygain_album_peak?: string | number | null;
  duration_seconds?: number | null;
  date_added?: string | null;
  max_offset_ms?: number | null;
  vocal_min_hz?: number | null;
  vocal_max_hz?: number | null;
  vocal_min_note?: string | null;
  vocal_max_note?: string | null;
  vocal_tessitura_min_hz?: number | null;
  vocal_tessitura_max_hz?: number | null;
  vocal_tessitura_min_note?: string | null;
  vocal_tessitura_max_note?: string | null;
  vocal_voice_type?: 'Bass' | 'Baritone' | 'Tenor' | 'Alto' | 'Mezzo-Soprano' | 'Soprano' | null;
  duet_vocal_ranges?: DuetVocalRanges | null;
}

export function cleanStemTitle(title: string | null | undefined): string {
  if (!title) return '';
  const cleaned = title.replace(/\s*[\(\[]\s*(?:instrumental|vocals?)\s*[\)\]]/gi, '').trim();
  return cleaned || title;
}

export function sanitizeManifest(song: SongManifest): SongManifest {
  return {
    ...song,
    display_title: cleanStemTitle(song.display_title || song.title),
  };
}

// Folder keys are sanitized; these return the real tag values for display.
export const songTitle = (song: SongManifest): string =>
  cleanStemTitle(song.display_title || song.title);
export const songArtist = (song: SongManifest): string => song.display_artist || song.artist;
export const songAlbum = (song: SongManifest): string => song.display_album || song.album;
export const hasVocalRange = (
  song: Pick<SongManifest, 'vocal_min_hz' | 'vocal_max_hz'>,
): boolean =>
  Number.isFinite(song.vocal_min_hz) && Number.isFinite(song.vocal_max_hz);
export const hasVocalStem = (song: Pick<SongManifest, 'stems'>): boolean =>
  song.stems.some((stem) => /\(Vocals\)\.[a-z0-9]+$/i.test(stem.name));

@Injectable({ providedIn: 'root' })
export class SongsService {
  private readonly http = inject(HttpClient);
  private readonly vocalRangeRequests = new Map<string, Promise<SongManifest | null>>();
  private readonly vocalRangeAttempts = new Set<string>();
  readonly selectedSong = signal<SongManifest | null>(null);
  readonly selectedSongQueueTaskId = signal<string | null>(null);
  readonly playRequested = signal(false);
  readonly currentSong = signal<SongManifest | null>(null);
  readonly currentQueueTaskId = signal<string | null>(null);
  readonly queueTrackRequest = signal<QueueItem | null>(null);

  requestQueueTrack(item: QueueItem): void {
    this.queueTrackRequest.set(item);
  }

  consumeQueueTrackRequest(): void {
    this.queueTrackRequest.set(null);
  }

  setNowPlaying(song: SongManifest | null, queueTaskId: string | null = null): void {
    this.currentSong.set(song ? sanitizeManifest(song) : null);
    this.currentQueueTaskId.set(queueTaskId);
  }

  selectSong(song: SongManifest, playImmediately = false, queueTaskId: string | null = null): void {
    const clean = sanitizeManifest(song);
    this.selectedSong.set(clean);
    this.selectedSongQueueTaskId.set(queueTaskId);
    this.playRequested.set(playImmediately);
  }

  consumePlayRequest(): void {
    this.playRequested.set(false);
  }

  getManifest(artist: string, album: string, title: string): Observable<SongManifest> {
    return this.http
      .get<SongManifest>(
        `${API_URL}/api/songs/${encodeURIComponent(artist)}/${encodeURIComponent(album)}/${encodeURIComponent(title)}`,
      )
      .pipe(map(sanitizeManifest));
  }

  analyzeSongVocalRange(song: SongManifest, force = false): Promise<SongManifest | null> {
    const key = `${song.artist}\u0000${song.album}\u0000${song.title}`;
    if (hasVocalRange(song) && !force) return Promise.resolve(song);
    if (this.vocalRangeAttempts.has(key) && !force) return Promise.resolve(null);
    const pending = this.vocalRangeRequests.get(key);
    if (pending) return pending;

    const request = firstValueFrom(
      this.http.post<{ song: SongManifest }>(
        `${this.songUrl(song)}/vocal-range/analyze`,
        { vocal_range: true, replaygain: false },
      ),
    )
      .then(({ song: updated }) => {
        const clean = sanitizeManifest(updated);
        this.vocalRangeAttempts.add(key);
        this.currentSong.update((current) =>
          current && songIdentity(current) === key ? clean : current,
        );
        return clean;
      })
      .finally(() => {
        this.vocalRangeRequests.delete(key);
      });
    this.vocalRangeRequests.set(key, request);
    return request;
  }

  analyzeSongMusicalKey(song: SongManifest): Promise<SongManifest> {
    return firstValueFrom(
      this.http.post<{ song: SongManifest }>(
        `${this.songUrl(song)}/vocal-range/analyze`,
        { vocal_range: false, musical_key: true, bpm: false, replaygain: false },
      ),
    ).then(({ song: updated }) => {
      const clean = sanitizeManifest(updated);
      this.currentSong.update((current) =>
        current && songIdentity(current) === songIdentity(song) ? clean : current,
      );
      return clean;
    });
  }

  startLibraryReanalysis(options: BatchSongAnalysisOptions): Observable<{ task_id: string; status: string }> {
    return this.http.post<{ task_id: string; status: string }>(
      `${API_URL}/api/songs/reanalyze`,
      options,
    );
  }

  getAnalysisTaskStatus(taskId: string): Observable<AnalysisTaskStatus> {
    return this.http.get<AnalysisTaskStatus>(`${API_URL}/api/status/${encodeURIComponent(taskId)}`);
  }

  cancelAnalysisTask(taskId: string): Observable<{ task_id?: string; status: string; message?: string }> {
    return this.http.post<{ task_id?: string; status: string; message?: string }>(
      `${API_URL}/api/cancel/${encodeURIComponent(taskId)}`,
      {},
    );
  }

  autoFetchLyrics(song: { artist: string; album: string; title: string }): Observable<{ lyrics_level: LyricsLevel; changed: boolean }> {
    return this.http.post<{ lyrics_level: LyricsLevel; changed: boolean }>(
      `${API_URL}/api/songs/${encodeURIComponent(song.artist)}/${encodeURIComponent(song.album)}/${encodeURIComponent(song.title)}/lyrics/auto-fetch`,
      {},
    );
  }

  listSongs(refresh = false): Observable<SongManifest[]> {
    const url = refresh ? `${API_URL}/api/songs?refresh=true` : `${API_URL}/api/songs`;
    return this.http.get<SongManifest[]>(url).pipe(
      map((songs) => songs.map(sanitizeManifest)),
    );
  }

  async streamSongs(
    onBatch: (songs: SongManifest[]) => void,
    onStart?: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${API_URL}/api/songs/stream`, { signal });
    if (!response.ok || !response.body) throw new Error(`Could not load songs (${response.status})`);
    onStart?.();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        pending += value ?? '';
        const lines = pending.split('\n');
        pending = done ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          if (line.trim()) {
            const batch = JSON.parse(line) as SongManifest[];
            onBatch(batch.map(sanitizeManifest));
          }
        }
        if (done) return;
      }
    } finally {
      reader.releaseLock();
    }
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
    return this.http
      .patch<SongManifest>(`${this.songUrl(song)}/metadata`, metadata)
      .pipe(map(sanitizeManifest));
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

  refetchSongLyrics(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): Observable<LyricsCandidate> {
    return this.http.post<LyricsCandidate>(`${this.songUrl(song)}/lyrics/refetch`, {});
  }

  applySongLyrics(
    song: Pick<SongManifest, 'artist' | 'album' | 'title'>,
    lyrics: Pick<LyricsCandidate, 'format' | 'content'>,
  ): Observable<{ name: string; lyrics_level: LyricsLevel }> {
    return this.http.put<{ name: string; lyrics_level: LyricsLevel }>(`${this.songUrl(song)}/lyrics/apply`, lyrics);
  }

  deleteSongLyrics(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): Observable<{ lyrics_level: LyricsLevel }> {
    return this.http.delete<{ lyrics_level: LyricsLevel }>(`${this.songUrl(song)}/lyrics`);
  }

  analyzeSongReplayGain(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): Observable<Pick<SongManifest, 'replaygain_track_gain' | 'replaygain_track_peak'>> {
    return this.http.post<Pick<SongManifest, 'replaygain_track_gain' | 'replaygain_track_peak'>>(
      `${this.songUrl(song)}/replaygain/analyze`,
      {},
    );
  }

  deleteSong(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(this.songUrl(song));
  }

  private songUrl(song: Pick<SongManifest, 'artist' | 'album' | 'title'>): string {
    return `${API_URL}/api/songs/${encodeURIComponent(song.artist)}/${encodeURIComponent(song.album)}/${encodeURIComponent(song.title)}`;
  }
}

const songIdentity = (song: Pick<SongManifest, 'artist' | 'album' | 'title'>): string =>
  `${song.artist}\u0000${song.album}\u0000${song.title}`;