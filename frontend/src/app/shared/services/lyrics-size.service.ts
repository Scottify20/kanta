import { Injectable, signal, WritableSignal } from '@angular/core';

const STORAGE_KEY = 'kanta.lyricsScale';
const MINI_STORAGE_KEY = 'kanta.miniLyrics.scale';

@Injectable({ providedIn: 'root' })
export class LyricsSizeService {
  // Discrete steps keep restyling to a handful of layouts while the slider moves.
  readonly min = 0.7;
  readonly max = 1.5;
  readonly step = 0.1;
  readonly scale = signal(this.load(STORAGE_KEY, 1));
  readonly miniScale = signal(this.load(MINI_STORAGE_KEY, this.scale()));

  set(value: number): void {
    this.setScale(this.scale, STORAGE_KEY, value);
  }

  setMini(value: number): void {
    this.setScale(this.miniScale, MINI_STORAGE_KEY, value);
  }

  private setScale(scale: WritableSignal<number>, key: string, value: number): void {
    if (!Number.isFinite(value)) {
      console.warn('Invalid lyrics size:', value);
      return;
    }
    const clamped = Math.min(this.max, Math.max(this.min, value));
    const next = Math.round((Math.round(clamped / this.step) * this.step) * 100) / 100;
    if (next === scale()) return;
    scale.set(next);
    try {
      localStorage.setItem(key, String(next));
    } catch (error) {
      console.warn('Could not save lyrics size:', error);
    }
  }

  private load(key: string, fallback: number): number {
    try {
      const stored = Number(localStorage.getItem(key));
      if (stored >= this.min && stored <= this.max) return stored;
    } catch {
      // Ignore unavailable storage.
    }
    return fallback;
  }
}
