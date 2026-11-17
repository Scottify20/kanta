import { describe, expect, it } from 'vitest';
import { lyricsForDisplay } from '../src/app/shared/util/lyrics-display.ts';

describe('lyrics display', () => {
  it('uses timed transliteration as the main line and leaves untranslated lines intact', () => {
    const parts = [{ startTimeMs: 0, durationMs: 500, words: 'annyeong' }];
    const originalParts = [{ startTimeMs: 0, durationMs: 500, words: '안녕' }];
    const lyrics = [
      {
        startTimeMs: 0,
        durationMs: 500,
        words: '안녕',
        parts: originalParts,
        romanization: 'annyeong',
        timedRomanization: parts,
      },
      { startTimeMs: 500, durationMs: 500, words: 'hello' },
    ];

    const displayed = lyricsForDisplay(lyrics, 'transliteration');

    expect(displayed[0]).toMatchObject({ words: 'annyeong', parts });
    expect(displayed[0].parts).not.toBe(originalParts);
    expect(displayed[1]).toBe(lyrics[1]);
  });

  it('falls back to line timing when transliteration has no timed parts', () => {
    const lyrics = [{
      startTimeMs: 0,
      durationMs: 500,
      words: '안녕',
      parts: [{ startTimeMs: 0, durationMs: 500, words: '안녕' }],
      romanization: 'annyeong',
    }];

    expect(lyricsForDisplay(lyrics, 'transliteration')[0]).toMatchObject({
      words: 'annyeong',
      parts: undefined,
    });
  });

  it('uses timed transliteration text when the line text is absent', () => {
    const lyrics = [{
      startTimeMs: 0,
      durationMs: 500,
      words: '안녕',
      romanization: '',
      timedRomanization: [{ startTimeMs: 0, durationMs: 500, words: 'annyeong' }],
    }];

    expect(lyricsForDisplay(lyrics, 'transliteration')[0]).toMatchObject({
      words: 'annyeong',
      parts: lyrics[0].timedRomanization,
    });
  });

  it('uses a romanization fallback without replacing it with an English translation', () => {
    const lyrics = [{ startTimeMs: 0, durationMs: 500, words: '안녕' }];

    const displayed = lyricsForDisplay(lyrics, 'transliteration', ['annyeong']);

    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({ words: 'annyeong', parts: undefined });
  });

  it('leaves the original line intact when no romanization is available', () => {
    const lyrics = [{ startTimeMs: 0, durationMs: 500, words: '안녕' }];

    expect(lyricsForDisplay(lyrics, 'transliteration', [null])[0]).toBe(lyrics[0]);
  });

  it('keeps already-English lines and their word timing', () => {
    const parts = [{ startTimeMs: 0, durationMs: 500, words: 'Hello' }];
    const lyrics = [{ startTimeMs: 0, durationMs: 500, words: 'Hello', parts }];

    const displayed = lyricsForDisplay(lyrics, 'transliteration', ['Hello']);

    expect(displayed[0]).toBe(lyrics[0]);
    expect(displayed[0].parts).toBe(parts);
  });
});
