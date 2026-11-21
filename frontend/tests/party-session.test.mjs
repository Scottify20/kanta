import '@angular/compiler';
import { createEnvironmentInjector, Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayerService } from '../src/app/shared/services/audio-player.service.ts';
import {
  PartySessionService,
  clampKeyShift,
  createProfileFromPreset,
  recommendDuetKey,
  recommendSoloKey,
} from '../src/app/shared/services/party-session.service.ts';
import { SongsService } from '../src/app/shared/services/songs.service.ts';

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

const singer = (id, tessituraMaxHz, minHz = 50, maxHz = 1200) => ({
  ...createProfileFromPreset('Tenor', id, id),
  id,
  tessituraMaxHz,
  minHz,
  maxHz,
});

const song = (vocalMaxHz, vocalMinHz = 100, isDuet = false) => ({
  artist: 'Artist',
  album: 'Album',
  title: 'Title',
  stems: [],
  lyrics: [],
  covers: [],
  master: null,
  is_duet: isDuet,
  vocal_min_hz: vocalMinHz,
  vocal_max_hz: vocalMaxHz,
});

const injectService = (currentSong = null, storage = new MemoryStorage()) => {
  vi.stubGlobal('localStorage', storage);
  const songs = {
    currentSong: signal(currentSong),
    currentQueueTaskId: signal(null),
  };
  const audio = {
    hasStems: true,
    setSemitoneShift: vi.fn().mockResolvedValue(undefined),
  };
  const injector = createEnvironmentInjector([
    { provide: SongsService, useValue: songs },
    { provide: AudioPlayerService, useValue: audio },
  ], Injector.NULL);
  const service = runInInjectionContext(injector, () => new PartySessionService());
  return { service, songs, audio, storage, injector };
};

const injectors = [];

