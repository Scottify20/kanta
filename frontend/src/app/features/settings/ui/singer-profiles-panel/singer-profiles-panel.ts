import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  createProfileFromPreset,
  PartySessionService,
  VOCAL_PROFILE_PRESETS,
  PROFILE_COLOR_PRESETS,
} from '../../../../shared/services/party-session.service';
import type { ProfileVoiceType, UserProfile } from '../../../../shared/services/party-session.service';
import { VocalRangeModal } from '../vocal-range-modal/vocal-range-modal';

const PROFILE_VOICE_TYPES: ProfileVoiceType[] = [
  ...VOCAL_PROFILE_PRESETS.map((preset) => preset.voiceType),
  'Uncalibrated',
];

function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0].toUpperCase()).join('') || '?';
}

@Component({
  selector: 'app-singer-profiles-panel',
  imports: [FormsModule, VocalRangeModal],
  templateUrl: './singer-profiles-panel.html',
  styleUrl: './singer-profiles-panel.scss',
})
export class SingerProfilesPanel {
  readonly microphoneDeviceId = input('');
  readonly party = inject(PartySessionService);
  readonly guests = computed(() => this.party.roster().filter((profile) => profile.isGuest));
  readonly voiceTypes = PROFILE_VOICE_TYPES;
  readonly editingProfileId = signal<string | null>(null);
  readonly editName = signal('');
  readonly editColor = signal('#777777');
  readonly editAvatar = signal<string | null>(null);
  readonly editVoiceType = signal<ProfileVoiceType>('Uncalibrated');
  readonly colorPresets = PROFILE_COLOR_PRESETS;
  readonly pendingDeleteId = signal<string | null>(null);
  readonly modalOpen = signal(false);
  readonly modalProfile = signal<UserProfile | null>(null);
  readonly error = signal('');

  startAdding(): void {
    this.error.set('');
    this.modalProfile.set(null);
    this.modalOpen.set(true);
  }

  startRecalibrating(profile: UserProfile): void {
    this.error.set('');
    this.modalProfile.set(profile);
    this.modalOpen.set(true);
  }

  startEditing(profile: UserProfile): void {
    this.error.set('');
    this.editingProfileId.set(profile.id);
    this.editName.set(profile.name);
    this.editColor.set(profile.accentColor);
    this.editAvatar.set(profile.avatar);
    this.editVoiceType.set(profile.voiceType);
  }

  setVoiceType(value: string): void {
    if (PROFILE_VOICE_TYPES.includes(value as ProfileVoiceType)) {
      this.editVoiceType.set(value as ProfileVoiceType);
    }
  }

  saveEdit(): void {
    const profileId = this.editingProfileId();
    const profile = this.party.savedProfiles().find((item) => item.id === profileId);
    const name = this.editName().trim();
    if (!profile || !name) {
      this.error.set('A singer profile needs a name.');
      return;
    }
    try {
      const base = this.editVoiceType() === profile.voiceType
        ? profile
        : createProfileFromPreset(this.editVoiceType(), name, profile.id);
      this.party.saveProfile({
        ...base,
        id: profile.id,
        name,
        initials: initials(name),
        avatar: this.editAvatar(),
        accentColor: this.editColor(),
        isGuest: false,
      });
      this.editingProfileId.set(null);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not save this singer profile.');
    }
  }

  selectEditColor(color: string): void {
    this.editColor.set(color);
  }

  async chooseEditPhoto(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 2_000_000) {
      this.error.set('Choose an image smaller than 2 MB.');
      return;
    }
    try {
      this.editAvatar.set(await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Could not decode the selected photo.')), { once: true });
        reader.addEventListener('error', () => reject(reader.error ?? new Error('Could not read the selected photo.')), { once: true });
        reader.readAsDataURL(file);
      }));
      this.error.set('');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not load the profile photo.');
    }
  }

  requestDelete(profileId: string): void {
    this.pendingDeleteId.set(profileId);
  }

  deleteProfile(profileId: string): void {
    this.party.deleteSavedProfile(profileId);
    this.pendingDeleteId.set(null);
    this.editingProfileId.set(null);
  }

  saveGuest(profileId: string): void {
    try {
      this.party.promoteGuest(profileId);
      this.error.set('');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not save this guest.');
    }
  }

  clearGuests(): void {
    this.party.clearGuests();
  }

  closeModal(): void {
    this.modalOpen.set(false);
    this.modalProfile.set(null);
  }

  profileRange(profile: UserProfile): string {
    return profile.minNote && profile.maxNote
      ? `${profile.minNote} – ${profile.maxNote}`
      : 'Range not set';
  }
}
