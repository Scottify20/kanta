import { UserProfile, QueueSingerAssignment, ProfileVoiceType } from './party-session.models';

export const PROFILE_STORAGE_KEY = 'kanta.party.profiles';
export const AUTO_ADJUST_STORAGE_KEY = 'kanta.party.autoAdjustKey';
export const ROUND_ROBIN_STORAGE_KEY = 'kanta.party.roundRobin';

export const SESSION_ROSTER_KEY = 'kanta.party.session.roster';
export const SESSION_ACTIVE_SINGER_KEY = 'kanta.party.session.activeSingerId';
export const SESSION_DUET_SINGER_KEY = 'kanta.party.session.duetSingerId';
export const SESSION_QUEUE_ASSIGNMENTS_KEY = 'kanta.party.session.queueAssignments';
export const SESSION_LAST_ROUND_ROBIN_KEY = 'kanta.party.session.lastRoundRobinId';

export function isUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<UserProfile>;
  const nullableNumbers = [
    profile.minHz,
    profile.maxHz,
    profile.tessituraMinHz,
    profile.tessituraMaxHz,
  ];
  const nullableNotes = [profile.minNote, profile.maxNote];
  return (
    typeof profile.id === 'string' &&
    typeof profile.name === 'string' &&
    (profile.avatar === null || typeof profile.avatar === 'string') &&
    typeof profile.initials === 'string' &&
    typeof profile.accentColor === 'string' &&
    ['Bass', 'Baritone', 'Tenor', 'Alto', 'Mezzo-Soprano', 'Soprano', 'Uncalibrated'].includes(
      profile.voiceType as ProfileVoiceType,
    ) &&
    nullableNumbers.every(
      (number) => number === null || (typeof number === 'number' && Number.isFinite(number)),
    ) &&
    nullableNotes.every((note) => note === null || typeof note === 'string') &&
    typeof profile.isGuest === 'boolean'
  );
}

export function loadSavedProfiles(): UserProfile[] {
  try {
    const stored = globalThis.localStorage?.getItem(PROFILE_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUserProfile).map((profile) => ({ ...profile, isGuest: false }));
  } catch (error) {
    console.warn('Could not load saved singer profiles:', error);
    return [];
  }
}

export function loadSessionRoster(): UserProfile[] {
  try {
    const stored = globalThis.sessionStorage?.getItem(SESSION_ROSTER_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUserProfile);
  } catch {
    return [];
  }
}

export function saveSessionRoster(roster: UserProfile[]): void {
  try {
    globalThis.sessionStorage?.setItem(SESSION_ROSTER_KEY, JSON.stringify(roster));
  } catch (error) {
    console.warn('Could not save session roster:', error);
  }
}

export function loadSessionActiveSingerId(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_ACTIVE_SINGER_KEY) || null;
  } catch {
    return null;
  }
}

export function saveSessionActiveSingerId(id: string | null): void {
  try {
    if (id) globalThis.sessionStorage?.setItem(SESSION_ACTIVE_SINGER_KEY, id);
    else globalThis.sessionStorage?.removeItem(SESSION_ACTIVE_SINGER_KEY);
  } catch (error) {
    console.warn('Could not save session active singer id:', error);
  }
}

export function loadSessionDuetSingerId(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_DUET_SINGER_KEY) || null;
  } catch {
    return null;
  }
}

export function saveSessionDuetSingerId(id: string | null): void {
  try {
    if (id) globalThis.sessionStorage?.setItem(SESSION_DUET_SINGER_KEY, id);
    else globalThis.sessionStorage?.removeItem(SESSION_DUET_SINGER_KEY);
  } catch (error) {
    console.warn('Could not save session duet singer id:', error);
  }
}

export function loadSessionQueueAssignments(): Record<string, QueueSingerAssignment> {
  try {
    const stored = globalThis.sessionStorage?.getItem(SESSION_QUEUE_ASSIGNMENTS_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, QueueSingerAssignment>;
  } catch {
    return {};
  }
}

export function saveSessionQueueAssignments(assignments: Record<string, QueueSingerAssignment>): void {
  try {
    globalThis.sessionStorage?.setItem(SESSION_QUEUE_ASSIGNMENTS_KEY, JSON.stringify(assignments));
  } catch (error) {
    console.warn('Could not save session queue assignments:', error);
  }
}

export function loadSessionLastRoundRobinId(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_LAST_ROUND_ROBIN_KEY) || null;
  } catch {
    return null;
  }
}

export function loadAutoAdjustKey(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_ADJUST_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function loadRoundRobinEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(ROUND_ROBIN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}