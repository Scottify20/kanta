import { Injectable, computed, signal } from '@angular/core';
import { getPaletteSync } from 'colorthief';

export type LyricsColorMode = 'white' | 'automatic' | 'custom';
export type LyricsPalette = readonly [string, string];
export type LyricsOpacities = readonly [number, number, number];
export interface AlbumLyricsColors {
  colors: LyricsPalette;
  inactiveColors: LyricsPalette;
  inactiveOpacities: LyricsOpacities;
  useCustomColors: boolean;
}

const STORAGE_KEY = 'kanta.lyricsColors';
const WHITE: LyricsPalette = ['#f8f8f8', '#f8f8f8'];
const DEFAULT_CUSTOM: LyricsPalette = ['#ff89a8', '#83baff'];
const MIN_DUET_COLOR_DISTANCE = 0.075;
interface LyricsColorSettings {
  mode: LyricsColorMode;
  custom: LyricsPalette;
}

function luminance(rgb: number[]): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function paletteFromCanvas(canvas: HTMLCanvasElement, isDuet = false): AlbumLyricsColors {
  const backgrounds = albumBackgroundSamples(canvas);
  const palette = getPaletteSync(canvas, {
    colorCount: 16,
    quality: 1,
    colorSpace: 'oklch',
    ignoreWhite: true,
    minSaturation: 0.1,
  });
  const candidates = (palette ?? []).filter((color) => color.oklch().c >= 0.025)
    .sort((a, b) => b.population * b.oklch().c - a.population * a.oklch().c);
  const first = candidates[0];
  let useCustomColors: boolean = isDuet && !first;
  let colors: LyricsPalette = WHITE;
  let inactiveColors: LyricsPalette = WHITE;
  let inactiveOpacities: LyricsOpacities = [
    inactiveOpacity(WHITE[0], backgrounds),
    inactiveOpacity(WHITE[1], backgrounds),
    inactiveOpacity(WHITE[0], backgrounds),
  ];
  if (first) {
    const alternatives = candidates.filter((color) => {
      const distance = Math.abs(color.oklch().h - first.oklch().h);
      return Math.min(distance, 360 - distance) >= 35 && color.population >= first.population * 0.1;
    });
    const target = albumTargetLuminance(backgrounds);
    const primary = first.hex();
    const secondaries = alternatives.length ? alternatives.map((color) => color.hex()) : [primary];
    for (const secondary of secondaries) {
      inactiveColors = [tuneAlbumColor(primary, target), tuneAlbumColor(secondary, target)];
      inactiveOpacities = [
        inactiveOpacity(inactiveColors[0], backgrounds),
        inactiveOpacity(inactiveColors[1], backgrounds),
        inactiveOpacity(mixLyricsColors(...inactiveColors), backgrounds),
      ];
      colors = brightenActiveColors(primary, secondary, target, inactiveColors, inactiveOpacities, backgrounds);
      if (!isDuet || colorDistance(...colors) >= MIN_DUET_COLOR_DISTANCE) break;
    }
    if (isDuet) useCustomColors = colorDistance(...colors) < MIN_DUET_COLOR_DISTANCE;
  }
  return { colors, inactiveColors, inactiveOpacities, useCustomColors };
}

function rgbToHex(rgb: number[]): string {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

function colorDistance(first: string, second: string): number {
  const oklab = (hex: string): number[] => {
    const [r, g, b] = [1, 3, 5].map((index) => {
      const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const a = oklab(first);
  const b = oklab(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function albumBackgroundSamples(canvas: HTMLCanvasElement): number[][] {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const regions: number[][] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sums = [0, 0, 0];
      let count = 0;
      for (let py = Math.floor(y * height / 8); py < Math.floor((y + 1) * height / 8); py++) {
        for (let px = Math.floor(x * width / 8); px < Math.floor((x + 1) * width / 8); px++) {
          const index = (py * width + px) * 4;
          const alpha = data[index + 3] / 255;
          for (let c = 0; c < 3; c++) sums[c] += data[index + c] * alpha + [42, 48, 51][c] * (1 - alpha);
          count++;
        }
      }
      if (!count) continue;
      // Approximate the backdrop's brightness, saturation and scrim over bright regions.
      const rgb = sums.map((channel) => channel / count * 0.65);
      const gray = 0.213 * rgb[0] + 0.715 * rgb[1] + 0.072 * rgb[2];
      const background = rgb.map((channel, i) => (gray * 0.15 + channel * 0.85) * 0.55 + [20, 24, 27][i] * 0.45);
      regions.push(background);
    }
  }
  return regions;
}

function albumTargetLuminance(backgrounds: number[][]): number {
  const regions = backgrounds.map(luminance).sort((a, b) => a - b);
  const brightRegion = regions[Math.floor((regions.length - 1) * 0.9)] ?? 0;
  return Math.min(0.75, Math.max(0.42, 5 * (brightRegion + 0.05) - 0.05));
}

function inactiveOpacity(hex: string, backgrounds: number[][]): number {
  const color = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const samples = backgrounds.length ? backgrounds : [[30, 34, 36]];
  const activeLuminance = luminance(color);
  const contrastAt = (opacity: number, againstActive: boolean): number => {
    const ratios = samples.map((background) => {
      const blended = color.map((channel, index) => channel * opacity + background[index] * (1 - opacity));
      const foreground = luminance(blended);
      return againstActive
        ? (activeLuminance + 0.05) / (foreground + 0.05)
        : (foreground + 0.05) / (luminance(background) + 0.05);
    }).sort((a, b) => a - b);
    return ratios[Math.floor((ratios.length - 1) * 0.1)];
  };
  // Balance large-text readability against a visible active/inactive difference.
  let low = 0.35;
  let high = 0.5;
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) / 2;
    if (contrastAt(middle, false) < 3) low = middle;
    else high = middle;
  }
  const readableOpacity = high;
  low = 0.35;
  high = 0.5;
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) / 2;
    if (contrastAt(middle, true) >= 1.8) low = middle;
    else high = middle;
  }
  return Math.round(Math.min(readableOpacity, low) * 1000) / 1000;
}

