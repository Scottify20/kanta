import { clampKeyShift, recommendSoloKey, singerHitsLimit } from './vocal-fit';
import type { SongVocalRange } from './vocal-fit';
import type {
  DuetKeyRecommendation,
  ProfileVoiceType,
  UserProfile,
  VocalProfilePreset,
  VoiceType,
} from './party-session.models';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
export const midiToNote = (midi: number): string => {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
};

export const noteToMidi = (noteStr: string): number | null => {
  const match = /^([A-G](?:#|b)?)(-?\d+)$/i.exec(noteStr.trim());
  if (!match) return null;
  const name = match[1].toUpperCase();
  const octave = parseInt(match[2], 10);
  const noteIndex = NOTE_NAMES.indexOf(name as (typeof NOTE_NAMES)[number]);
  if (noteIndex < 0) return null;
  return (octave + 1) * 12 + noteIndex;
};

// Standard Classical & Contemporary Singing Reference Anchors
export const VOICE_REFERENCE: Record<
  VoiceType,
  {
    lowCenter: number;  // Expected lowest comfortable note (MIDI)
    highCenter: number; // Expected highest comfortable modal note (MIDI)
    midpoint: number;   // Characteristic center of tessitura (MIDI)
    minBound: number;
    maxBound: number;
    accentColor: string;
  }
> = {
  Bass: { lowCenter: 40, highCenter: 64, midpoint: 52, minBound: 36, maxBound: 65, accentColor: '#4f7cac' },         // E2–E4 (center E3)
  Baritone: { lowCenter: 45, highCenter: 68, midpoint: 56.5, minBound: 41, maxBound: 70, accentColor: '#4a8f8c' },   // A2–G#4 (center F3/G3)
  Tenor: { lowCenter: 48, highCenter: 72, midpoint: 60, minBound: 46, maxBound: 74, accentColor: '#597a55' },      // C3–C5 (center C4)
  Alto: { lowCenter: 53, highCenter: 76, midpoint: 64.5, minBound: 50, maxBound: 77, accentColor: '#9b6aa0' },       // F3–E5 (center F4)
  'Mezzo-Soprano': { lowCenter: 57, highCenter: 80, midpoint: 68.5, minBound: 53, maxBound: 81, accentColor: '#c0784b' }, // A3–G#5 (center A4)
  Soprano: { lowCenter: 60, highCenter: 84, midpoint: 72, minBound: 57, maxBound: 88, accentColor: '#b85c73' },     // C4–C6 (center C5)
};

/**
 * Musically accurate vocal classification considering range boundaries and tessitura center.
 */
export function classifyVocalRange(lowMidi: number, highMidi: number): ProfileVoiceType {
  if (!Number.isFinite(lowMidi) || !Number.isFinite(highMidi) || lowMidi >= highMidi) {
    return 'Uncalibrated';
  }

  const userCenter = (lowMidi + highMidi) / 2;

  // Direct boundary gates based on singing pedagogy
  if (lowMidi <= 43 && highMidi <= 65) return 'Bass';
  if (lowMidi <= 46 && highMidi <= 69) return 'Baritone';
  if (lowMidi >= 48 && lowMidi <= 53 && highMidi >= 67 && highMidi <= 75) return 'Tenor';
  if (lowMidi <= 54 && highMidi >= 70 && highMidi <= 77) return 'Alto';
  if (highMidi >= 81 && lowMidi >= 57) return 'Soprano';

  // Distance scoring against reference vocal types
  let bestMatch: VoiceType = 'Baritone';
  let minPenalty = Number.POSITIVE_INFINITY;

  for (const [vType, ref] of Object.entries(VOICE_REFERENCE) as [VoiceType, (typeof VOICE_REFERENCE)[VoiceType]][]) {
    const lowDiff = Math.abs(lowMidi - ref.lowCenter);
    const highDiff = Math.abs(highMidi - ref.highCenter);
    const centerDiff = Math.abs(userCenter - ref.midpoint);

    // Weighted distance score: center and low-floor have the highest weight in voice classification
    const penalty = lowDiff * 1.5 + highDiff * 1.2 + centerDiff * 1.8;

    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMatch = vType;
    }
  }

  return bestMatch;
}

export const VOCAL_PROFILE_PRESETS: readonly VocalProfilePreset[] = (
  Object.keys(VOICE_REFERENCE) as VoiceType[]
).map((voiceType) => {
  const ref = VOICE_REFERENCE[voiceType];
  const tessMin = ref.lowCenter + Math.round((ref.highCenter - ref.lowCenter) * 0.175);
  const tessMax = ref.highCenter - Math.round((ref.highCenter - ref.lowCenter) * 0.175);
  return {
    voiceType,
    minHz: midiToHz(ref.lowCenter),
    maxHz: midiToHz(ref.highCenter),
    minNote: midiToNote(ref.lowCenter),
    maxNote: midiToNote(ref.highCenter),
    tessituraMinHz: midiToHz(tessMin),
    tessituraMaxHz: midiToHz(tessMax),
    tessituraMinNote: midiToNote(tessMin),
    tessituraMaxNote: midiToNote(tessMax),
    accentColor: ref.accentColor,
  };
});

export const UNCALIBRATED_PROFILE_PRESET: VocalProfilePreset = {
  voiceType: 'Uncalibrated',
  minHz: null,
  maxHz: null,
  minNote: null,
  maxNote: null,
  tessituraMinHz: null,
  tessituraMaxHz: null,
  tessituraMinNote: null,
  tessituraMaxNote: null,
  accentColor: '#607274',
};

export function createProfileFromPreset(
  voiceType: ProfileVoiceType,
  name: string,
  id = createProfileId(),
): UserProfile {
  const preset = voiceType === 'Uncalibrated'
    ? UNCALIBRATED_PROFILE_PRESET
    : VOCAL_PROFILE_PRESETS.find((item) => item.voiceType === voiceType) ?? UNCALIBRATED_PROFILE_PRESET;

  return {
    id,
    name: name.trim() || 'Singer',
    avatar: null,
    initials: getInitials(name),
    accentColor: preset.accentColor,
    voiceType: preset.voiceType,
    minHz: preset.minHz,
    maxHz: preset.maxHz,
    minNote: preset.minNote,
    maxNote: preset.maxNote,
    tessituraMinHz: preset.tessituraMinHz,
    tessituraMaxHz: preset.tessituraMaxHz,
    isGuest: false,
  };
}

export function recommendDuetKey(
  song: SongVocalRange,
  singer1: UserProfile,
  singer2: UserProfile,
): DuetKeyRecommendation | null {
  if (!song.is_duet) return null;

  const fit1 = recommendSoloKey(song, singer1);
  const fit2 = recommendSoloKey(song, singer2);
  const unanalyzed = fit1.unanalyzed || fit2.unanalyzed;
  const uncalibrated = fit1.status === 'uncalibrated' || fit2.status === 'uncalibrated';
  if (unanalyzed || uncalibrated) {
    return {
      kind: 'duet',
      semitones: 0,
      shift1: fit1.semitones,
      shift2: fit2.semitones,
      conflict: false,
      unanalyzed,
      uncalibrated,
      hitsPhysicalLimit: false,
      biasedToward: null,
    };
  }

  const hitsPhysicalLimit = singerHitsLimit(song, singer1, fit1.semitones)
    || singerHitsLimit(song, singer2, fit2.semitones);
  let semitones = Math.round((fit1.semitones + fit2.semitones) / 2);
  let biasedToward: string | null = null;
  if (hitsPhysicalLimit) {
    const singer1Width = profileRangeWidth(singer1);
    const singer2Width = profileRangeWidth(singer2);
    const narrower = singer1Width <= singer2Width ? singer1 : singer2;
    const narrowerShift = narrower.id === singer1.id ? fit1.semitones : fit2.semitones;
    const widerShift = narrower.id === singer1.id ? fit2.semitones : fit1.semitones;
    semitones = Math.round((2 * narrowerShift + widerShift) / 3);
    biasedToward = narrower.id;
  }

  // Meaningful conflict threshold: optimal keys diverge by 2+ semitones or hit boundaries
  const conflict = Math.abs(fit1.semitones - fit2.semitones) >= 2 || hitsPhysicalLimit;

  return {
    kind: 'duet',
    semitones: clampKeyShift(semitones),
    shift1: fit1.semitones,
    shift2: fit2.semitones,
    conflict,
    unanalyzed: false,
    uncalibrated: false,
    hitsPhysicalLimit,
    biasedToward,
  };
}

export function profileRangeWidth(profile: UserProfile): number {
  return profile.minHz == null || profile.maxHz == null
    ? Number.POSITIVE_INFINITY
    : profile.maxHz - profile.minHz;
}

export function createProfileId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';
}