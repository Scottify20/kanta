import { AlbumEntry, ArtistEntry, songCover, songKey } from '../../../shared/services/library.service';
import { Playlist } from '../../../shared/services/playlists.service';
import { SongManifest, songAlbum, songArtist, songTitle } from '../../../shared/services/songs.service';

export type LibraryTab = 'songs' | 'albums' | 'artists' | 'playlists';
export type SortMode =
  | 'az'
  | 'za'
  | 'recent'
  | 'artist'
  | 'album'
  | 'year-new'
  | 'year-old'
  | 'longest'
  | 'shortest'
  | 'most-songs';

export const SORT_LABELS: Record<SortMode, string> = {
  az: 'A → Z',
  za: 'Z → A',
  recent: 'Recently added',
  artist: 'Artist',
  album: 'Album',
  'year-new': 'Year (newest)',
  'year-old': 'Year (oldest)',
  longest: 'Longest',
  shortest: 'Shortest',
  'most-songs': 'Most songs',
};

// Sort options offered per content type; karaoke searches lean on artist and year.
export const SORT_MODES: Record<LibraryTab, SortMode[]> = {
  songs: ['az', 'za', 'artist', 'album', 'year-new', 'year-old', 'recent', 'shortest', 'longest'],
  albums: ['az', 'za', 'artist', 'year-new', 'year-old', 'recent', 'most-songs'],
  artists: ['az', 'za', 'most-songs', 'recent'],
  playlists: ['az', 'za', 'most-songs', 'longest', 'shortest'],
};

export interface LibraryEntry {
  key: string;
  kind: 'song' | 'album' | 'artist' | 'playlist';
  title: string;
  subtitle: string;
  covers: string[];
  songs: SongManifest[];
  playlistId?: string;
  added: number;
  artist: string;
  album: string;
  year: number;
  duration: number;
  count: number;
}

const yearOf = (song: SongManifest): number => parseInt(String(song.year ?? ''), 10) || 0;
const stats = (songs: SongManifest[]) => ({
  year: songs.reduce((max, song) => Math.max(max, yearOf(song)), 0),
  duration: songs.reduce((sum, song) => sum + Number(song.duration_seconds ?? 0), 0),
  count: songs.length,
});

const newest = (songs: SongManifest[]): number =>
  songs.reduce((max, song) => Math.max(max, Number(song.date_added ?? 0)), 0);

export const songEntry = (song: SongManifest): LibraryEntry => ({
  key: `song:${songKey(song)}`,
  kind: 'song',
  title: songTitle(song),
  subtitle: `${songArtist(song)} • ${songAlbum(song)}`,
  covers: [songCover(song)].filter((c): c is string => !!c),
  songs: [song],
  added: Number(song.date_added ?? 0),
  artist: songArtist(song),
  album: songAlbum(song),
  ...stats([song]),
});

export const albumEntry = (album: AlbumEntry): LibraryEntry => ({
  key: `album:${album.key}`,
  kind: 'album',
  title: album.displayAlbum,
  subtitle: album.displayArtist,
  covers: album.coverUrl ? [album.coverUrl] : [],
  songs: album.songs,
  added: newest(album.songs),
  artist: album.displayArtist,
  album: album.displayAlbum,
  ...stats(album.songs),
});

export const artistEntry = (artist: ArtistEntry): LibraryEntry => ({
  key: `artist:${artist.key}`,
  kind: 'artist',
  title: artist.displayArtist,
  subtitle: `${artist.songs.length} ${artist.songs.length === 1 ? 'song' : 'songs'}`,
  covers: artist.coverUrl ? [artist.coverUrl] : [],
  songs: artist.songs,
  added: newest(artist.songs),
  artist: artist.displayArtist,
  album: '',
  ...stats(artist.songs),
});

export function playlistEntry(playlist: Playlist, all: Map<string, SongManifest>): LibraryEntry {
  const songs = playlist.songs
    .map((ref) => all.get(songKey(ref)))
    .filter((song): song is SongManifest => !!song);
  return {
    key: `playlist:${playlist.id}`,
    kind: 'playlist',
    title: playlist.name,
    subtitle: `${playlist.song_count} ${playlist.song_count === 1 ? 'song' : 'songs'}`,
    covers: playlist.cover_urls,
    songs,
    playlistId: playlist.id,
    added: 0,
    artist: '',
    album: '',
    ...stats(songs),
  };
}

export function sortEntries(entries: LibraryEntry[], mode: SortMode): LibraryEntry[] {
  const text = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const byTitle = (a: LibraryEntry, b: LibraryEntry): number => text(a.title, b.title);
  // Entries without a value (e.g. no year tag) always sink to the end.
  const byNumber = (pick: (e: LibraryEntry) => number, desc: boolean) =>
    (a: LibraryEntry, b: LibraryEntry): number => {
      const [x, y] = [pick(a), pick(b)];
      if (!x !== !y) return x ? -1 : 1;
      return (desc ? y - x : x - y) || byTitle(a, b);
    };
  const compare: Record<SortMode, (a: LibraryEntry, b: LibraryEntry) => number> = {
    az: byTitle,
    za: (a, b) => byTitle(b, a),
    recent: byNumber((e) => e.added, true),
    artist: (a, b) => text(a.artist, b.artist) || text(a.album, b.album) || byTitle(a, b),
    album: (a, b) => text(a.album, b.album) || byTitle(a, b),
    'year-new': byNumber((e) => e.year, true),
    'year-old': byNumber((e) => e.year, false),
    longest: byNumber((e) => e.duration, true),
    shortest: byNumber((e) => e.duration, false),
    'most-songs': byNumber((e) => e.count, true),
  };
  return [...entries].sort(compare[mode]);
}

export const formatRuntime = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
};
