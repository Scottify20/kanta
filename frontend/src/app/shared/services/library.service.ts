import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { PlaylistsService } from './playlists.service';
import { SettingsService } from './settings.service';
import { ToastService } from './toast.service';
import {
  SongManifest,
  SongsService,
  hasVocalRange,
  hasVocalStem,
  songAlbum,
  songArtist,
  songTitle,
} from './songs.service';
import type { LibraryTab, LyricsFilter, SortMode } from '../../features/library/data/library-entries';
import { DEFAULT_ARTIST_DELIMITER_LIST, DEFAULT_GENRE_DELIMITER_LIST, metadataValueKey, splitMetadataValues } from '../util/metadata-delimiters';
import { readCachedSongs, writeCachedSongs } from '../util/library-cache';

export interface SongRef {
  artist: string;
  album: string;
  title: string;
  is_duet?: boolean;
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
export const songCover = (song: SongManifest): string | null =>
  song.cover_url
  ?? (song.covers.find((cover) => /\.(?:jpe?g|png|webp|gif|bmp|avif|svg)$/i.test(cover.name)) ?? song.covers[0])?.url
  ?? null;

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly songsService = inject(SongsService);
  private readonly playlistsService = inject(PlaylistsService);
  private readonly settingsService = inject(SettingsService);
  private readonly toast = inject(ToastService);

  readonly songs = signal<SongManifest[]>([]);
  readonly songByKey = computed(
    () => new Map(this.songs().map((song) => [songKey(song), song])),
  );
  readonly loaded = signal(false);
  readonly loading = signal(false);
  readonly sorts = signal<Record<LibraryTab, SortMode>>({
    songs: 'az', genres: 'az', albums: 'az', artists: 'az', playlists: 'az',
  });
  readonly activeTab = signal<LibraryTab>('songs');
  readonly lyricsFilter = signal<LyricsFilter>('all');
  private inflight: Promise<void> | null = null;
  private pendingForceReload = false;
  private hydratedFromCache = false;
  private vocalRangeAnalysisQueue: Promise<void> = Promise.resolve();
  private readonly vocalRangeRequests = new Map<string, Promise<SongManifest | null>>();
  readonly pendingOpen = signal<string | null>(null);

  constructor() {
    this.settingsService.getSettings().subscribe({
      next: (settings) => {
        this.settingsService.artistDelimiters.set(settings.artist_delimiters ?? DEFAULT_ARTIST_DELIMITER_LIST);
        this.settingsService.genreDelimiters.set(settings.genre_delimiters ?? DEFAULT_GENRE_DELIMITER_LIST);
      },
      error: (error: unknown) => console.error('Could not load metadata delimiters:', error),
    });
  }

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
      const albumsByArtist = new Map<string, AlbumEntry>();
      for (const song of album.songs) {
        for (const artistName of splitMetadataValues(songArtist(song), this.settingsService.artistDelimiters())) {
          const key = metadataValueKey(artistName);
          let entry = groups.get(key);
          if (!entry) {
            entry = { key, artist: song.artist, displayArtist: artistName, coverUrl: null, albums: [], songs: [] };
            groups.set(key, entry);
          }
          entry.songs.push(song);
          entry.coverUrl ??= songCover(song);

          let artistAlbum = albumsByArtist.get(key);
          if (!artistAlbum) {
            artistAlbum = { ...album, displayArtist: artistName, coverUrl: songCover(song), songs: [] };
            albumsByArtist.set(key, artistAlbum);
            entry.albums.push(artistAlbum);
          }
          artistAlbum.songs.push(song);
        }
      }
    }
    return [...groups.values()];
  });

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
    if (this.inflight) {
      if (force) this.pendingForceReload = true;
      return this.inflight;
    }

    this.inflight = this.runLoad().finally(() => {
      this.inflight = null;
      if (this.pendingForceReload) {
        this.pendingForceReload = false;
        void this.load(true);
      }
    });
    return this.inflight;
  }

  /** Forces a full disk rescan on the backend and updates both memory and IndexedDB. */
  async refreshFromDisk(): Promise<void> {
    const fresh = await firstValueFrom(this.songsService.listSongs(true));
    this.songs.set(fresh);
    this.loaded.set(true);
    void writeCachedSongs(fresh);
    this.playlistsService.refresh();
  }

  /** Immediately removes deleted songs from the UI signal and IndexedDB cache. */
  removeSongs(targets: readonly SongRef[]): void {
    if (!targets.length) return;
    const keys = new Set(targets.map(songKey));
    this.songs.update((songs) => songs.filter((song) => !keys.has(songKey(song))));
    void writeCachedSongs(this.songs());
  }

  private async runLoad(): Promise<void> {
    if (!this.hydratedFromCache && this.songs().length === 0) {
      this.hydratedFromCache = true;
      const cached = await readCachedSongs();
      if (cached?.length) {
        this.songs.set(cached);
        this.loaded.set(true);
      }
    }

    const showSpinner = this.songs().length === 0;
    if (showSpinner) this.loading.set(true);

    try {
      if (!showSpinner) {
        const fresh = await firstValueFrom(this.songsService.listSongs());
        this.songs.set(fresh);
        this.loaded.set(true);
        void writeCachedSongs(fresh);
        return;
      }

      const collected: SongManifest[] = [];
      await this.songsService.streamSongs((batch) => {
        collected.push(...batch);
        this.songs.set([...collected]);
      });
      this.songs.set(collected);
      this.loaded.set(true);
      void writeCachedSongs(collected);
    } finally {
      this.loading.set(false);
    }
  }

  async requestVocalRangeAnalysis(song: SongManifest, force = false): Promise<SongManifest | null> {
    if ((!force && hasVocalRange(song)) || !hasVocalStem(song)) return song;
    const key = songKey(song);
    const pending = this.vocalRangeRequests.get(key);
    if (pending) return pending;
    const analysis = this.vocalRangeAnalysisQueue.then(() =>
      this.songsService.analyzeSongVocalRange(song, force),
    );
    this.vocalRangeAnalysisQueue = analysis.then(() => undefined, () => undefined);
    const request = analysis
      .then((updated) => {
        if (updated) {
          this.songs.update((songs) =>
            songs.map((existing) => (songKey(existing) === key ? updated : existing)),
          );
          void writeCachedSongs(this.songs());
        }
        return updated;
      })
      .catch((error: unknown) => {
        console.error(`Could not analyze vocal range for "${songTitle(song)}":`, error);
        this.toast.error(`Could not analyze vocal range for "${songTitle(song)}".`);
        throw error;
      })
      .finally(() => this.vocalRangeRequests.delete(key));
    this.vocalRangeRequests.set(key, request);
    return request;
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

    const songIndex = this.songByKey();
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

    const stronglyMatchedCollectionKeys = new Set([
      ...artists.filter(({ score }) => score < 2).map(({ item }) => `artist:${item.artist.key}`),
      ...albums.filter(({ score }) => score < 2).map(({ item }) => `album:${item.album.key}`),
    ]);
    const prioritizedCollections = [
      ...artistHits.filter((hit) => stronglyMatchedCollectionKeys.has(hit.key)).slice(0, 3),
      ...albumHits.filter((hit) => stronglyMatchedCollectionKeys.has(hit.key)).slice(0, 3),
    ];
    const prioritizedCollectionKeys = new Set(prioritizedCollections.map(({ key }) => key));

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
    return [
      ...prioritizedCollections,
      ...[...leading, ...rest].flatMap((group) =>
        group.hits
          .filter((hit) => !prioritizedCollectionKeys.has(hit.key))
          .slice(0, Math.min(group.cap, limit)),
      ),
    ];
  }
}