import {
  Component,
  TemplateRef,
  ViewContainerRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { NoteSelector } from '../../../../shared/components/note-selector/note-selector';
import {
  PartySessionService,
  ProfileVoiceType,
  UserProfile,
  VOCAL_PROFILE_PRESETS,
  PROFILE_COLOR_PRESETS,
  classifyVocalRange,
  midiToNote,
} from '../../../../shared/services/party-session.service';
import { PopupStateService } from '../../../../shared/services/popup-state.service';
import { QueueService } from '../../../queue/data-access/queue.service';
import { QueueItem } from '../../../queue/interfaces/queue.models';
import { ToastService } from '../../../../shared/services/toast.service';
import { VocalRangeModal } from '../../../settings/ui/vocal-range-modal/vocal-range-modal';

@Component({
  selector: 'app-party-header-strip',
  imports: [PopupPanel, VocalRangeModal, NoteSelector],
  templateUrl: './party-header-strip.html',
  styleUrl: './party-header-strip.scss',
})
export class PartyHeaderStrip {
  readonly queuePreview = input<QueueItem[]>([]);
  readonly playing = input(false);
  readonly currentTime = input(0);
  readonly duration = input(0);

  protected readonly party = inject(PartySessionService);
  private readonly queue = inject(QueueService);
  private readonly popups = inject(PopupStateService);
  private readonly toast = inject(ToastService);
  private readonly overlay = inject(Overlay);
  private readonly viewContainer = inject(ViewContainerRef);

  private readonly singerMenu = viewChild<PopupPanel>('singerMenu');
  private readonly editPopup = viewChild<PopupPanel>('editPopup');
  private readonly calibrationModalTemplate = viewChild<TemplateRef<unknown>>('calibrationModalTemplate');

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

  readonly selectedSinger = signal<UserProfile | null>(null);

  readonly editingProfile = signal<UserProfile | null>(null);
  readonly editNameDraft = signal('');
  readonly editColorDraft = signal('#4a8f8c');
  readonly editVoiceDraft = signal<ProfileVoiceType>('Uncalibrated');
  readonly editAvatarDraft = signal<string | null>(null);
  readonly editLowMidi = signal<number | null>(null);
  readonly editHighMidi = signal<number | null>(null);

  readonly pendingRemoveSinger = signal<UserProfile | null>(null);

  readonly calibratingProfile = signal<UserProfile | null>(null);
  private calibrationOverlayRef: OverlayRef | null = null;
  private calibratingTarget: 'guest-draft' | 'edit-profile' = 'guest-draft';

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
    const currentId = this.party.currentSingerId();
    const current = roster.find((singer) => singer.id === currentId);
    const others = roster.filter((singer) => singer.id !== currentId);
    return [...(current ? [current] : []), ...others.slice(0, 2)];
  });

  readonly hiddenSingers = computed(() => this.party.roster().length - this.visibleSingers().length);

  isCurrentSinger(singerId: string): boolean {
    return this.party.currentSingerId() === singerId;
  }

  singerInitial(profile: UserProfile | null): string {
    return profile?.initials || profile?.name.slice(0, 1).toUpperCase() || '?';
  }

  primarySingerFor(item: QueueItem): UserProfile | null {
    return this.party.queueSinger(item.task_id, 'primary') ?? this.party.activeSinger();
  }

  secondarySingerFor(item: QueueItem): UserProfile | null {
    return this.party.queueSinger(item.task_id, 'secondary');
  }

  isDuetTrack(item: QueueItem): boolean {
    return item.is_duet === true || this.secondarySingerFor(item) !== null;
  }

  upNextSingersLabel(item: QueueItem): string {
    const s1 = this.primarySingerFor(item);
    const s2 = this.secondarySingerFor(item);
    if (s1 && s2) return `${s1.name} & ${s2.name}`;
    return s1?.name ?? 'Singer';
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

  openSingerContextMenu(event: MouseEvent, singer: UserProfile): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedSinger.set(singer);
    this.singerMenu()?.openAt(event);
  }

  startEditingProfile(singer: UserProfile, event: MouseEvent): void {
    this.popups.close('context-menu', 'party-singer-context');
    this.editingProfile.set(singer);
    this.editNameDraft.set(singer.name);
    this.editColorDraft.set(singer.accentColor);
    this.editVoiceDraft.set(singer.voiceType);
    this.editAvatarDraft.set(singer.avatar);

    if (singer.minNote && singer.maxNote) {
      this.editLowMidi.set(singer.minHz ? Math.round(69 + 12 * Math.log2(singer.minHz / 440)) : 48);
      this.editHighMidi.set(singer.maxHz ? Math.round(69 + 12 * Math.log2(singer.maxHz / 440)) : 72);
    } else {
      this.editLowMidi.set(48);
      this.editHighMidi.set(72);
    }

    this.editPopup()?.openAt(event);
  }

  closeEditPopup(): void {
    this.editingProfile.set(null);
    this.popups.close('player', 'party-singer-edit');
  }

  onEditVoiceChange(event: Event): void {
    const voice = (event.target as HTMLSelectElement).value as ProfileVoiceType;
    this.editVoiceDraft.set(voice);
    const preset = VOCAL_PROFILE_PRESETS.find((p) => p.voiceType === voice);
    if (preset?.minHz && preset.maxHz) {
      this.editLowMidi.set(Math.round(69 + 12 * Math.log2(preset.minHz / 440)));
      this.editHighMidi.set(Math.round(69 + 12 * Math.log2(preset.maxHz / 440)));
    }
  }

  async saveProfileEdit(): Promise<void> {
    const profile = this.editingProfile();
    const name = this.editNameDraft().trim();
    if (!profile || !name) return;

    const low = this.editLowMidi();
    const high = this.editHighMidi();
    let minHz: number | null = profile.minHz;
    let maxHz: number | null = profile.maxHz;
    let minNote: string | null = profile.minNote;
    let maxNote: string | null = profile.maxNote;
    let tessituraMinHz: number | null = profile.tessituraMinHz;
    let tessituraMaxHz: number | null = profile.tessituraMaxHz;
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
      ...profile,
      name,
      initials: name.trim().split(/\s+/).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?',
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
      if (profile.isGuest) this.party.updateGuestProfile(updated);
      else this.party.saveProfile(updated);
      this.closeEditPopup();
      this.toast.success('Profile updated.');
    } catch {
      this.toast.error('Could not save profile.');
    }
  }

  async chooseEditPhoto(event: Event): Promise<void> {
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

  makeGuestPermanent(profile: UserProfile): void {
    this.popups.closeAll();
    try {
      this.party.promoteGuest(profile.id);
      this.toast.success(`${profile.name} is now saved permanently.`);
    } catch {
      this.toast.error('Could not make profile permanent.');
    }
  }

  promptRemoveSinger(singer: UserProfile): void {
    this.popups.closeAll();
    this.pendingRemoveSinger.set(singer);
  }

  cancelRemoveSinger(): void {
    this.pendingRemoveSinger.set(null);
  }

  singerAssignedSongs(singerId: string): QueueItem[] {
    const assignments = this.party.queueAssignments();
    const taskIds = new Set(
      Object.entries(assignments)
        .filter(([_, a]) => a.primarySingerId === singerId || a.secondarySingerId === singerId)
        .map(([id]) => id),
    );
    return this.queuePreview().filter((track) => taskIds.has(track.task_id));
  }

  confirmRemoveSinger(singerId: string): void {
    const singer = this.pendingRemoveSinger();
    this.pendingRemoveSinger.set(null);
    if (!singer) return;

    const songs = this.singerAssignedSongs(singerId);
    const removed = this.party.removeSinger(singerId);
    if (!removed) {
      this.toast.error('Cannot remove the host singer.');
      return;
    }

    for (const song of songs) {
      this.queue.removeKaraokeTrack(song.task_id).subscribe();
    }

    const count = songs.length;
    this.toast.success(
      `Removed ${singer.name}${count > 0 ? ` and ${count} assigned song${count === 1 ? '' : 's'}` : ''}.`,
    );
  }

  openCalibrationForGuestDraft(): void {
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
    this.calibratingTarget = 'guest-draft';
    this.calibratingProfile.set(draft);
    this.showCalibrationOverlay();
  }

  openCalibrationForEdit(profile: UserProfile): void {
    this.calibratingTarget = 'edit-profile';
    this.calibratingProfile.set(profile);
    this.showCalibrationOverlay();
  }

  private showCalibrationOverlay(): void {
    const template = this.calibrationModalTemplate();
    if (!template) return;

    if (!this.calibrationOverlayRef) {
      this.calibrationOverlayRef = this.overlay.create({
        hasBackdrop: false,
        positionStrategy: this.overlay.position().global(),
        scrollStrategy: this.overlay.scrollStrategies.noop(),
        panelClass: 'kanta-calibration-pane',
      });
    }

    if (!this.calibrationOverlayRef.hasAttached()) {
      this.calibrationOverlayRef.attach(new TemplatePortal(template, this.viewContainer));
    }
  }

  onRangeCalibrated(calibrated: UserProfile): void {
    if (this.calibratingTarget === 'guest-draft') {
      this.guestVoice.set(calibrated.voiceType);
      this.guestCalibratedRange.set({
        minHz: calibrated.minHz,
        maxHz: calibrated.maxHz,
        minNote: calibrated.minNote,
        maxNote: calibrated.maxNote,
        tessituraMinHz: calibrated.tessituraMinHz,
        tessituraMaxHz: calibrated.tessituraMaxHz,
      });
      this.toast.success(`Range calibrated: ${calibrated.minNote}–${calibrated.maxNote} (${calibrated.voiceType})`);
    } else {
      this.editVoiceDraft.set(calibrated.voiceType);
      if (calibrated.minHz && calibrated.maxHz) {
        this.editLowMidi.set(Math.round(69 + 12 * Math.log2(calibrated.minHz / 440)));
        this.editHighMidi.set(Math.round(69 + 12 * Math.log2(calibrated.maxHz / 440)));
      }
    }
  }

  closeCalibration(): void {
    this.calibrationOverlayRef?.detach();
    this.calibrationOverlayRef?.dispose();
    this.calibrationOverlayRef = null;
    this.calibratingProfile.set(null);
  }

  selectedMicrophoneId(): string {
    try {
      return globalThis.localStorage?.getItem('kanta.microphoneDeviceId') ?? '';
    } catch {
      return '';
    }
  }

  rangeLabel(profile: UserProfile): string {
    return profile.minNote && profile.maxNote ? `${profile.minNote}–${profile.maxNote}` : 'Uncalibrated';
  }

  isVisibleSinger(singerId: string): boolean {
    return this.visibleSingers().some((singer) => singer.id === singerId);
  }

  private readPhoto(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('Photo decode error.'));
      }, { once: true });
      reader.addEventListener('error', () => reject(reader.error ?? new Error('Photo read error.')), { once: true });
      reader.readAsDataURL(file);
    });
  }
}