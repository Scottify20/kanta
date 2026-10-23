import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'kanta.lyricsScale';

@Injectable({ providedIn: 'root' })
export class LyricsSizeService {
  // Discrete steps keep restyling to a handful of layouts while the slider moves.
  readonly min = 0.7;
  readonly max = 1.5;
  readonly step = 0.1;
  readonly scale = signal(this.load());

  set(value: number): void {
    const clamped = Math.min(this.max, Math.max(this.min, value));
    const next = Math.round((Math.round(clamped / this.step) * this.step) * 100) / 100;
    if (next === this.scale()) return;
    this.scale.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Storage unavailable; the size just won't persist.
    }
  }

  private load(): number {
    try {
      const stored = Number(localStorage.getItem(STORAGE_KEY));
      if (stored >= this.min && stored <= this.max) return stored;
    } catch {
      // Ignore unavailable storage.
    }
    return 1;
  }
}
