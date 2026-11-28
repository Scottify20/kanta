import { Component, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { ColorPicker } from '../../../../../shared/components/color-picker/color-picker';
import { Dropdown, DropdownOption } from '../../../../../shared/components/dropdown/dropdown';
import { NoteSelector } from '../../../../../shared/components/note-selector/note-selector';
import { PopupPanel } from '../../../../../shared/components/popup-panel/popup-panel';
import {
  PartySessionService,
  ProfileVoiceType,
  UserProfile,
  PROFILE_COLOR_PRESETS,
  VOCAL_PROFILE_PRESETS,
  classifyVocalRange,
  midiToNote,
} from '../../../../../shared/services/party-session.service';
import { ToastService } from '../../../../../shared/services/toast.service';

@Component({
  selector: 'app-party-edit-singer',
  imports: [PopupPanel, NoteSelector, Dropdown, ColorPicker],
  templateUrl: './party-edit-singer.html',
  styleUrl: './party-edit-singer.scss',
})
export class PartyEditSinger {
  readonly profile = input<UserProfile | null>(null);

  readonly close = output<void>();
  readonly calibrateRequested = output<UserProfile>();

  private readonly party = inject(PartySessionService);
  private readonly toast = inject(ToastService);
  private readonly popup = viewChild.required(PopupPanel);

  readonly editNameDraft = signal('');
  readonly editColorDraft = signal('#4a8f8c');
  readonly editVoiceDraft = signal<ProfileVoiceType>('Uncalibrated');
  readonly editAvatarDraft = signal<string | null>(null);
  readonly editLowMidi = signal<number | null>(null);
  readonly editHighMidi = signal<number | null>(null);

  readonly guestColorPresets = PROFILE_COLOR_PRESETS;
  readonly voiceOptions: ProfileVoiceType[] = [
    'Uncalibrated',
    ...VOCAL_PROFILE_PRESETS.map((p) => p.voiceType),
  ];

  readonly voiceDropdownOptions: readonly DropdownOption<ProfileVoiceType>[] =
    this.voiceOptions.map((voice) => ({ value: voice, label: voice }));

  constructor() {
    effect(() => {
      const p = this.profile();
      if (!p) return;
      this.editNameDraft.set(p.name);
      this.editColorDraft.set(p.accentColor);
      this.editVoiceDraft.set(p.voiceType);
      this.editAvatarDraft.set(p.avatar);
      if (p.minNote && p.maxNote) {
        this.editLowMidi.set(p.minHz ? Math.round(69 + 12 * Math.log2(p.minHz / 440)) : 48);
        this.editHighMidi.set(p.maxHz ? Math.round(69 + 12 * Math.log2(p.maxHz / 440)) : 72);
      } else {
        this.editLowMidi.set(48);
        this.editHighMidi.set(72);
      }
    });
  }

  openAt(event: MouseEvent): void {
    this.popup().openAt(event);
  }

  singerInitial(profile: UserProfile): string {
    return profile.initials || profile.name.slice(0, 1).toUpperCase() || '?';
  }

  setVoiceDraft(voice: ProfileVoiceType): void {
    this.editVoiceDraft.set(voice);
    const preset = VOCAL_PROFILE_PRESETS.find((p) => p.voiceType === voice);
    if (preset?.minHz && preset.maxHz) {
      this.editLowMidi.set(Math.round(69 + 12 * Math.log2(preset.minHz / 440)));
      this.editHighMidi.set(Math.round(69 + 12 * Math.log2(preset.maxHz / 440)));
    }
  }

  async save(): Promise<void> {
    const p = this.profile();
    const name = this.editNameDraft().trim();
    if (!p || !name) return;

    const low = this.editLowMidi();
    const high = this.editHighMidi();
    let minHz: number | null = p.minHz;
    let maxHz: number | null = p.maxHz;
    let minNote: string | null = p.minNote;
    let maxNote: string | null = p.maxNote;
    let tessituraMinHz: number | null = p.tessituraMinHz;
    let tessituraMaxHz: number | null = p.tessituraMaxHz;
    let voiceType = this.editVoiceDraft();

    if (low !== null && high !== null && low < high) {
      minHz = 440 * 2 ** ((low - 69) / 12);
      maxHz = 440 * 2 ** ((high - 69) / 12);
      minNote = midiToNote(low);
      maxNote = midiToNote(high);
      const span = high - low;
      tessituraMinHz = 440 * 2 ** ((low + span * 0.175 - 69) / 12);
      tessituraMaxHz = 440 * 2 ** ((high - span * 0.175 - 69) / 12);
      voiceType = classifyVocalRange(low, high);
    }

    const updated: UserProfile = {
      ...p,
      name,
      initials: name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?',
      accentColor: this.editColorDraft(),
      avatar: this.editAvatarDraft(),
      voiceType,
      minHz,
      maxHz,
      minNote,
      maxNote,
      tessituraMinHz,
      tessituraMaxHz,
    };

    try {
      if (p.isGuest) this.party.updateGuestProfile(updated);
      else this.party.saveProfile(updated);
      this.close.emit();
      this.toast.success('Profile updated.');
    } catch {
      this.toast.error('Could not save profile.');
    }
  }

  async choosePhoto(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 2_000_000) {
      this.toast.error('Image must be smaller than 2 MB.');
      return;
    }
    try {
      this.editAvatarDraft.set(await this.readPhoto(file));
    } catch {
      this.toast.error('Could not load photo.');
    }
  }

  openCalibration(): void {
    const p = this.profile();
    if (p) this.calibrateRequested.emit(p);
  }

  applyCalibration(calibrated: UserProfile): void {
    this.editVoiceDraft.set(calibrated.voiceType);
    if (calibrated.minHz && calibrated.maxHz) {
      this.editLowMidi.set(Math.round(69 + 12 * Math.log2(calibrated.minHz / 440)));
      this.editHighMidi.set(Math.round(69 + 12 * Math.log2(calibrated.maxHz / 440)));
    }
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