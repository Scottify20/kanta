import { computed, inject, Injectable, signal } from '@angular/core';
import type { SongManifest } from './songs.service';
import { SongsService } from './songs.service';
import { AudioPlayerService } from './audio-player.service';
import { clampKeyShift, recommendSoloKey, singerHitsLimit } from './vocal-fit';
import type { SoloKeyRecommendation, SongVocalRange } from './vocal-fit';

export { clampKeyShift, recommendSoloKey } from './vocal-fit';
export type { SoloFitStatus, SoloKeyRecommendation } from './vocal-fit';

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

const PROFILE_STORAGE_KEY = 'kanta.party.profiles';
const AUTO_ADJUST_STORAGE_KEY = 'kanta.party.autoAdjustKey';
const ROUND_ROBIN_STORAGE_KEY = 'kanta.party.roundRobin';
const VOICE_TYPES: readonly VoiceType[] = [
  'Bass',
  'Baritone',
  'Tenor',
  'Alto',
  'Mezzo-Soprano',
  'Soprano',
];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const PRESET_RANGES: Record<
  VoiceType,
  { min: number; max: number; tessituraMin: number; tessituraMax: number; accentColor: string }
> = {
  Bass: { min: 40, max: 64, tessituraMin: 43, tessituraMax: 60, accentColor: '#4f7cac' },
  Baritone: { min: 45, max: 69, tessituraMin: 48, tessituraMax: 65, accentColor: '#597a55' },
  Tenor: { min: 48, max: 72, tessituraMin: 52, tessituraMax: 69, accentColor: '#4a8f8c' },
  Alto: { min: 53, max: 77, tessituraMin: 57, tessituraMax: 74, accentColor: '#9b6aa0' },
  'Mezzo-Soprano': { min: 55, max: 79, tessituraMin: 59, tessituraMax: 76, accentColor: '#c0784b' },
  Soprano: { min: 60, max: 84, tessituraMin: 64, tessituraMax: 79, accentColor: '#b85c73' },
};

