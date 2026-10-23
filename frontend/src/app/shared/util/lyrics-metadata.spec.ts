import type { Lyric } from '@braccato/parsers';
import { stripLyricMetadata } from './lyrics-metadata';

const line = (startTimeMs: number, words: string): Lyric => ({ startTimeMs, words, durationMs: 1000 });

describe('stripLyricMetadata', () => {
  it('drops the title header and credit lines but keeps the lyrics', () => {
    const result = stripLyricMetadata([
      line(0, 'Shape of You - Ed Sheeran'),
      line(2380, 'Lyrics by：Ed Sheeran/Steve Mac'),
      line(4770, 'Composed by：Ed Sheeran'),
      line(9550, "The club isn't the best place to find a lover"),
      line(11990, 'So the bar is where I go'),
    ]);
    expect(result.map((entry) => entry.words)).toEqual([
      "The club isn't the best place to find a lover",
      'So the bar is where I go',
    ]);
  });

  it('keeps ordinary lyrics untouched', () => {
    const lyrics = [line(1000, 'Hello, is it me you are looking for'), line(5000, 'I can see it in your eyes')];
    expect(stripLyricMetadata(lyrics)).toEqual(lyrics);
  });
});
