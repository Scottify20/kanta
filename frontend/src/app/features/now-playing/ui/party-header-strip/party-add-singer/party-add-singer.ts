import { Component, computed, inject, output, signal } from '@angular/core';
import { PopupPanel } from '../../../../../shared/components/popup-panel/popup-panel';
import { PopupStateService } from '../../../../../shared/services/popup-state.service';
import {
  PartySessionService,
  ProfileVoiceType,
  UserProfile,
  PROFILE_COLOR_PRESETS,
  VOCAL_PROFILE_PRESETS,
} from '../../../../../shared/services/party-session.service';
import { ToastService } from '../../../../../shared/services/toast.service';

@Component({
  selector: 'app-party-add-singer',
  imports: [PopupPanel],
  templateUrl: './party-add-singer.html',
  styleUrl: './party-add-singer.scss',
})
export class PartyAddSinger {
  readonly calibrateRequested = output<UserProfile>();

  protected readonly party = inject(PartySessionService);
  private readonly popups = inject(PopupStateService);
  private readonly toast = inject(ToastService);

  readonly guestName = signal('');
  readonly guestColor = signal('#4a8f8c');
  readonly guestVoice = signal<ProfileVoiceType>('Uncalibrated');
  readonly guestAvatar = signal<string | null>(null);
  readonly guestColorPresets = PROFILE_COLOR_PRESETS;
  readonly guestCalibratedRange = signal<{
    minHz: number | null;
    maxHz: number | null;
    minNote: string | null;
    maxNote: string | null;
    tessituraMinHz: number | null;
    tessituraMaxHz: number | null;
  } | null>(null);

  readonly voiceOptions: ProfileVoiceType[] = [
    'Uncalibrated',
    ...VOCAL_PROFILE_PRESETS.map((preset) => preset.voiceType),
  ];

  readonly savedProfilesNotInRoom = computed(() => {
    const inRoom = new Set(this.party.roster().map((p) => p.id));
    return this.party.savedProfiles().filter((p) => !inRoom.has(p.id));
  });

  singerInitial(profile: UserProfile): string {
    return profile.initials || profile.name.slice(0, 1).toUpperCase() || '?';
  }

  addSavedProfile(profileId: string): void {
    try {
      this.party.addSavedProfile(profileId);
    } catch {
      this.toast.error('Could not add singer to the session.');
    }
  }

  addGuest(): void {
    try {
      this.party.quickAddGuest(
        this.guestName(),
        this.guestVoice(),
        this.guestColor(),
        this.guestAvatar(),
        this.guestCalibratedRange(),
      );
      this.guestName.set('');
      this.guestAvatar.set(null);
      this.guestCalibratedRange.set(null);
      this.popups.close('player', 'party-roster-add');
      this.toast.success('Guest added to party session.');
    } catch {
      this.toast.error('Could not add guest.');
    }
  }

  updateGuestName(event: Event): void {
    this.guestName.set((event.target as HTMLInputElement).value);
  }

  selectGuestColor(color: string): void {
    this.guestColor.set(color);
  }

  updateGuestVoice(event: Event): void {
    const voice = (event.target as HTMLSelectElement).value as ProfileVoiceType;
    this.guestVoice.set(voice);
    const preset = VOCAL_PROFILE_PRESETS.find((p) => p.voiceType === voice);
    if (preset?.minHz && preset.maxHz) {
      this.guestCalibratedRange.set({
        minHz: preset.minHz,
        maxHz: preset.maxHz,
        minNote: preset.minNote,
        maxNote: preset.maxNote,
        tessituraMinHz: preset.tessituraMinHz,
        tessituraMaxHz: preset.tessituraMaxHz,
      });
    }
  }

  async chooseGuestPhoto(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.toast.error('Choose an image file.');
      return;
    }
    if (file.size > 2_000_000) {
      this.toast.error('Image must be smaller than 2 MB.');
      return;
    }
    try {
      this.guestAvatar.set(await this.readPhoto(file));
    } catch {
      this.toast.error('Could not load photo.');
    }
  }

  openCalibration(): void {
    const draft: UserProfile = {
      id: 'draft-guest',
      name: this.guestName().trim() || 'Guest',
      avatar: this.guestAvatar(),
      initials: this.guestName().trim().slice(0, 2).toUpperCase() || 'G',
      accentColor: this.guestColor(),
      voiceType: this.guestVoice(),
      minHz: null,
      maxHz: null,
      minNote: null,
      maxNote: null,
      tessituraMinHz: null,
      tessituraMaxHz: null,
      isGuest: true,
    };
    this.calibrateRequested.emit(draft);
  }

  applyCalibration(calibrated: UserProfile): void {
    this.guestVoice.set(calibrated.voiceType);
    this.guestCalibratedRange.set({
      minHz: calibrated.minHz,
      maxHz: calibrated.maxHz,
      minNote: calibrated.minNote,
      maxNote: calibrated.maxNote,
      tessituraMinHz: calibrated.tessituraMinHz,
      tessituraMaxHz: calibrated.tessituraMaxHz,
    });
  }

  private readPhoto(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result as string), { once: true });
      reader.addEventListener('error', () => reject(reader.error), { once: true });
      reader.readAsDataURL(file);
    });
  }
}