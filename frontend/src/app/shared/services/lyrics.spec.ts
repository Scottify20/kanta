import { TestBed } from '@angular/core/testing';
import type { Lyric } from '@braccato/parsers';

import { LyricsService } from './lyrics';

describe('LyricsService', () => {
  let service: LyricsService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(LyricsService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('classifies timed word parts separately from line-only lyrics', () => {
    const classify = (
      service as unknown as {
        classifyParsedLyrics: (lyrics: Lyric[]) => 'word' | 'line' | 'none';
      }
    ).classifyParsedLyrics;

    expect(
      classify([
        { words: 'hello', parts: [{ words: 'hello', durationMs: 400 }] },
      ] as unknown as Lyric[]),
    ).toBe('word');
    expect(classify([{ words: 'hello there', durationMs: 1000 }] as Lyric[])).toBe('line');
  });

  it.each([
    ['Song (Live) (Remastered)', 'Song'],
    ['Song [Deluxe] [2024 Remaster]', 'Song'],
    ['Song (Live [Acoustic]) [Remastered]', 'Song'],
    ['Song (Live', 'Song (Live'],
    ['Song [Live', 'Song [Live'],
  ])('removes balanced parenthesized and bracketed text from %s', (title, expected) => {
    const removeParenthesizedText = (
      service as unknown as {
        removeParenthesizedText: (trackName: string) => string;
      }
    ).removeParenthesizedText;

    expect(removeParenthesizedText(title)).toBe(expected);
  });
});
