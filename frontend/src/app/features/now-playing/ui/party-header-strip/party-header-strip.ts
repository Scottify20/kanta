import { Component, computed, inject, input, signal } from '@angular/core';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { PartySessionService, ProfileVoiceType, UserProfile, VOCAL_PROFILE_PRESETS, PROFILE_COLOR_PRESETS } from '../../../../shared/services/party-session.service';
import { ToastService } from '../../../../shared/services/toast.service';
import { QueueItem } from '../../../queue/interfaces/queue.models';
import { VocalRangeModal } from '../../../settings/ui/vocal-range-modal/vocal-range-modal';

@Component({
  selector: 'app-party-header-strip',
  imports: [PopupPanel, VocalRangeModal],
  templateUrl: './party-header-strip.html',
  styleUrl: './party-header-strip.scss',
})
export class PartyHeaderStrip {
  readonly queuePreview = input<QueueItem[]>([]);
  readonly playing = input(false);
  readonly currentTime = input(0);
  readonly duration = input(0);
  protected readonly party = inject(PartySessionService);
  private readonly toast = inject(ToastService);

  readonly guestName = signal('');
  readonly guestColor = signal('#777777');
  readonly guestVoice = signal<ProfileVoiceType>('Uncalibrated');
  readonly guestColorPresets = PROFILE_COLOR_PRESETS;
  readonly editingActiveProfile = signal(false);
  readonly profileNameDraft = signal('');
  readonly profileColorDraft = signal('#777777');
  readonly profileAvatarDraft = signal<string | null>(null);
  readonly calibratingProfile = signal<UserProfile | null>(null);
  readonly voiceOptions: ProfileVoiceType[] = [
    'Uncalibrated',
    ...VOCAL_PROFILE_PRESETS.map((preset) => preset.voiceType),
  ];
  readonly savedProfilesNotInRoom = computed(() => {
    const inRoom = new Set(this.party.roster().map((profile) => profile.id));
    return this.party.savedProfiles().filter((profile) => !inRoom.has(profile.id));
  });
  readonly visibleSingers = computed(() => {
    const roster = this.party.roster();
    const activeId = this.party.activeSingerId();
    const active = roster.find((singer) => singer.id === activeId);
    const others = roster.filter((singer) => singer.id !== activeId);
    return [...(active ? [active] : []), ...others.slice(0, 2)];
  });
  readonly hiddenSingers = computed(() => this.party.roster().length - this.visibleSingers().length);

  singerInitial(profile: UserProfile): string {
    return profile.initials || profile.name.slice(0, 1).toUpperCase();
  }

  singerFor(item: QueueItem): UserProfile | null {
    return this.party.queueSinger(item.task_id) ?? this.party.activeSinger();
  }

  isUpNext(item: QueueItem): boolean {
    const remaining = this.duration() - this.currentTime();
    return this.playing() && this.queuePreview()[0]?.task_id === item.task_id
      && this.duration() > 0 && remaining >= 0 && remaining <= 18;
  }

  selectSinger(profileId: string): void {
    this.party.setActiveSinger(profileId);
  }

  addSavedProfile(profileId: string): void {
    try {
      this.party.addSavedProfile(profileId);
    } catch (error) {
      console.error('Could not add saved singer to the room:', error);
      this.toast.error('Could not add that singer to the room.');
    }
  }

  addGuest(): void {
    try {
      this.party.quickAddGuest(this.guestName(), this.guestVoice(), this.guestColor());
      this.guestName.set('');
    } catch (error) {
      console.error('Could not add quick guest:', error);
      this.toast.error('Could not add that guest.');
    }
  }

  updateGuestName(event: Event): void {
    this.guestName.set((event.target as HTMLInputElement).value);
  }

  updateGuestColor(event: Event): void {
    this.guestColor.set((event.target as HTMLInputElement).value);
  }

  selectGuestColor(color: string): void {
    this.guestColor.set(color);
  }

  updateGuestVoice(event: Event): void {
    this.guestVoice.set((event.target as HTMLSelectElement).value as ProfileVoiceType);
  }

  startEditingActiveProfile(): void {
    const profile = this.party.activeSinger();
    if (!profile) return;
    this.profileNameDraft.set(profile.name);
    this.profileColorDraft.set(profile.accentColor);
    this.profileAvatarDraft.set(profile.avatar);
    this.editingActiveProfile.set(true);
  }

  async saveActiveProfile(): Promise<void> {
    const profile = this.party.activeSinger();
    const name = this.profileNameDraft().trim();
    if (!profile || !name) return;
    const updated = {
      ...profile,
      name,
      initials: name.trim().split(/\s+/).slice(0, 2).map((part) => part[0].toUpperCase()).join(''),
      accentColor: this.profileColorDraft(),
      avatar: this.profileAvatarDraft(),
    };
    try {
      if (profile.isGuest) this.party.updateGuestProfile(updated);
      else this.party.saveProfile(updated);
      this.editingActiveProfile.set(false);
    } catch (error) {
      console.error('Could not update the active singer profile:', error);
      this.toast.error('Could not update this singer profile.');
    }
  }

  async chooseProfilePhoto(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.toast.error('Choose an image file for the profile photo.');
      return;
    }
    if (file.size > 2_000_000) {
      this.toast.error('Profile photos must be smaller than 2 MB.');
      return;
    }
    try {
      this.profileAvatarDraft.set(await this.readPhoto(file));
    } catch (error) {
      console.error('Could not read the singer profile photo:', error);
      this.toast.error('Could not load this profile photo.');
    }
  }

  openCalibration(): void {
    this.calibratingProfile.set(this.party.activeSinger());
  }

  selectedMicrophoneId(): string {
    try {
      return globalThis.localStorage?.getItem('kanta.microphoneDeviceId') ?? '';
    } catch (error) {
      console.warn('Could not read the selected microphone:', error);
      return '';
    }
  }

  closeCalibration(): void {
    this.calibratingProfile.set(null);
  }

  rangeLabel(profile: UserProfile): string {
    return profile.minNote && profile.maxNote ? `${profile.minNote}–${profile.maxNote}` : 'Range not set';
  }

  isVisibleSinger(singerId: string): boolean {
    return this.visibleSingers().some((singer) => singer.id === singerId);
  }

  private readPhoto(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('Photo could not be decoded.'));
      }, { once: true });
      reader.addEventListener('error', () => reject(reader.error ?? new Error('Photo could not be read.')), { once: true });
      reader.readAsDataURL(file);
    });
  }
}
