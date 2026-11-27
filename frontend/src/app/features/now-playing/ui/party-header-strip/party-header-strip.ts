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
import { PopupStateService } from '../../../../shared/services/popup-state.service';
import { PartySessionService, UserProfile } from '../../../../shared/services/party-session.service';
import { QueueService } from '../../../queue/data-access/queue.service';
import { QueueItem } from '../../../queue/interfaces/queue.models';
import { ToastService } from '../../../../shared/services/toast.service';
import { VocalRangeModal } from '../../../settings/ui/vocal-range-modal/vocal-range-modal';

import { PartyQueuePreview } from './party-queue-preview/party-queue-preview';
import { PartyAddSinger } from './party-add-singer/party-add-singer';
import { PartyEditSinger } from './party-edit-singer/party-edit-singer';
import { PartyRemoveSinger } from './party-remove-singer/party-remove-singer';

@Component({
  selector: 'app-party-header-strip',
  imports: [
    PopupPanel,
    VocalRangeModal,
    PartyQueuePreview,
    PartyAddSinger,
    PartyEditSinger,
    PartyRemoveSinger,
  ],
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
  private readonly editSingerComponent = viewChild(PartyEditSinger);
  private readonly addSingerComponent = viewChild(PartyAddSinger);
  private readonly removeSingerComponent = viewChild(PartyRemoveSinger);
  private readonly calibrationModalTemplate = viewChild<TemplateRef<unknown>>('calibrationModalTemplate');

  readonly selectedSinger = signal<UserProfile | null>(null);
  readonly editingProfile = signal<UserProfile | null>(null);

  readonly calibratingProfile = signal<UserProfile | null>(null);
  private calibrationOverlayRef: OverlayRef | null = null;
  private calibratingTarget: 'guest-draft' | 'edit-profile' = 'guest-draft';

  readonly visibleSingers = computed(() => {
    const roster = this.party.roster();
    const currentId = this.party.currentSingerId();
    const current = roster.find((s) => s.id === currentId);
    const others = roster.filter((s) => s.id !== currentId);
    return [...(current ? [current] : []), ...others.slice(0, 2)];
  });

  readonly hiddenSingers = computed(() => this.party.roster().length - this.visibleSingers().length);

  isCurrentSinger(singerId: string): boolean {
    return this.party.currentSingerId() === singerId;
  }

  singerInitial(profile: UserProfile | null): string {
    return profile?.initials || profile?.name.slice(0, 1).toUpperCase() || '?';
  }

  rangeLabel(profile: UserProfile): string {
    return profile.minNote && profile.maxNote ? `${profile.minNote}–${profile.maxNote}` : 'Uncalibrated';
  }

  isVisibleSinger(singerId: string): boolean {
    return this.visibleSingers().some((s) => s.id === singerId);
  }

  selectSinger(profileId: string): void {
    this.party.setActiveSinger(profileId);
  }

  openSingerContextMenu(event: MouseEvent, singer: UserProfile): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedSinger.set(singer);
    this.singerMenu()?.openAt(event);
  }

  startEditingProfile(singer: UserProfile, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.popups.close('context-menu', 'party-singer-context');
    this.editingProfile.set(singer);
    setTimeout(() => {
      this.editSingerComponent()?.openAt(event);
    }, 0);
  }

  promptRemoveSinger(singer: UserProfile, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.popups.close('context-menu', 'party-singer-context');
    const songs = this.singerAssignedSongs(singer.id);
    setTimeout(() => {
      this.removeSingerComponent()?.open(singer, songs, event);
    }, 0);
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
      `Removed singer${count > 0 ? ` and ${count} assigned song${count === 1 ? '' : 's'}` : ''}.`,
    );
  }

  openCalibration(profile: UserProfile, target: 'guest-draft' | 'edit-profile'): void {
    this.calibratingTarget = target;
    this.calibratingProfile.set(profile);
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
      this.addSingerComponent()?.applyCalibration(calibrated);
      this.toast.success(`Range calibrated: ${calibrated.minNote}–${calibrated.maxNote} (${calibrated.voiceType})`);
    } else {
      this.editSingerComponent()?.applyCalibration(calibrated);
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
}