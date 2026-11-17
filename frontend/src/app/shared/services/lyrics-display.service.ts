import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { containsNonLatin } from '@braccato/core/text';
import type { Lyric } from '@braccato/parsers';
import { Subscription } from 'rxjs';
import { SettingsService } from './settings.service';
import { lyricRomanization } from '../util/lyrics-display';

export type LyricsDisplayMode = 'original' | 'transliteration';
export type LyricsTransliterationStatus =
  | 'idle'
  | 'embedded'
  | 'loading'
  | 'transliterated'
  | 'disabled'
  | 'rate-limited'
  | 'error';

const STORAGE_KEY = 'kanta.lyricsDisplayMode';
const GOOGLE_TRANSLITERATION_STORAGE_KEY = 'kanta.googleTranslateEnabled';

@Injectable({ providedIn: 'root' })
export class LyricsDisplayService {
  private readonly settings = inject(SettingsService);
  readonly mode = signal<LyricsDisplayMode>(this.load());
  readonly googleTransliterationEnabled = signal(this.loadGoogleTransliterationEnabled());
  readonly transliteratedLines = signal<(string | null)[] | null>(null);
  readonly transliterationStatus = signal<LyricsTransliterationStatus>('idle');
  private currentLyrics: Lyric[] | null = null;
  private currentMode: LyricsDisplayMode = this.mode();
  private currentTransliterationSetting: boolean | null = null;
  private transliterationRequest: Subscription | null = null;

  setMode(mode: LyricsDisplayMode): void {
    if (mode === this.mode()) return;
    this.mode.set(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (error) {
      console.warn('Could not save lyrics display mode:', error);
    }
  }

  setGoogleTransliterationEnabled(enabled: boolean): void {
    if (enabled === this.googleTransliterationEnabled()) return;
    this.googleTransliterationEnabled.set(enabled);
    try {
      localStorage.setItem(GOOGLE_TRANSLITERATION_STORAGE_KEY, String(enabled));
    } catch (error) {
      console.warn('Could not save Google transliteration setting:', error);
    }
    this.prepareLyrics(this.currentLyrics, this.currentMode);
  }

  prepareLyrics(lyrics: Lyric[] | null, mode: LyricsDisplayMode): void {
    const enabled = this.googleTransliterationEnabled();
    const lyricsChanged = lyrics !== this.currentLyrics;
    const settingChanged = enabled !== this.currentTransliterationSetting;
    if (!lyricsChanged && !settingChanged && mode === this.currentMode) return;
    if (lyricsChanged || settingChanged) {
      this.transliterationRequest?.unsubscribe();
      this.transliterationRequest = null;
      this.transliteratedLines.set(null);
    }
    this.currentLyrics = lyrics;
    this.currentMode = mode;
    this.currentTransliterationSetting = enabled;

    if (!lyrics?.length) {
      this.transliterationStatus.set('idle');
      return;
    }
    const hasEmbedded = lyrics.some((line) => !!lyricRomanization(line));
    if (mode !== 'transliteration') {
      this.transliterationStatus.set(this.transliteratedLines() ? 'transliterated' : hasEmbedded ? 'embedded' : 'idle');
      return;
    }

    const indexedTexts = lyrics
      .map((line, index) => ({ index, text: line.words, hasRomanization: !!lyricRomanization(line) }))
      .filter(({ text, hasRomanization }) => !hasRomanization && text.trim().length > 0 && containsNonLatin(text));
    if (!indexedTexts.length) {
      this.transliterationStatus.set(hasEmbedded ? 'embedded' : 'idle');
      return;
    }
    if (!enabled) {
      this.transliterationStatus.set('disabled');
      return;
    }
    if (this.transliteratedLines()) {
      this.transliterationStatus.set('transliterated');
      return;
    }
    if (this.transliterationRequest && !this.transliterationRequest.closed) {
      this.transliterationStatus.set('loading');
      return;
    }

    this.transliterationStatus.set('loading');
    this.transliterationRequest = this.settings.transliterateLyrics(indexedTexts.map(({ text }) => text)).subscribe({
      next: ({ transliterations }) => {
        this.transliterationRequest = null;
        const result: (string | null)[] = Array.from({ length: lyrics.length }, () => null);
        indexedTexts.forEach(({ index }, transliterationIndex) => {
          result[index] = transliterations[transliterationIndex] ?? null;
        });
        this.transliteratedLines.set(result);
        if (result.some((line) => line?.trim())) {
          this.transliterationStatus.set('transliterated');
        } else {
          this.transliterationStatus.set(hasEmbedded ? 'embedded' : 'error');
        }
      },
      error: (error: unknown) => {
        this.transliterationRequest = null;
        if (error instanceof HttpErrorResponse && error.status === 429) {
          this.transliterationStatus.set('rate-limited');
        } else {
          console.error('Could not transliterate lyrics:', error);
          this.transliterationStatus.set('error');
        }
      },
    });
  }

  private load(): LyricsDisplayMode {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'transliteration'
        ? 'transliteration'
        : localStorage.getItem(STORAGE_KEY) === 'original'
          ? 'original'
          : 'transliteration';
    } catch {
      return 'transliteration';
    }
  }

  private loadGoogleTransliterationEnabled(): boolean {
    try {
      return localStorage.getItem(GOOGLE_TRANSLITERATION_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  }
}
