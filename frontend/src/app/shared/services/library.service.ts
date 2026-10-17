import { Injectable, computed, inject, signal } from '@angular/core';

import { SongManifest, SongsService, songAlbum, songArtist, songTitle } from './songs.service';

export interface SongRef {
  artist: string;
  album: string;
  title: string;
}

export interface AlbumEntry {
  key: string;
  artist: string;
  album: string;
  displayArtist: string;
  displayAlbum: string;
  coverUrl: string | null;
  songs: SongManifest[];
}

export interface ArtistEntry {
  key: string;
  artist: string;
  displayArtist: string;
  coverUrl: string | null;
  albums: AlbumEntry[];
  songs: SongManifest[];
}

export type SearchHit =
  | { kind: 'song'; key: string; title: string; subtitle: string; coverUrl: string | null; songs: SongManifest[] }
  | { kind: 'album'; key: string; title: string; subtitle: string; coverUrl: string | null; songs: SongManifest[] }
  | { kind: 'artist'; key: string; title: string; subtitle: string; coverUrl: string | null; songs: SongManifest[] };

const normalize = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export const songKey = (song: SongRef): string => `${song.artist}\u0000${song.album}\u0000${song.title}`;
export const songCover = (song: SongManifest): string | null => song.covers[0]?.url ?? null;

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly songsService = inject(SongsService);

  readonly songs = signal<SongManifest[]>([]);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  private inflight: Promise<void> | null = null;

  readonly albums = computed<AlbumEntry[]>(() => {
    const groups = new Map<string, AlbumEntry>();
    for (const song of this.songs()) {
      const key = `${song.artist}\u0000${song.album}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { key, artist: song.artist, album: song.album, displayArtist: songArtist(song), displayAlbum: songAlbum(song), coverUrl: null, songs: [] };
        groups.set(key, entry);
      }
      entry.songs.push(song);
      entry.coverUrl ??= songCover(song);
    }
    return [...groups.values()];
  });

  readonly artists = computed<ArtistEntry[]>(() => {
    const groups = new Map<string, ArtistEntry>();
    for (const album of this.albums()) {
      let entry = groups.get(album.artist);
      if (!entry) {
        entry = { key: album.artist, artist: album.artist, displayArtist: album.displayArtist, coverUrl: null, albums: [], songs: [] };
        groups.set(album.artist, entry);
      }
      entry.albums.push(album);
      entry.songs.push(...album.songs);
      entry.coverUrl ??= album.coverUrl;
    }
    return [...groups.values()];
  });

  // Normalized haystacks are computed once per library change, so each keystroke is a cheap scan.
  private readonly index = computed(() => ({
    songs: this.songs().map((song) => ({
      song,
      text: normalize(`${songTitle(song)} ${songArtist(song)} ${songAlbum(song)}`),
      title: normalize(songTitle(song)),
    })),
    albums: this.albums().map((album) => ({ album, text: normalize(`${album.displayAlbum} ${album.displayArtist}`), title: normalize(album.displayAlbum) })),
    artists: this.artists().map((artist) => ({ artist, text: normalize(artist.displayArtist), title: normalize(artist.displayArtist) })),
  }));

  load(force = false): Promise<void> {
    if (this.loaded() && !force) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.loading.set(true);
    // A first load shows songs as each batch arrives; a refresh swaps the list once, avoiding flicker.
    const progressive = !this.loaded();
    const collected: SongManifest[] = [];
    this.inflight = this.songsService
      .streamSongs((batch) => {
        collected.push(...batch);
        if (progressive) this.songs.update((songs) => [...songs, ...batch]);
      }, progressive ? () => this.songs.set([]) : undefined)
      .then(() => {
        if (!progressive) this.songs.set(collected);
        this.loaded.set(true);
      })
      .finally(() => {
        this.loading.set(false);
        this.inflight = null;
      });
    return this.inflight;
  }

  search(query: string, limit = 8): SearchHit[] {
    const q = normalize(query.trim());
    if (!q) return [];
    const index = this.index();
    const rank = (text: string, title: string): number => {
      if (title.startsWith(q)) return 0;
      if (title.includes(q)) return 1;
      return text.includes(q) ? 2 : -1;
    };
    const collect = <T>(items: T[], pick: (item: T) => { text: string; title: string }): { item: T; score: number }[] =>
      items
        .map((item) => ({ item, score: rank(pick(item).text, pick(item).title) }))
        .filter((hit) => hit.score >= 0)
        .sort((a, b) => a.score - b.score)
        .slice(0, limit);

    const artists = collect(index.artists, (e) => e).map(({ item }): SearchHit => ({
      kind: 'artist',
      key: `artist:${item.artist.key}`,
      title: item.artist.displayArtist,
      subtitle: `Artist • ${item.artist.songs.length} songs`,
      coverUrl: item.artist.coverUrl,
      songs: item.artist.songs,
    }));
    const albums = collect(index.albums, (e) => e).map(({ item }): SearchHit => ({
      kind: 'album',
      key: `album:${item.album.key}`,
      title: item.album.displayAlbum,
      subtitle: `Album • ${item.album.displayArtist}`,
      coverUrl: item.album.coverUrl,
      songs: item.album.songs,
    }));
    const songs = collect(index.songs, (e) => e).map(({ item }): SearchHit => ({
      kind: 'song',
      key: `song:${songKey(item.song)}`,
      title: songTitle(item.song),
      subtitle: `${songArtist(item.song)} • ${songAlbum(item.song)}`,
      coverUrl: songCover(item.song),
      songs: [item.song],
    }));
    return [...songs.slice(0, 5), ...albums.slice(0, 3), ...artists.slice(0, 3)];
  }
}
