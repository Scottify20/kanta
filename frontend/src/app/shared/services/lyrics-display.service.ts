import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { containsNonLatin } from '@braccato/core/text';
import type { Lyric } from '@braccato/parsers';
import { Subscription } from 'rxjs';
import { SettingsService } from './settings.service';
import { lyricRomanization } from '../util/lyrics-display';

export type LyricsDisplayMode = 'original' | 'transliteration';
export type LyricsTranslationStatus =
  | 'idle'
  | 'embedded'
  | 'loading'
  | 'translated'
  | 'disabled'
  | 'rate-limited'
  | 'error';

const STORAGE_KEY = 'kanta.lyricsDisplayMode';
const GOOGLE_TRANSLATE_STORAGE_KEY = 'kanta.googleTranslateEnabled';

@Injectable({ providedIn: 'root' })
export class LyricsDisplayService {
  private readonly settings = inject(SettingsService);
  readonly mode = signal<LyricsDisplayMode>(this.load());
  readonly googleTranslateEnabled = signal(this.loadGoogleTranslateEnabled());
  readonly translatedLines = signal<(string | null)[] | null>(null);
  readonly translationStatus = signal<LyricsTranslationStatus>('idle');
  private currentLyrics: Lyric[] | null = null;
  private currentMode: LyricsDisplayMode = this.mode();
  private currentGoogleSetting: boolean | null = null;
  private translationRequest: Subscription | null = null;

  setMode(mode: LyricsDisplayMode): void {
    if (mode === this.mode()) return;
    this.mode.set(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (error) {
      console.warn('Could not save lyrics display mode:', error);
    }
  }

  setGoogleTranslateEnabled(enabled: boolean): void {
    if (enabled === this.googleTranslateEnabled()) return;
    this.googleTranslateEnabled.set(enabled);
    try {
      localStorage.setItem(GOOGLE_TRANSLATE_STORAGE_KEY, String(enabled));
    } catch (error) {
      console.warn('Could not save Google Translate setting:', error);
    }
    this.prepareLyrics(this.currentLyrics, this.currentMode);
  }

  prepareLyrics(lyrics: Lyric[] | null, mode: LyricsDisplayMode): void {
    const enabled = this.googleTranslateEnabled();
    const lyricsChanged = lyrics !== this.currentLyrics;
    const settingChanged = enabled !== this.currentGoogleSetting;
    if (!lyricsChanged && !settingChanged && mode === this.currentMode) return;
    if (lyricsChanged || settingChanged) {
      this.translationRequest?.unsubscribe();
      this.translationRequest = null;
      this.translatedLines.set(null);
    }
    this.currentLyrics = lyrics;
    this.currentMode = mode;
    this.currentGoogleSetting = enabled;

    if (!lyrics?.length) {
      this.translationStatus.set('idle');
      return;
    }
    if (lyrics.some((line) => lyricRomanization(line))) {
      this.translationStatus.set('embedded');
      return;
    }
    if (mode !== 'transliteration') {
      this.translationStatus.set(this.translatedLines() ? 'translated' : 'idle');
      return;
    }
    if (!enabled) {
      this.translationStatus.set('disabled');
      return;
    }

    const indexedTexts = lyrics
      .map((line, index) => ({ index, text: line.words }))
      .filter(({ text }) => text.trim().length > 0 && containsNonLatin(text));
    if (!indexedTexts.length) {
      this.translationStatus.set('idle');
      return;
    }
    if (this.translatedLines()) {
      this.translationStatus.set('translated');
      return;
    }
    if (this.translationRequest && !this.translationRequest.closed) {
      this.translationStatus.set('loading');
      return;
    }

    this.translationStatus.set('loading');
    this.translationRequest = this.settings.translateLyrics(indexedTexts.map(({ text }) => text)).subscribe({
      next: ({ translations }) => {
        this.translationRequest = null;
        const result: (string | null)[] = Array.from({ length: lyrics.length }, () => null);
        indexedTexts.forEach(({ index }, translationIndex) => {
          result[index] = translations[translationIndex] ?? null;
        });
        this.translatedLines.set(result);
        if (result.some((line) => line?.trim())) {
          this.translationStatus.set('translated');
        } else {
          this.translationStatus.set('error');
        }
      },
      error: (error: unknown) => {
        this.translationRequest = null;
        if (error instanceof HttpErrorResponse && error.status === 429) {
          this.translationStatus.set('rate-limited');
        } else {
          console.error('Could not translate lyrics:', error);
          this.translationStatus.set('error');
        }
      },
    });
  }

  retryTranslation(): void {
    this.translationRequest?.unsubscribe();
    this.translationRequest = null;
    this.translatedLines.set(null);
    this.currentGoogleSetting = null;
    this.prepareLyrics(this.currentLyrics, this.currentMode);
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

  private loadGoogleTranslateEnabled(): boolean {
    try {
      return localStorage.getItem(GOOGLE_TRANSLATE_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  }
}