const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const midiToNote = (midi: number): string =>
  `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

export const VOCAL_PROFILE_PRESETS: readonly VocalProfilePreset[] = VOICE_TYPES.map((voiceType) => {
  const range = PRESET_RANGES[voiceType];
  return {
    voiceType,
    minHz: midiToHz(range.min),
    maxHz: midiToHz(range.max),
    minNote: midiToNote(range.min),
    maxNote: midiToNote(range.max),
    tessituraMinHz: midiToHz(range.tessituraMin),
    tessituraMaxHz: midiToHz(range.tessituraMax),
    tessituraMinNote: midiToNote(range.tessituraMin),
    tessituraMaxNote: midiToNote(range.tessituraMax),
    accentColor: range.accentColor,
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
  accentColor: '#777777',
};
export const PROFILE_COLOR_PRESETS = [
  '#4f7cac', '#597a55', '#4a8f8c', '#9b6aa0',
  '#c0784b', '#b85c73', '#d2a84a', '#718096',
] as const;

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

export type KeyRecommendation = SoloKeyRecommendation | DuetKeyRecommendation;

export function createProfileFromPreset(
  voiceType: ProfileVoiceType,
  name: string,
  id = createProfileId(),
): UserProfile {
  const preset = voiceType === 'Uncalibrated'
    ? UNCALIBRATED_PROFILE_PRESET
    : VOCAL_PROFILE_PRESETS.find((item) => item.voiceType === voiceType);
  if (!preset) throw new Error(`Unknown vocal profile preset: ${voiceType}`);

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

  return {
    kind: 'duet',
    semitones: clampKeyShift(semitones),
    shift1: fit1.semitones,
    shift2: fit2.semitones,
    conflict: Math.abs(fit1.semitones - fit2.semitones) > 5,
    unanalyzed: false,
    uncalibrated: false,
    hitsPhysicalLimit,
    biasedToward,
  };
}

@Injectable({ providedIn: 'root' })
export class PartySessionService {
  private readonly songs = inject(SongsService);
  private readonly audio = inject(AudioPlayerService);
  private readonly _savedProfiles = signal(loadSavedProfiles());
  readonly savedProfiles = this._savedProfiles.asReadonly();
  private readonly _autoAdjustKey = signal(loadAutoAdjustKey());
  readonly autoAdjustKey = this._autoAdjustKey.asReadonly();
  private readonly _roundRobinEnabled = signal(loadRoundRobinEnabled());
  readonly roundRobinEnabled = this._roundRobinEnabled.asReadonly();

  private readonly _roster = signal<UserProfile[]>([]);
  readonly roster = this._roster.asReadonly();
  private readonly _activeSingerId = signal<string | null>(null);
  readonly activeSingerId = this._activeSingerId.asReadonly();
  readonly activeSinger = computed(() =>
    this.roster().find((singer) => singer.id === this.activeSingerId()) ?? null,
  );
  private readonly _duetSingerId = signal<string | null>(null);
  readonly duetSingerId = this._duetSingerId.asReadonly();
  readonly duetSinger = computed(() =>
    this.roster().find((singer) => singer.id === this.duetSingerId()) ?? null,
  );
  readonly keyRecommendation = computed<KeyRecommendation | null>(() => {
    const song = this.songs.currentSong();
    const singer = this.activeSinger();
    if (!song || !singer) return null;
    const duetSinger = this.duetSinger();
    if (song.is_duet && duetSinger) return recommendDuetKey(song, singer, duetSinger);
    return recommendSoloKey(song, singer);
  });
  readonly appliedSemitones = computed(() =>
    this.autoAdjustKey() ? this.keyRecommendation()?.semitones ?? 0 : 0,
  );
  private readonly _queueAssignments = signal<Record<string, QueueSingerAssignment>>({});
  readonly queueAssignments = this._queueAssignments.asReadonly();

  private primaryHostId: string | null = null;
  private guestNumber = 0;
  private roundRobinCursor = 0;

  setAutoAdjustKey(enabled: boolean): void {
    this._autoAdjustKey.set(enabled);
    try {
      globalThis.localStorage?.setItem(AUTO_ADJUST_STORAGE_KEY, String(enabled));
    } catch (error) {
      console.warn('Could not save the auto-adjust key setting:', error);
    }
    this.syncPlaybackKey();
  }

  setRoundRobinEnabled(enabled: boolean): void {
    this._roundRobinEnabled.set(enabled);
    try {
      globalThis.localStorage?.setItem(ROUND_ROBIN_STORAGE_KEY, String(enabled));
    } catch (error) {
      console.warn('Could not save the round-robin setting:', error);
    }
  }

  async applyActiveKeyToPlayback(): Promise<void> {
    if (!this.audio.hasStems) return;
    try {
      const taskId = this.songs.currentQueueTaskId();
      const song = this.songs.currentSong();
      if (taskId && song) {
        await this.applyQueueItemKey(song, taskId);
      } else {
        await this.audio.setSemitoneShift(this.appliedSemitones());
      }
    } catch (error) {
      console.warn('Could not apply the party key recommendation:', error);
    }
  }

  async applyQueueItemKey(song: SongManifest, taskId: string): Promise<void> {
    if (!this.audio.hasStems) return;
    const recommendation = this.recommendQueueItem(taskId, song);
    try {
      await this.audio.setSemitoneShift(
        this.autoAdjustKey() ? recommendation?.semitones ?? 0 : 0,
      );
    } catch (error) {
      console.warn('Could not apply the queued singer key:', error);
    }
  }

  saveProfile(profile: UserProfile): UserProfile {
    if (!profile.id.trim() || !profile.name.trim()) {
      throw new Error('A saved singer profile needs an id and name.');
    }
    const saved = { ...profile, name: profile.name.trim(), isGuest: false };
    const profiles = this.savedProfiles().filter((item) => item.id !== saved.id);
    this._savedProfiles.set([...profiles, saved]);
    this.persistProfiles();
    this._roster.update((roster) =>
      roster.map((item) => item.id === saved.id ? saved : item),
    );
    this.syncPlaybackKey();
    return saved;
  }

  deleteSavedProfile(profileId: string): boolean {
    if (!this.savedProfiles().some((profile) => profile.id === profileId)) return false;
    this._savedProfiles.update((profiles) => profiles.filter((profile) => profile.id !== profileId));
    this.persistProfiles();
    if (profileId !== this.primaryHostId) this.removeSinger(profileId);
    return true;
  }

  updateGuestProfile(profile: UserProfile): UserProfile {
    const guest = this.roster().find((item) => item.id === profile.id && item.isGuest);
    if (!guest) throw new Error(`Quick guest not found: ${profile.id}`);
    const updated = { ...profile, name: profile.name.trim(), isGuest: true };
    if (!updated.name) throw new Error('A singer profile needs a name.');
    this._roster.update((roster) =>
      roster.map((item) => item.id === updated.id ? updated : item),
    );
    this.syncPlaybackKey();
    return updated;
  }

  addSavedProfile(profileId: string): UserProfile {
    const profile = this.savedProfiles().find((item) => item.id === profileId);
    if (!profile) throw new Error(`Saved singer profile not found: ${profileId}`);
    const existing = this.roster().find((item) => item.id === profileId);
    if (existing) return existing;
    this.addSingerToRoster({ ...profile, isGuest: false });
    return profile;
  }

  quickAddGuest(
    name = '',
    voiceType: ProfileVoiceType = 'Uncalibrated',
    accentColor?: string,
  ): UserProfile {
    this.guestNumber += 1;
    const guest = createProfileFromPreset(voiceType, name.trim() || `Guest ${this.guestNumber}`);
    const sessionGuest = {
      ...guest,
      accentColor: accentColor === undefined ? guest.accentColor : validateAccentColor(accentColor),
      isGuest: true,
    };
    this.addSingerToRoster(sessionGuest);
    return sessionGuest;
  }

  ensureQueueAssignment(taskId: string, isDuet = false): QueueSingerAssignment {
    const existing = this._queueAssignments()[taskId];
    if (existing) {
      if (!isDuet || existing.secondarySingerId) return existing;
      const secondarySingerId = this.roster()
        .find((singer) => singer.id !== existing.primarySingerId)?.id ?? null;
      if (!secondarySingerId) return existing;
      const updated = { ...existing, secondarySingerId };
      this._queueAssignments.update((assignments) => ({ ...assignments, [taskId]: updated }));
      return updated;
    }
    const primarySingerId = this.nextSingerId();
    const secondarySingerId = isDuet
      ? this.roster().find((singer) => singer.id !== primarySingerId)?.id ?? null
      : null;
    const assignment = { primarySingerId, secondarySingerId, prioritySingerId: null };
    this._queueAssignments.update((assignments) => ({ ...assignments, [taskId]: assignment }));
    return assignment;
  }

  queueAssignment(taskId: string): QueueSingerAssignment {
    return this._queueAssignments()[taskId] ?? {
      primarySingerId: this.activeSingerId(),
      secondarySingerId: null,
      prioritySingerId: null,
    };
  }

  queueSinger(taskId: string, part: 'primary' | 'secondary' = 'primary'): UserProfile | null {
    const assignment = this.queueAssignment(taskId);
    const singerId = part === 'primary' ? assignment.primarySingerId : assignment.secondarySingerId;
    return this.roster().find((singer) => singer.id === singerId) ?? null;
  }

  assignQueueSinger(
    taskId: string,
    singerId: string,
    part: 'primary' | 'secondary' = 'primary',
  ): boolean {
    if (!this.roster().some((singer) => singer.id === singerId)) return false;
    const assignment = this.ensureQueueAssignment(taskId, part === 'secondary');
    if (
      (part === 'primary' && singerId === assignment.secondarySingerId)
      || (part === 'secondary' && singerId === assignment.primarySingerId)
    ) return false;
    this._queueAssignments.update((assignments) => ({
      ...assignments,
      [taskId]: {
        ...assignment,
        [part === 'primary' ? 'primarySingerId' : 'secondarySingerId']: singerId,
        ...(assignment.prioritySingerId === singerId ? {} : { prioritySingerId: null }),
      },
    }));
    if (this.songs.currentQueueTaskId() === taskId) this.syncPlaybackKey();
    return true;
  }

  clearQueueSinger(taskId: string, part: 'primary' | 'secondary' = 'primary'): void {
    const assignment = this.ensureQueueAssignment(taskId, part === 'secondary');
    this._queueAssignments.update((assignments) => ({
      ...assignments,
      [taskId]: {
        ...assignment,
        [part === 'primary' ? 'primarySingerId' : 'secondarySingerId']: null,
        prioritySingerId: null,
      },
    }));
    if (this.songs.currentQueueTaskId() === taskId) this.syncPlaybackKey();
  }

  setQueueKeyPriority(taskId: string, singerId: string | null): boolean {
    const assignment = this.ensureQueueAssignment(taskId);
    if (
      singerId !== null
      && singerId !== assignment.primarySingerId
      && singerId !== assignment.secondarySingerId
    ) return false;
    this._queueAssignments.update((assignments) => ({
      ...assignments,
      [taskId]: { ...assignment, prioritySingerId: singerId },
    }));
    if (this.songs.currentQueueTaskId() === taskId) this.syncPlaybackKey();
    return true;
  }

  removeQueueAssignment(taskId: string): void {
    this._queueAssignments.update((assignments) => {
      if (!assignments[taskId]) return assignments;
      const next = { ...assignments };
      delete next[taskId];
      return next;
    });
  }

  clearQueueAssignments(): void {
    this._queueAssignments.set({});
  }

  recommendQueueItem(taskId: string, song: SongManifest): KeyRecommendation | null {
    const assignment = this.queueAssignment(taskId);
    const primary = this.roster().find((singer) => singer.id === assignment.primarySingerId);
    if (!primary) return null;
    const secondary = this.roster().find((singer) => singer.id === assignment.secondarySingerId);
    if (song.is_duet && secondary) {
      const duet = recommendDuetKey(song, primary, secondary);
      if (!duet || !duet.conflict || !assignment.prioritySingerId) return duet;
      const priority = this.roster().find((singer) => singer.id === assignment.prioritySingerId);
      if (!priority) return duet;
      const fit = recommendSoloKey(song, priority);
      return { ...duet, semitones: fit.semitones, biasedToward: priority.id };
    }
    return recommendSoloKey(song, primary);
  }

  promoteGuest(guestId: string): UserProfile {
    const guest = this.roster().find((item) => item.id === guestId && item.isGuest);
    if (!guest) throw new Error(`Quick guest not found: ${guestId}`);
    const saved = this.saveProfile({ ...guest, isGuest: false });
    this._roster.update((roster) =>
      roster.map((item) => item.id === guestId ? saved : item),
    );
    this.syncPlaybackKey();
    return saved;
  }

  clearGuests(): number {
    const remaining = this.roster().filter(
      (singer) => !singer.isGuest || singer.id === this.primaryHostId,
    );
    const removedIds = new Set(
      this.roster().filter((singer) => !remaining.some((item) => item.id === singer.id))
        .map((singer) => singer.id),
    );
    this.updateRoster(remaining, removedIds);
    return removedIds.size;
  }

  removeSinger(singerId: string): boolean {
    if (singerId === this.primaryHostId) return false;
    const roster = this.roster();
    if (!roster.some((singer) => singer.id === singerId)) return false;
    const remaining = roster.filter((singer) => singer.id !== singerId);
    this.updateRoster(remaining, new Set([singerId]));
    return true;
  }

  setActiveSinger(singerId: string): boolean {
    if (!this.roster().some((singer) => singer.id === singerId)) return false;
    this._activeSingerId.set(singerId);
    if (this.duetSingerId() === singerId) this._duetSingerId.set(null);
    this.assignUnclaimedQueueItems(singerId);
    const currentTaskId = this.songs.currentQueueTaskId();
    if (currentTaskId) {
      const current = this.ensureQueueAssignment(currentTaskId);
      this._queueAssignments.update((assignments) => ({
        ...assignments,
        [currentTaskId]: {
          ...current,
          primarySingerId: singerId,
          secondarySingerId: current.secondarySingerId === singerId ? null : current.secondarySingerId,
          prioritySingerId: null,
        },
      }));
    }
    this.syncPlaybackKey();
    return true;
  }

  assignDuetSinger(singerId: string | null): boolean {
    if (singerId === null) {
      this._duetSingerId.set(null);
      this.syncPlaybackKey();
      return true;
    }
    if (
      singerId === this.activeSingerId()
      || !this.roster().some((singer) => singer.id === singerId)
    ) return false;
    this._duetSingerId.set(singerId);
    this.syncPlaybackKey();
    return true;
  }

  private addSingerToRoster(singer: UserProfile): void {
    this._roster.update((roster) => [...roster, singer]);
    if (!this.primaryHostId) this.primaryHostId = singer.id;
    if (!this.activeSingerId()) {
      this._activeSingerId.set(singer.id);
      this.assignUnclaimedQueueItems(singer.id);
    }
    this.syncPlaybackKey();
  }

  private assignUnclaimedQueueItems(singerId: string): void {
    this._queueAssignments.update((assignments) => {
      let changed = false;
      const next = { ...assignments };
      for (const [taskId, assignment] of Object.entries(assignments)) {
        if (assignment.primarySingerId !== null) continue;
        next[taskId] = { ...assignment, primarySingerId: singerId };
        changed = true;
      }
      return changed ? next : assignments;
    });
  }

  private nextSingerId(): string | null {
    const singers = this.roster();
    if (!singers.length) return null;
    if (!this.roundRobinEnabled() || singers.length === 1) {
      return this.activeSingerId();
    }
    const singer = singers[this.roundRobinCursor % singers.length];
    this.roundRobinCursor = (this.roundRobinCursor + 1) % singers.length;
    return singer.id;
  }

  private updateRoster(roster: UserProfile[], removedIds: Set<string>): void {
    this._roster.set(roster);
    this._queueAssignments.update((assignments) =>
      Object.fromEntries(Object.entries(assignments).map(([taskId, assignment]) => [
        taskId,
        {
          ...assignment,
          primarySingerId: removedIds.has(assignment.primarySingerId ?? '')
            ? roster[0]?.id ?? null
            : assignment.primarySingerId,
          secondarySingerId: removedIds.has(assignment.secondarySingerId ?? '')
            ? null
            : assignment.secondarySingerId,
          prioritySingerId: removedIds.has(assignment.prioritySingerId ?? '')
            ? null
            : assignment.prioritySingerId,
        },
      ])),
    );
    if (removedIds.has(this.activeSingerId() ?? '')) {
      this._activeSingerId.set(roster[0]?.id ?? null);
    }
    if (removedIds.has(this.duetSingerId() ?? '')) this._duetSingerId.set(null);
    this.syncPlaybackKey();
  }

  private syncPlaybackKey(): void {
    void this.applyActiveKeyToPlayback();
  }

  private persistProfiles(): void {
    try {
      globalThis.localStorage?.setItem(
        PROFILE_STORAGE_KEY,
        JSON.stringify(this.savedProfiles().filter((profile) => !profile.isGuest)),
      );
    } catch (error) {
      console.warn('Could not save singer profiles:', error);
    }
  }
}

function validateAccentColor(value: string): string {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error('Guest accent color must be a six-digit hex color.');
  return value;
}

function profileRangeWidth(profile: UserProfile): number {
  return profile.minHz == null || profile.maxHz == null
    ? Number.POSITIVE_INFINITY
    : profile.maxHz - profile.minHz;
}

function createProfileId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';
}

function loadSavedProfiles(): UserProfile[] {
  try {
    const stored = globalThis.localStorage?.getItem(PROFILE_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new TypeError('Saved singer profiles must be an array.');
    return parsed.filter(isUserProfile).map((profile) => ({ ...profile, isGuest: false }));
  } catch (error) {
    console.warn('Could not load saved singer profiles:', error);
    return [];
  }
}

function loadAutoAdjustKey(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_ADJUST_STORAGE_KEY) !== 'false';
  } catch (error) {
    console.warn('Could not load the auto-adjust key setting:', error);
    return true;
  }
}

function loadRoundRobinEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(ROUND_ROBIN_STORAGE_KEY) === 'true';
  } catch (error) {
    console.warn('Could not load the round-robin setting:', error);
    return false;
  }
}

function isUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<UserProfile>;
  const nullableNumbers = [
    profile.minHz,
    profile.maxHz,
    profile.tessituraMinHz,
    profile.tessituraMaxHz,
  ];
  const nullableNotes = [profile.minNote, profile.maxNote];
  return typeof profile.id === 'string'
    && typeof profile.name === 'string'
    && (profile.avatar === null || typeof profile.avatar === 'string')
    && typeof profile.initials === 'string'
    && typeof profile.accentColor === 'string'
    && [...VOICE_TYPES, 'Uncalibrated'].includes(profile.voiceType as ProfileVoiceType)
    && nullableNumbers.every((number) =>
      number === null || (typeof number === 'number' && Number.isFinite(number)),
    )
    && nullableNotes.every((note) => note === null || typeof note === 'string')
    && typeof profile.isGuest === 'boolean';
}