afterEach(() => {
  injectors.splice(0).forEach((injector) => injector.destroy());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('party key recommendation', () => {
  it('classifies natural and adjusted solo fits using tessitura maximum', () => {
    const profile = singer('singer', 400);
    expect(recommendSoloKey(song(400), profile)).toMatchObject({
      semitones: 0,
      status: 'natural',
    });
    expect(recommendSoloKey(song(450), profile)).toMatchObject({
      semitones: -2,
      status: 'adjusted',
    });
  });

  it('clamps a large recommended shift to six semitones and marks it as reach', () => {
    expect(clampKeyShift(-9)).toBe(-6);
    expect(clampKeyShift(9)).toBe(6);
    expect(clampKeyShift(Number.NaN)).toBe(0);
    expect(recommendSoloKey(song(800), singer('singer', 400))).toMatchObject({
      semitones: -6,
      status: 'reach',
    });
    expect(recommendSoloKey(song(510), singer('limited', 500, 100, 505))).toMatchObject({
      semitones: 0,
      status: 'reach',
      hitsPhysicalLimit: true,
    });
  });

  it('uses the rounded duet midpoint and flags a shift conflict over five semitones', () => {
    const midpoint = recommendDuetKey(
      song(450, 100, true),
      singer('one', 400),
      singer('two', 500),
    );
    expect(midpoint).toMatchObject({
      shift1: -2,
      shift2: 2,
      semitones: 0,
      conflict: false,
    });

    const conflict = recommendDuetKey(
      song(400, 100, true),
      singer('low', 200),
      singer('high', 500),
    );
    expect(conflict?.conflict).toBe(true);
    expect(Math.abs((conflict?.shift1 ?? 0) - (conflict?.shift2 ?? 0))).toBeGreaterThan(5);
  });

  it('biases a limited duet compromise toward the singer with the narrower range', () => {
    const recommendation = recommendDuetKey(
      song(600, 200, true),
      singer('narrow', 450, 300, 450),
      singer('wide', 600, 100, 1000),
    );
    expect(recommendation).toMatchObject({
      shift1: -5,
      shift2: 0,
      semitones: -3,
      hitsPhysicalLimit: true,
      biasedToward: 'narrow',
    });
  });

  it('returns original pitch and marks an unanalyzed song', () => {
    expect(recommendSoloKey(song(null), singer('singer', 400))).toMatchObject({
      semitones: 0,
      status: 'unanalyzed',
      unanalyzed: true,
    });
    expect(recommendDuetKey(song(null, null, true), singer('one', 400), singer('two', 500)))
      .toMatchObject({ semitones: 0, unanalyzed: true });
  });
});

describe('party session profiles', () => {
  it('persists household profiles and auto-adjust setting but keeps quick guests session-only', () => {
    const { service, storage, injector } = injectService();
    injectors.push(injector);
    expect(service.autoAdjustKey()).toBe(true);
    service.setAutoAdjustKey(false);
    expect(storage.getItem('kanta.party.autoAdjustKey')).toBe('false');

    const host = createProfileFromPreset('Bass', 'Host', 'host');
    service.saveProfile(host);
    service.addSavedProfile('host');
    const guest = service.quickAddGuest('Temporary', 'Bass', '#123456');
    expect(guest).toMatchObject({ voiceType: 'Bass', accentColor: '#123456', isGuest: true });

    expect(service.roster().map((profile) => profile.id)).toEqual(['host', guest.id]);
    expect(service.activeSingerId()).toBe('host');
    expect(service.setActiveSinger(guest.id)).toBe(true);
    expect(service.activeSinger()?.id).toBe(guest.id);
    expect(service.assignDuetSinger('host')).toBe(true);
    expect(service.duetSinger()?.id).toBe('host');
    expect(JSON.parse(storage.getItem('kanta.party.profiles'))).toHaveLength(1);
    expect(service.removeSinger('host')).toBe(false);
    expect(service.promoteGuest(guest.id).isGuest).toBe(false);
    expect(service.savedProfiles().map((profile) => profile.id)).toEqual(['host', guest.id]);

    service.quickAddGuest('Another guest');
    expect(service.clearGuests()).toBe(1);
    expect(service.roster().map((profile) => profile.id)).toEqual(['host', guest.id]);

    const restored = injectService(null, storage);
    injectors.push(restored.injector);
    expect(restored.service.autoAdjustKey()).toBe(false);
    expect(restored.service.savedProfiles().map((profile) => profile.id)).toEqual(['host', guest.id]);
    expect(restored.service.roster()).toEqual([]);
  });

  it('updates temporary profiles without saving them and safely deletes household profiles', () => {
    const { service, storage, injector } = injectService();
    injectors.push(injector);
    const host = createProfileFromPreset('Baritone', 'Host', 'host');
    service.saveProfile(host);
    service.addSavedProfile(host.id);
    const guest = service.quickAddGuest('Temporary');

    expect(service.updateGuestProfile({ ...guest, minNote: 'C3' })).toMatchObject({
      id: guest.id,
      minNote: 'C3',
      isGuest: true,
    });
    expect(JSON.parse(storage.getItem('kanta.party.profiles'))).toHaveLength(1);

    const savedSinger = createProfileFromPreset('Soprano', 'Saved', 'saved');
    service.saveProfile(savedSinger);
    service.addSavedProfile(savedSinger.id);
    expect(service.deleteSavedProfile(savedSinger.id)).toBe(true);
    expect(service.roster().some((profile) => profile.id === savedSinger.id)).toBe(false);
    expect(service.deleteSavedProfile(host.id)).toBe(true);
    expect(service.roster().some((profile) => profile.id === host.id)).toBe(true);
    expect(service.savedProfiles()).toEqual([]);
  });

  it('keeps queue singer assignments session-only and supports duet priority', () => {
    const { service, storage, injector } = injectService();
    injectors.push(injector);
    service.saveProfile(singer('one', 200, 100, 220));
    service.addSavedProfile('one');
    const second = service.quickAddGuest('Second', 'Soprano');
    const assignment = service.ensureQueueAssignment('task', true);
    expect(assignment).toMatchObject({
      primarySingerId: 'one',
      secondarySingerId: second.id,
      prioritySingerId: null,
    });

    const duet = { ...song(600, 200, true), vocal_min_hz: 200 };
    const recommendation = service.recommendQueueItem('task', duet);
    expect(recommendation).toMatchObject({ kind: 'duet', conflict: true });
    expect(service.setQueueKeyPriority('task', second.id)).toBe(true);
    expect(service.recommendQueueItem('task', duet)).toMatchObject({
      kind: 'duet',
      biasedToward: second.id,
      semitones: 5,
    });
    expect(service.assignQueueSinger('task', 'one', 'secondary')).toBe(false);
    expect(service.assignQueueSinger('task', second.id, 'primary')).toBe(false);

    service.removeQueueAssignment('task');
    expect(service.queueAssignments()).toEqual({});
    expect(storage.getItem('kanta.party.queueAssignments')).toBeNull();
  });

  it('updates the current queue item when the active singer changes', async () => {
    const { service, songs, audio, injector } = injectService(song(500));
    injectors.push(injector);
    service.saveProfile(singer('one', 400));
    service.addSavedProfile('one');
    service.saveProfile(singer('two', 300));
    service.addSavedProfile('two');
    service.ensureQueueAssignment('current-task');
    songs.currentQueueTaskId.set('current-task');

    expect(service.setActiveSinger('two')).toBe(true);
    expect(service.queueAssignment('current-task').primarySingerId).toBe('two');
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.setSemitoneShift).toHaveBeenLastCalledWith(-6);
  });

  it('assigns newly queued tracks round-robin when enabled and can leave a turn unassigned', () => {
    const { service, storage, injector } = injectService();
    injectors.push(injector);
    service.saveProfile(singer('one', 400));
    service.addSavedProfile('one');
    const second = service.quickAddGuest('Second');
    service.setRoundRobinEnabled(true);
    expect(storage.getItem('kanta.party.roundRobin')).toBe('true');
    expect(service.ensureQueueAssignment('first').primarySingerId).toBe('one');
    expect(service.ensureQueueAssignment('second').primarySingerId).toBe(second.id);
    service.clearQueueSinger('first');
    expect(service.queueAssignment('first').primarySingerId).toBeNull();
  });

  it('derives and applies the active singer recommendation from the current SongManifest', async () => {
    const { service, songs, audio, injector } = injectService(song(450));
    injectors.push(injector);
    service.saveProfile(singer('singer', 400));
    service.addSavedProfile('singer');
    expect(service.keyRecommendation()).toMatchObject({ kind: 'solo', semitones: -2 });
    expect(service.appliedSemitones()).toBe(-2);
    await service.applyActiveKeyToPlayback();
    expect(audio.setSemitoneShift).toHaveBeenLastCalledWith(-2);

    service.setAutoAdjustKey(false);
    expect(service.appliedSemitones()).toBe(0);
    await service.applyActiveKeyToPlayback();
    expect(audio.setSemitoneShift).toHaveBeenLastCalledWith(0);

    songs.currentSong.set(song(null));
    expect(service.keyRecommendation()).toMatchObject({ status: 'unanalyzed', semitones: 0 });
  });
});