function brightenActiveColors(
  primary: string,
  secondary: string,
  target: number,
  inactiveColors: LyricsPalette,
  opacities: LyricsOpacities,
  backgrounds: number[][],
): LyricsPalette {
  const samples = backgrounds.length ? backgrounds : [[30, 34, 36]];
  const inactive = [...inactiveColors, mixLyricsColors(...inactiveColors)]
    .map((hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)));
  const paletteAt = (value: number): LyricsPalette =>
    [tuneAlbumColor(primary, value), tuneAlbumColor(secondary, value)];
  const enoughContrast = (palette: LyricsPalette): boolean => {
    const active = [...palette, mixLyricsColors(...palette)]
      .map((hex) => luminance([1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16))));
    return active.every((lightness, index) => {
      const ratios = samples.map((background) => {
        const blended = inactive[index].map(
          (channel, i) => channel * opacities[index] + background[i] * (1 - opacities[index]),
        );
        return (lightness + 0.05) / (luminance(blended) + 0.05);
      }).sort((a, b) => a - b);
      return ratios[Math.floor((ratios.length - 1) * 0.1)] >= 2.6;
    });
  };
  let low = target;
  let high = 0.98;
  if (!enoughContrast(paletteAt(high))) return paletteAt(high);
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) / 2;
    if (enoughContrast(paletteAt(middle))) high = middle;
    else low = middle;
  }
  return paletteAt(high);
}

export function tuneAlbumColor(hex: string, target: number): string {
  const rgb = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const chroma = max - min;
  if (!chroma) return hex;
  const saturation = chroma / (1 - Math.abs(max + min - 1));
  const tunedSaturation = Math.max(0.55, Math.min(0.85, saturation * 1.15));
  const hueChannels = rgb.map((channel) => (channel - min) / chroma);
  const atLightness = (lightness: number): number[] => {
    const tunedChroma = (1 - Math.abs(2 * lightness - 1)) * tunedSaturation;
    return hueChannels.map((channel) => (lightness + (channel - 0.5) * tunedChroma) * 255);
  };
  let low = 0;
  let high = 1;
  for (let i = 0; i < 16; i++) {
    const middle = (low + high) / 2;
    if (luminance(atLightness(middle)) < target) low = middle;
    else high = middle;
  }
  return rgbToHex(atLightness((low + high) / 2));
}

export function mixLyricsColors(first: string, second: string): string {
  const channels = [1, 3, 5].map((index) =>
    (parseInt(first.slice(index, index + 2), 16) + parseInt(second.slice(index, index + 2), 16)) / 2,
  );
  return rgbToHex(channels);
}

@Injectable({ providedIn: 'root' })
export class LyricsColorService {
  private readonly stored = this.load();
  readonly mode = signal<LyricsColorMode>(this.stored.mode);
  readonly custom = signal<LyricsPalette>(this.stored.custom);
  readonly automatic = signal<LyricsPalette>(WHITE);
  readonly automaticUsesCustom = signal(false);
  readonly automaticInactiveColors = signal<LyricsPalette>(WHITE);
  readonly automaticInactiveCombined = computed(() => mixLyricsColors(...this.automaticInactiveColors()));
  readonly automaticInactiveOpacities = signal<LyricsOpacities>([0.4, 0.4, 0.4]);
  readonly colors = computed<LyricsPalette>(() => {
    if (this.mode() === 'white') return WHITE;
    if (this.mode() === 'automatic') return this.automaticUsesCustom() ? this.custom() : this.automatic();
    return this.custom();
  });
  readonly combined = computed(() => mixLyricsColors(...this.colors()));

  setMode(mode: LyricsColorMode): void {
    this.mode.set(mode);
    this.save();
  }

  setCustom(index: 0 | 1, value: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    const colors: [string, string] = [...this.custom()];
    colors[index] = value;
    this.custom.set(colors);
    this.save();
  }

  private load(): LyricsColorSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (typeof value === 'object' && value !== null && 'mode' in value && 'custom' in value &&
            (value.mode === 'white' || value.mode === 'automatic' || value.mode === 'custom') &&
            Array.isArray(value.custom) && value.custom.length === 2 &&
            value.custom.every((color: unknown) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) {
          return { mode: value.mode, custom: [value.custom[0], value.custom[1]] };
        }
        console.warn('Invalid saved lyric colors; using defaults.');
      }
    } catch (error) {
      console.warn('Could not load lyric colors:', error);
    }
    return { mode: 'white', custom: DEFAULT_CUSTOM };
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 3, mode: this.mode(), custom: this.custom(),
      }));
    } catch (error) {
      console.warn('Could not save lyric colors:', error);
    }
  }
}
