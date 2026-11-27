import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import type { SongManifest } from './songs.service';
import { SongsService } from './songs.service';
import { AudioPlayerService } from './audio-player.service';
import { clampKeyShift, recommendSoloKey } from './vocal-fit';
import {
  UserProfile,
  QueueSingerAssignment,
  ProfileVoiceType,
  KeyRecommendation,
} from './party-session.models';
import {
  createProfileFromPreset,
  classifyVocalRange,
  recommendDuetKey,
} from './vocal-classification';
import {
  loadSavedProfiles,
  loadSessionRoster,
  saveSessionRoster,
  loadSessionActiveSingerId,
  saveSessionActiveSingerId,
  loadSessionDuetSingerId,
  saveSessionDuetSingerId,
  loadSessionQueueAssignments,
  saveSessionQueueAssignments,
  loadSessionLastRoundRobinId,
  loadAutoAdjustKey,
  loadRoundRobinEnabled,
  PROFILE_STORAGE_KEY,
  AUTO_ADJUST_STORAGE_KEY,
  ROUND_ROBIN_STORAGE_KEY,
  SESSION_LAST_ROUND_ROBIN_KEY,
} from './party-storage';

export * from './party-session.models';
export * from './vocal-classification';
export { clampKeyShift, recommendSoloKey } from './vocal-fit';
export type { SoloFitStatus, SoloKeyRecommendation } from './vocal-fit';

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

  private readonly _roster = signal<UserProfile[]>(loadSessionRoster());
  readonly roster = this._roster.asReadonly();

  private readonly _activeSingerId = signal<string | null>(loadSessionActiveSingerId());
  readonly activeSingerId = this._activeSingerId.asReadonly();
  readonly activeSinger = computed(() =>
    this.roster().find((singer) => singer.id === this.activeSingerId()) ?? null,
  );

  private readonly _duetSingerId = signal<string | null>(loadSessionDuetSingerId());
  readonly duetSingerId = this._duetSingerId.asReadonly();
  readonly duetSinger = computed(() =>
    this.roster().find((singer) => singer.id === this.duetSingerId()) ?? null,
  );

  private readonly _singerForFitSorting = signal<UserProfile | null>(null);
  readonly singerForFitSorting = computed(() => this._singerForFitSorting() ?? null);

  private readonly _queueAssignments = signal<Record<string, QueueSingerAssignment>>(
    loadSessionQueueAssignments(),
  );
  readonly queueAssignments = this._queueAssignments.asReadonly();

  private readonly _lastAssignedSingerId = signal<string | null>(
    loadSessionLastRoundRobinId(),
  );

  readonly currentSinger = computed<UserProfile | null>(() => {
    const currentTaskId = this.songs.currentQueueTaskId();
    if (currentTaskId) {
      const assignment = this.queueAssignment(currentTaskId);
      if (assignment.primarySingerId) {
        const singer = this.roster().find((s) => s.id === assignment.primarySingerId);
        if (singer) return singer;
      }
    }
    return this.activeSinger();
  });

  readonly currentSingerId = computed<string | null>(() =>
    this.currentSinger()?.id ?? this.activeSingerId(),
  );

  readonly currentDuetSinger = computed<UserProfile | null>(() => {
    const song = this.songs.currentSong();
    if (!song?.is_duet) return null;

    const currentTaskId = this.songs.currentQueueTaskId();
    if (currentTaskId) {
      const assignment = this.queueAssignment(currentTaskId);
      if (assignment.secondarySingerId) {
        const singer = this.roster().find((s) => s.id === assignment.secondarySingerId);
        if (singer) return singer;
      }
    }
    return this.duetSinger();
  });

  readonly keyRecommendation = computed<KeyRecommendation | null>(() => {
    const song = this.songs.currentSong();
    if (!song) return null;
    const taskId = this.songs.currentQueueTaskId();
    if (taskId) {
      const queueRec = this.recommendQueueItem(taskId, song);
      if (queueRec) return queueRec;
    }
    const singer = this.currentSinger();
    if (!singer) return null;
    const duetSinger = this.currentDuetSinger();
    if (song.is_duet && duetSinger) return recommendDuetKey(song, singer, duetSinger);
    return recommendSoloKey(song, singer);
  });

  readonly appliedSemitones = computed(() =>
    this.autoAdjustKey() ? this.keyRecommendation()?.semitones ?? 0 : 0,
  );

  private primaryHostId: string | null = this._roster()[0]?.id ?? null;
  private guestNumber = 0;

  constructor() {
    effect(() => {
      const taskId = this.songs.currentQueueTaskId();
      if (!taskId) return;

      untracked(() => {
        const song = this.songs.currentSong();
        const assignment = this.ensureQueueAssignment(taskId, song?.is_duet === true);
        const singerId = assignment.primarySingerId;
        if (singerId && singerId !== this._activeSingerId()) {
          this._activeSingerId.set(singerId);
        }
        if (song?.is_duet) {
          this._duetSingerId.set(assignment.secondarySingerId ?? null);
        } else {
          this._duetSingerId.set(null);
        }
      });
    });

    effect(() => saveSessionRoster(this.roster()));
    effect(() => saveSessionActiveSingerId(this.activeSingerId()));
    effect(() => saveSessionDuetSingerId(this.duetSingerId()));
    effect(() => saveSessionQueueAssignments(this.queueAssignments()));
  }

  setAutoAdjustKey(enabled: boolean): void {
    this._autoAdjustKey.set(enabled);
    try {
      globalThis.localStorage?.setItem(AUTO_ADJUST_STORAGE_KEY, String(enabled));
    } catch {}
    this.syncPlaybackKey();
  }

  setRoundRobinEnabled(enabled: boolean): void {
    this._roundRobinEnabled.set(enabled);
    try {
      globalThis.localStorage?.setItem(ROUND_ROBIN_STORAGE_KEY, String(enabled));
    } catch {}
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
      console.warn('Could not apply party key recommendation:', error);
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
      console.warn('Could not apply queued singer key:', error);
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
      roster.map((item) => (item.id === saved.id ? saved : item)),
    );
    this.syncPlaybackKey();
    return saved;
  }

  deleteSavedProfile(profileId: string): boolean {
    if (!this.savedProfiles().some((profile) => profile.id === profileId)) return false;
    this._savedProfiles.update((profiles) => profiles.filter((profile) => profile.id !== profileId));
    this.persistProfiles();
    this.removeSinger(profileId);
    return true;
  }

  updateGuestProfile(profile: UserProfile): UserProfile {
    const guest = this.roster().find((item) => item.id === profile.id && item.isGuest);
    if (!guest) throw new Error(`Quick guest not found: ${profile.id}`);
    const updated = { ...profile, name: profile.name.trim(), isGuest: true };
    this._roster.update((roster) =>
      roster.map((item) => (item.id === updated.id ? updated : item)),
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
    avatar?: string | null,
    calibratedRange?: {
      minHz: number | null;
      maxHz: number | null;
      minNote: string | null;
      maxNote: string | null;
      tessituraMinHz: number | null;
      tessituraMaxHz: number | null;
    } | null,
  ): UserProfile {
    this.guestNumber += 1;
    const base = createProfileFromPreset(voiceType, name.trim() || `Guest ${this.guestNumber}`);
    const sessionGuest: UserProfile = {
      ...base,
      accentColor: accentColor ?? base.accentColor,
      avatar: avatar ?? null,
      isGuest: true,
      ...(calibratedRange ?? {}),
    };
    this.addSingerToRoster(sessionGuest);
    return sessionGuest;
  }

  setExplicitQueueAssignment(taskId: string, assignment: QueueSingerAssignment): void {
    this._queueAssignments.update((assignments) => ({
      ...assignments,
      [taskId]: assignment,
    }));
    if (this.songs.currentQueueTaskId() === taskId) this.syncPlaybackKey();
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
    if (this.songs.currentQueueTaskId() === taskId) {
      if (part === 'primary') this._activeSingerId.set(singerId);
      this.syncPlaybackKey();
    }
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
      && singerId !== 'original'
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
    this._lastAssignedSingerId.set(null);
    try {
      globalThis.sessionStorage?.removeItem(SESSION_LAST_ROUND_ROBIN_KEY);
    } catch {}
  }

  recommendQueueItem(taskId: string, song: SongManifest): KeyRecommendation | null {
    const assignment = this.queueAssignment(taskId);
    const primary = this.roster().find((singer) => singer.id === assignment.primarySingerId);
    if (!primary) return null;
    const secondary = this.roster().find((singer) => singer.id === assignment.secondarySingerId);

    if (song.is_duet && secondary) {
      const duet = recommendDuetKey(song, primary, secondary);
      if (!duet) return null;

      if (assignment.prioritySingerId === 'original') {
        return { ...duet, semitones: 0, biasedToward: 'original' };
      }

      if (!duet.conflict || !assignment.prioritySingerId) return duet;
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
      roster.map((item) => (item.id === guestId ? saved : item)),
    );
    this.syncPlaybackKey();
    return saved;
  }

  clearGuests(): number {
    const remaining = this.roster().filter((singer) => !singer.isGuest);
    const removedIds = new Set(
      this.roster().filter((singer) => singer.isGuest).map((singer) => singer.id),
    );
    if (this.primaryHostId && removedIds.has(this.primaryHostId)) {
      this.primaryHostId = remaining[0]?.id ?? null;
    }
    this.updateRoster(remaining, removedIds);
    return removedIds.size;
  }

  // Allows removing any singer, including the session host
  removeSinger(singerId: string): boolean {
    const roster = this.roster();
    if (!roster.some((singer) => singer.id === singerId)) return false;
    const remaining = roster.filter((singer) => singer.id !== singerId);
    if (singerId === this.primaryHostId) {
      this.primaryHostId = remaining[0]?.id ?? null;
    }
    this.updateRoster(remaining, new Set([singerId]));
    return true;
  }

  setActiveSinger(singerId: string): boolean {
    if (!this.roster().some((singer) => singer.id === singerId)) return false;
    this._activeSingerId.set(singerId);
    this._lastAssignedSingerId.set(singerId);
    try {
      globalThis.sessionStorage?.setItem(SESSION_LAST_ROUND_ROBIN_KEY, singerId);
    } catch {}

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

  setSingerforFitSortingId(profile: UserProfile | null): boolean {
    if (!profile) {
      this._singerForFitSorting.set(null);
      return true;
    }
    this._singerForFitSorting.set(profile);
    return true;
  }

  clearSingerforFitSortingId(): void {
    this._singerForFitSorting.set(null);
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
      return this.activeSingerId() ?? singers[0]?.id ?? null;
    }

    const anchorId = this._lastAssignedSingerId() ?? this.activeSingerId();
    const anchorIndex = singers.findIndex((s) => s.id === anchorId);
    const nextIndex = anchorIndex >= 0 ? (anchorIndex + 1) % singers.length : 0;
    const chosen = singers[nextIndex];

    this._lastAssignedSingerId.set(chosen.id);
    try {
      globalThis.sessionStorage?.setItem(SESSION_LAST_ROUND_ROBIN_KEY, chosen.id);
    } catch {}

    return chosen.id;
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
    if (removedIds.has(this._lastAssignedSingerId() ?? '')) {
      this._lastAssignedSingerId.set(null);
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