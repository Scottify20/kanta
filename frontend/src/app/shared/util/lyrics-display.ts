import { containsNonLatin } from '@braccato/core/text';
import type { Lyric } from '@braccato/parsers';
import type { LyricsDisplayMode } from '../services/lyrics-display.service';

export function lyricRomanization(lyric: Lyric): string | null {
  const text =
    lyric.romanization?.trim() ||
    lyric.timedRomanization?.map((part) => part.words).join('').trim();
  return text?.trim() || null;
}

export function lyricsForDisplay(
  lyrics: Lyric[] | null,
  mode: LyricsDisplayMode,
  translations: (string | null)[] | null = null,
): Lyric[] | null {
  if (!lyrics || mode === 'original') return lyrics;

  return lyrics.map((lyric, index) => {
    const romanization = lyricRomanization(lyric);
    const translation = translations?.[index];
    if (!romanization && !containsNonLatin(lyric.words)) return lyric;
    const text = romanization ?? translation;
    if (!text) return lyric;

    return {
      ...lyric,
      words: text,
      parts: romanization && lyric.timedRomanization?.length
        ? lyric.timedRomanization
        : undefined,
    };
  });
}
