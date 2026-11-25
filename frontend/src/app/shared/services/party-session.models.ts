export type VoiceType = 'Bass' | 'Baritone' | 'Tenor' | 'Alto' | 'Mezzo-Soprano' | 'Soprano';
export type ProfileVoiceType = VoiceType | 'Uncalibrated';

export interface UserProfile {
  id: string;
  name: string;
  avatar: string | null;
  initials: string;
  accentColor: string;
  voiceType: ProfileVoiceType;
  minHz: number | null;
  maxHz: number | null;
  minNote: string | null;
  maxNote: string | null;
  tessituraMinHz: number | null;
  tessituraMaxHz: number | null;
  isGuest: boolean;
}

export interface QueueSingerAssignment {
  primarySingerId: string | null;
  secondarySingerId: string | null;
  prioritySingerId: string | null;
}

export interface VocalProfilePreset {
  voiceType: ProfileVoiceType;
  minHz: number | null;
  maxHz: number | null;
  minNote: string | null;
  maxNote: string | null;
  tessituraMinHz: number | null;
  tessituraMaxHz: number | null;
  tessituraMinNote: string | null;
  tessituraMaxNote: string | null;
  accentColor: string;
}

export interface DuetKeyRecommendation {
  kind: 'duet';
  semitones: number;
  shift1: number;
  shift2: number;
  conflict: boolean;
  unanalyzed: boolean;
  uncalibrated: boolean;
  hitsPhysicalLimit: boolean;
  biasedToward: string | null;
}

export type KeyRecommendation = import('./vocal-fit').SoloKeyRecommendation | DuetKeyRecommendation;

// Desaturated, aesthetic palette tailored for dark frosted glass
export const PROFILE_COLOR_PRESETS = [
  '#4f7cac', // Slate Blue
  '#597a55', // Sage Moss
  '#4a8f8c', // Muted Teal
  '#9b6aa0', // Heather Lavender
  '#c0784b', // Warm Terracotta
  '#b85c73', // Dusty Rose
  '#c29b64', // Warm Ochre
  '#607274', // Steel Mineral
] as const;