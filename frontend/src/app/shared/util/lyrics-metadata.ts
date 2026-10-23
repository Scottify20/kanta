import type { Lyric } from '@braccato/parsers';

// Credit lines such as "Lyrics by: …" or "作词 : …" that providers prepend to the lyric body.
const CREDIT_LINE =
  /^\s*(?:lyrics?|lyricist|words?|composed?|composer|written|music|produced|producer|arranged|arranger|mixed|mixing|mastered|mastering|engineer(?:ed)?|vocals?|publisher|label|isrc|作词|作曲|编曲|制作人?|混音|母带|演唱|歌手|词|曲)(?:\s+(?:by|&|and|\/)\s*\w*)*\s*[:：]/i;
const TITLE_ARTIST_LINE = /^.{1,120}\s[-–—]\s.{1,120}$/;
const CREDIT_WINDOW_START = 12;
const CREDIT_WINDOW_END = 6;

export function stripLyricMetadata(lyrics: Lyric[]): Lyric[] {
  const lastIndex = lyrics.length - 1;
  const filtered = lyrics.filter((line, index) => {
    const nearEdge = index < CREDIT_WINDOW_START || lastIndex - index < CREDIT_WINDOW_END;
    return !(nearEdge && !line.parts?.length && CREDIT_LINE.test(line.words));
  });
  // A leading "Title - Artist" header is only dropped when it sits before the first real lyric.
  const first = filtered[0];
  if (first && !first.parts?.length && first.startTimeMs < 3000 && filtered.length > 1 && TITLE_ARTIST_LINE.test(first.words.trim())) {
    return filtered.slice(1);
  }
  return filtered;
}
