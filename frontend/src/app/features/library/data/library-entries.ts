import { AlbumEntry, ArtistEntry, songCover, songKey } from '../../../shared/services/library.service';
import { Playlist } from '../../../shared/services/playlists.service';
import { SongManifest, songAlbum, songArtist, songTitle } from '../../../shared/services/songs.service';

export type LibraryTab = 'songs' | 'albums' | 'artists' | 'playlists';
export type SortMode = 'az' | 'za' | 'recent';

export interface LibraryEntry {
  key: string;
  kind: 'song' | 'album' | 'artist' | 'playlist';
  title: string;
  subtitle: string;
  covers: string[];
  songs: SongManifest[];
  playlistId?: string;
  added: number;
}

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
});

export const albumEntry = (album: AlbumEntry): LibraryEntry => ({
  key: `album:${album.key}`,
  kind: 'album',
  title: album.displayAlbum,
  subtitle: album.displayArtist,
  covers: album.coverUrl ? [album.coverUrl] : [],
  songs: album.songs,
  added: newest(album.songs),
});

export const artistEntry = (artist: ArtistEntry): LibraryEntry => ({
  key: `artist:${artist.key}`,
  kind: 'artist',
  title: artist.displayArtist,
  subtitle: `${artist.songs.length} ${artist.songs.length === 1 ? 'song' : 'songs'}`,
  covers: artist.coverUrl ? [artist.coverUrl] : [],
  songs: artist.songs,
  added: newest(artist.songs),
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
  };
}

export function sortEntries(entries: LibraryEntry[], mode: SortMode): LibraryEntry[] {
  const sorted = [...entries];
  const byTitle = (a: LibraryEntry, b: LibraryEntry): number =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
  if (mode === 'recent') return sorted.sort((a, b) => b.added - a.added || byTitle(a, b));
  return sorted.sort((a, b) => (mode === 'az' ? byTitle(a, b) : byTitle(b, a)));
}

export const formatRuntime = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
};
