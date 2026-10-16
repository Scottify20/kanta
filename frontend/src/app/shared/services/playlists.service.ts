import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { API_URL } from './settings.service';
import { SongRef } from './library.service';

export interface Playlist {
  id: string;
  name: string;
  songs: (SongRef & { cover_url?: string | null })[];
  cover_urls: string[];
  song_count: number;
  total_duration_seconds: number;
}

@Injectable({ providedIn: 'root' })
export class PlaylistsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${API_URL}/api/playlists`;
  readonly playlists = signal<Playlist[]>([]);

  refresh(): void {
    this.http.get<Playlist[]>(this.base).subscribe({
      next: (list) => this.playlists.set(list),
      error: () => undefined,
    });
  }

  create(name: string): Observable<Playlist> {
    return this.http.post<Playlist>(this.base, { name }).pipe(tap(() => this.refresh()));
  }

  rename(id: string, name: string): Observable<Playlist> {
    return this.http.patch<Playlist>(`${this.base}/${id}`, { name }).pipe(tap(() => this.refresh()));
  }

  delete(id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.base}/${id}`).pipe(tap(() => this.refresh()));
  }

  addSongs(id: string, songs: SongRef[]): Observable<Playlist> {
    return this.http
      .post<Playlist>(`${this.base}/${id}/songs`, {
        songs: songs.map(({ artist, album, title }) => ({ artist, album, title })),
      })
      .pipe(tap(() => this.refresh()));
  }

  removeSong(id: string, index: number): Observable<Playlist> {
    return this.http.delete<Playlist>(`${this.base}/${id}/songs/${index}`).pipe(tap(() => this.refresh()));
  }
}
