import { describe, expect, it } from 'vitest';
import { filterImportFiles, matchImportFiles } from '../src/app/features/queue/ui/queue-sheet/import-files.ts';

async function inspectMp4(file) {
  if (file.name === 'broken.mp4') throw new Error('Invalid MP4');
  if (file.name === 'unknown.mp4') return {};
  return file.type === 'video/mp4'
    ? { hasAudio: true, hasVideo: true } : { hasAudio: true, hasVideo: false };
}

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
    const result = matchImportFiles([first, firstLyrics, second, secondLyrics, nested, unrelated, orphan]);
    expect(result.matches).toEqual([
      { audio: first, lyrics: firstLyrics, ambiguous: false },
      { audio: second, lyrics: secondLyrics, ambiguous: false },
      { audio: nested, lyrics: undefined, ambiguous: false },
    ]);
    expect(result.unmatchedLyrics).toEqual([orphan]);
  });

  describe('media filtering', () => {
    it('skips video tracks and retains audio-only MP4s regardless of filename case', async () => {
      const video = file('song.MP4', 'Music/song.MP4', 'video/mp4');
      const audio = file('song.mp4', 'Music/song.mp4', 'audio/mp4');
      const lyrics = file('song.ttml', 'Music/song.ttml');
      const otherAudio = file('other.m4a', 'Music/other.m4a', 'audio/mp4');
      const result = await filterImportFiles([video, audio, lyrics, otherAudio], inspectMp4);
      expect(result.skipped).toEqual([video]);
      expect(result.errors).toEqual([]);
      expect(matchImportFiles(result.files).matches).toEqual([
        { audio, lyrics, ambiguous: false },
        { audio: otherAudio, lyrics: undefined, ambiguous: false },
      ]);
    });

    it('reports files that cannot be inspected and never imports them', async () => {
      const bad = file('broken.mp4');
      const unknown = file('unknown.mp4');
      const mp3 = file('other.mp3');
      const result = await filterImportFiles([bad, mp3, unknown], inspectMp4);
      expect(result.files).toEqual([mp3]);
      expect(result.errors).toEqual([
        { file: bad, message: 'Invalid MP4' },
        { file: unknown, message: 'No audio or video stream found.' },
      ]);
    });

    it('limits concurrent MP4 inspection and preserves selection order', async () => {
      const inputs = Array.from({ length: 8 }, (_, index) => file(`${index}.mp4`));
      let active = 0;
      let peak = 0;
      const result = await filterImportFiles(inputs, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return { hasAudio: true, hasVideo: false };
      });
      expect(peak).toBe(3);
      expect(result.files).toEqual(inputs);
    });

    it('skips non-audio files and video streams while retaining audio and lyric files', async () => {
      const video = file('movie.webm', '', 'video/webm');
      const audio = file('song.webm', '', 'video/webm');
      const image = file('cover.jpg', '', 'image/jpeg');
      const unknown = file('document.txt');
      const ttml = file('song.ttml');
      const lrc = file('song.lrc');
      const result = await filterImportFiles([video, image, unknown, audio, ttml, lrc], async (item) =>
        item === video ? { hasVideo: true, hasAudio: true } : { hasAudio: true },
      );
      expect(result.files).toEqual([audio, ttml, lrc]);
      expect(result.skipped).toEqual([video, image, unknown]);
    });
  });

  it('rejects ambiguous matches without assigning lyrics to the wrong audio', () => {
    const a = file('Song.mp3', 'Music/Song.mp3');
    const b = file('Song.flac', 'Music/Song.flac');
    const lyrics = file('Song.ttml', 'Music/Song.ttml');
    const result = matchImportFiles([a, b, lyrics]);
    expect(result.matches).toEqual([
      { audio: a, lyrics: undefined, ambiguous: true },
      { audio: b, lyrics: undefined, ambiguous: true },
    ]);
    expect(result.unmatchedLyrics).toEqual([]);
  });

  it('filters unknown files and supports audio MIME types for all selections', () => {
    const unusual = file('track.xyz', '', 'audio/example');
    const unknown = file('track.unknown');
    const ttml = file('track.ttml');
    expect(matchImportFiles([unusual]).matches[0].audio).toBe(unusual);
    expect(matchImportFiles([unknown, ttml]).matches).toEqual([]);
    expect(matchImportFiles([unknown, ttml]).unmatchedLyrics).toEqual([ttml]);
  });

  it('prefers TTML to LRC and falls back to LRC when TTML is absent', () => {
    const audio = file('song.mp3', 'Music/song.mp3');
    const lrc = file('song.LRC', 'Music/song.LRC');
    const ttml = file('song.ttml', 'Music/song.ttml');
    expect(matchImportFiles([audio, lrc]).matches).toEqual([
      { audio, lyrics: lrc, ambiguous: false },
    ]);
    const both = matchImportFiles([audio, lrc, ttml]);
    expect(both.matches).toEqual([{ audio, lyrics: ttml, ambiguous: false }]);
    expect(both.unmatchedLyrics).toEqual([]);
    expect(matchImportFiles([ttml, audio, lrc]).matches[0].lyrics).toBe(ttml);
  });

  it('reports duplicate preferred lyrics and duplicate LRC without TTML as ambiguous', () => {
    const audio = file('song.mp3', 'Music/song.mp3');
    const lrc = file('song.lrc', 'Music/song.lrc');
    const duplicateLrc = file('Song.LRC', 'Music/Song.LRC');
    const ttml = file('song.ttml', 'Music/song.ttml');
    const duplicateTtml = file('Song.TTML', 'Music/Song.TTML');
    expect(matchImportFiles([audio, lrc, duplicateLrc]).matches[0].ambiguous).toBe(true);
    expect(matchImportFiles([audio, lrc, duplicateLrc, ttml]).matches[0]).toEqual({
      audio, lyrics: ttml, ambiguous: false,
    });
    expect(matchImportFiles([audio, ttml, duplicateTtml, lrc]).matches[0].ambiguous).toBe(true);
  });

  it('reports duplicate TTML names as ambiguous', () => {
    const audio = file('song.mp3', 'Music/song.mp3');
    const lyrics = file('song.ttml', 'Music/song.ttml');
    const duplicate = file('Song.TTML', 'Music/Song.TTML');
    expect(matchImportFiles([audio, lyrics, duplicate]).matches[0].ambiguous).toBe(true);
  });
});
