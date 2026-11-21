import type { UserProfile } from './party-session.service';
import type { SongManifest } from './songs.service';

export type SoloFitStatus = 'natural' | 'adjusted' | 'reach' | 'unanalyzed' | 'uncalibrated';

export interface SoloKeyRecommendation {
  kind: 'solo';
  semitones: number;
  status: SoloFitStatus;
  unanalyzed: boolean;
  hitsPhysicalLimit: boolean;
}

export type SongVocalRange = Pick<SongManifest, 'is_duet' | 'vocal_min_hz' | 'vocal_max_hz'>;

export function clampKeyShift(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  const rounded = Math.round(semitones);
  return rounded === 0 ? 0 : Math.max(-6, Math.min(6, rounded));
}

export function recommendSoloKey(
  song: SongVocalRange,
  singer: UserProfile,
): SoloKeyRecommendation {
  const songMaxHz = song.vocal_max_hz;
  if (songMaxHz == null || !Number.isFinite(songMaxHz) || songMaxHz <= 0) {
    return { kind: 'solo', semitones: 0, status: 'unanalyzed', unanalyzed: true, hitsPhysicalLimit: false };
  }
  if (singer.tessituraMaxHz == null || singer.tessituraMaxHz <= 0) {
    return { kind: 'solo', semitones: 0, status: 'uncalibrated', unanalyzed: false, hitsPhysicalLimit: false };
  }

  const rawShift = Math.round(12 * Math.log2(singer.tessituraMaxHz / songMaxHz));
  const semitones = clampKeyShift(rawShift);
  const shiftedMaxHz = songMaxHz * 2 ** (semitones / 12);
  const hitsPhysicalLimit = singer.maxHz != null && shiftedMaxHz > singer.maxHz;
  const status: SoloFitStatus = Math.abs(rawShift) > 3 || hitsPhysicalLimit
    ? 'reach'
    : semitones === 0
      ? 'natural'
      : 'adjusted';

  return { kind: 'solo', semitones, status, unanalyzed: false, hitsPhysicalLimit };
}

export function singerHitsLimit(
  song: SongVocalRange,
  singer: UserProfile,
  semitones: number,
): boolean {
  const ratio = 2 ** (semitones / 12);
  const shiftedMax = song.vocal_max_hz == null ? null : song.vocal_max_hz * ratio;
  const shiftedMin = song.vocal_min_hz == null ? null : song.vocal_min_hz * ratio;
  return (shiftedMax != null && singer.maxHz != null && shiftedMax > singer.maxHz)
    || (shiftedMin != null && singer.minHz != null && shiftedMin < singer.minHz);
}
