import { describe, expect, it } from 'vitest';
import { matchImportFiles } from '../src/app/features/queue/ui/queue-sheet/import-files.ts';

function file(name, path = '', type = '') {
  return { name, webkitRelativePath: path, type };
}

describe('processing folder imports', () => {
  it('finds audio recursively and pairs lyrics only within the same folder', () => {
    const first = file('Song.MP3', 'Music/Album A/Song.MP3');
    const firstLyrics = file('song.ttml', 'Music/Album A/song.ttml');
    const second = file('Song.flac', 'Music/Album B/Song.flac');
    const secondLyrics = file('Song.TTML', 'Music/Album B/Song.TTML');
    const nested = file('Other.wav', 'Music/Album B/Disc 2/Other.wav');
    const unrelated = file('cover.jpg', 'Music/Album A/cover.jpg', 'image/jpeg');
    const orphan = file('Other.ttml', 'Music/Album B/Other.ttml');
    const result = matchImportFiles([first, firstLyrics, second, secondLyrics, nested, unrelated, orphan], true);
    expect(result.matches).toEqual([
      { audio: first, lyrics: firstLyrics, ambiguous: false },
      { audio: second, lyrics: secondLyrics, ambiguous: false },
      { audio: nested, lyrics: undefined, ambiguous: false },
    ]);
    expect(result.unmatchedLyrics).toEqual([orphan]);
  });

  it('rejects ambiguous matches without assigning lyrics to the wrong audio', () => {
    const a = file('Song.mp3', 'Music/Song.mp3');
    const b = file('Song.flac', 'Music/Song.flac');
    const lyrics = file('Song.ttml', 'Music/Song.ttml');
    const result = matchImportFiles([a, b, lyrics], true);
    expect(result.matches).toEqual([
      { audio: a, lyrics: undefined, ambiguous: true },
      { audio: b, lyrics: undefined, ambiguous: true },
    ]);
    expect(result.unmatchedLyrics).toEqual([]);
  });

  it('preserves ordinary file selection behavior and supports audio MIME types', () => {
    const unusual = file('track.xyz', '', 'audio/example');
    const unknown = file('track.unknown');
    const ttml = file('track.ttml');
    expect(matchImportFiles([unusual], true).matches[0].audio).toBe(unusual);
    expect(matchImportFiles([unknown, ttml], false).matches[0]).toEqual({
      audio: unknown, lyrics: ttml, ambiguous: false,
    });
    expect(matchImportFiles([unknown], true).matches).toEqual([]);
  });

  it('reports duplicate TTML names as ambiguous', () => {
    const audio = file('song.mp3', 'Music/song.mp3');
    const lyrics = file('song.ttml', 'Music/song.ttml');
    const duplicate = file('Song.TTML', 'Music/Song.TTML');
    expect(matchImportFiles([audio, lyrics, duplicate], true).matches[0].ambiguous).toBe(true);
  });
});
