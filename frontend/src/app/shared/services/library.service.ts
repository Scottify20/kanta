import { Injectable, computed, inject, signal } from '@angular/core';

import { PlaylistsService } from './playlists.service';
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

export interface SearchHit {
  kind: 'song' | 'album' | 'artist' | 'playlist';
  key: string;
  title: string;
  subtitle: string;
  coverUrl: string | null;
  songs: SongManifest[];
  playlistId?: string;
}

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
  private readonly playlistsService = inject(PlaylistsService);

  readonly songs = signal<SongManifest[]>([]);
  readonly loaded = signal(false);
  readonly loading = signal(false);
  private inflight: Promise<void> | null = null;
  // Entry key (album:/artist:/playlist:) the library page should open as soon as it is shown.
  readonly pendingOpen = signal<string | null>(null);

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
    const collect = <T extends { text: string; title: string }>(items: T[]): { item: T; score: number }[] =>
      items
        .map((item) => ({ item, score: rank(item.text, item.title) }))
        .filter((hit) => hit.score >= 0)
        .sort((a, b) => a.score - b.score);

    const songIndex = new Map(this.songs().map((song) => [songKey(song), song]));
    const playlists = this.playlistsService.playlists().map((playlist) => {
      const name = normalize(playlist.name);
      return { playlist, text: name, title: name };
    });

    const songs = collect(index.songs);
    const artists = collect(index.artists);
    const albums = collect(index.albums);
    const matchedPlaylists = collect(playlists);

    const songHits = songs.map(({ item }): SearchHit => ({
      kind: 'song',
      key: `song:${songKey(item.song)}`,
      title: songTitle(item.song),
      subtitle: `${songArtist(item.song)} • ${songAlbum(item.song)}`,
      coverUrl: songCover(item.song),
      songs: [item.song],
    }));
    const artistHits = artists.map(({ item }): SearchHit => ({
      kind: 'artist',
      key: `artist:${item.artist.key}`,
      title: item.artist.displayArtist,
      subtitle: `Artist • ${item.artist.songs.length} ${item.artist.songs.length === 1 ? 'song' : 'songs'}`,
      coverUrl: item.artist.coverUrl,
      songs: item.artist.songs,
    }));
    const albumHits = albums.map(({ item }): SearchHit => ({
      kind: 'album',
      key: `album:${item.album.key}`,
      title: item.album.displayAlbum,
      subtitle: `Album • ${item.album.displayArtist}`,
      coverUrl: item.album.coverUrl,
      songs: item.album.songs,
    }));
    const playlistHits = matchedPlaylists.map(({ item }): SearchHit => {
      const members = item.playlist.songs
        .map((ref) => songIndex.get(songKey(ref)))
        .filter((song): song is SongManifest => !!song);
      return {
        kind: 'playlist',
        key: `playlist:${item.playlist.id}`,
        title: item.playlist.name,
        subtitle: `Playlist • ${item.playlist.song_count} ${item.playlist.song_count === 1 ? 'song' : 'songs'}`,
        coverUrl: item.playlist.cover_urls[0] ?? null,
        songs: members,
        playlistId: item.playlist.id,
      };
    });

    // Songs also match on artist/album text, so only count songs whose own title matches.
    // Artist, album and playlist groups matching by name more often than songs lead the results.
    const titleMatches = songs.filter(({ score }) => score < 2).length;
    const groups: { hits: SearchHit[]; matches: number; cap: number; order: number }[] = [
      { hits: songHits, matches: titleMatches, cap: 5, order: 0 },
      { hits: artistHits, matches: artists.length, cap: 3, order: 1 },
      { hits: albumHits, matches: albums.length, cap: 3, order: 2 },
      { hits: playlistHits, matches: playlistHits.length, cap: 3, order: 3 },
    ];
    const leading = groups
      .filter((group) => group.order > 0 && group.matches > titleMatches)
      .sort((a, b) => b.matches - a.matches || a.order - b.order);
    const rest = groups.filter((group) => !leading.includes(group));
    return [...leading, ...rest].flatMap((group) => group.hits.slice(0, Math.min(group.cap, limit)));
  }
}
