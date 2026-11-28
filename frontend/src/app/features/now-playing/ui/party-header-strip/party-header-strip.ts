import {
  Component,
  DestroyRef,
  TemplateRef,
  ViewContainerRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';

import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { SongAssignmentDialog } from '../../../../shared/components/song-assignment-dialog/song-assignment-dialog';
import { PopupStateService } from '../../../../shared/services/popup-state.service';
import {
  PartySessionService,
  QueueSingerAssignment,
  UserProfile,
} from '../../../../shared/services/party-session.service';
import { SongsService } from '../../../../shared/services/songs.service';
import { QueueService } from '../../../queue/data-access/queue.service';
import { QueueItem } from '../../../queue/interfaces/queue.models';
import { ToastService } from '../../../../shared/services/toast.service';
import { VocalRangeModal } from '../../../settings/ui/vocal-range-modal/vocal-range-modal';

import { PartyQueuePreview } from './party-queue-preview/party-queue-preview';
import { PartyAddSinger } from './party-add-singer/party-add-singer';
import { PartyEditSinger } from './party-edit-singer/party-edit-singer';
import { PartyRemoveSinger } from './party-remove-singer/party-remove-singer';

let hasAnimatedInitialRoster = false;

@Component({
  selector: 'app-party-header-strip',
  imports: [
    PopupPanel,
    SongAssignmentDialog,
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
  private readonly songs = inject(SongsService);
  private readonly queue = inject(QueueService);
  private readonly popups = inject(PopupStateService);
  private readonly toast = inject(ToastService);
  private readonly overlay = inject(Overlay);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly queueSnapshot = toSignal(this.queue.queue$, { initialValue: null });

  private readonly singerMenu = viewChild<PopupPanel>('singerMenu');
  private readonly songAssignMenu = viewChild<PopupPanel>('songAssignMenu');
  private readonly editSingerComponent = viewChild(PartyEditSinger);
  private readonly addSingerComponent = viewChild(PartyAddSinger);
  private readonly removeSingerComponent = viewChild(PartyRemoveSinger);
  private readonly calibrationModalTemplate = viewChild<TemplateRef<unknown>>('calibrationModalTemplate');

  readonly selectedSinger = signal<UserProfile | null>(null);
  readonly editingProfile = signal<UserProfile | null>(null);

  readonly addedSingerIds = signal<ReadonlySet<string>>(new Set());
  readonly activatingSingerId = signal<string | null>(null);

  readonly calibratingProfile = signal<UserProfile | null>(null);
  private calibrationOverlayRef: OverlayRef | null = null;
  private calibratingTarget: 'guest-draft' | 'edit-profile' = 'guest-draft';

  private rosterInitialized = false;
  private previousRoster: UserProfile[] = [];
  private addTimer: ReturnType<typeof setTimeout> | null = null;
  private activateTimer: ReturnType<typeof setTimeout> | null = null;

  readonly currentSong = this.songs.currentSong;

  readonly mergedDuetSingers = computed<{ primary: UserProfile; secondary: UserProfile } | null>(() => {
    const song = this.currentSong();
    if (!song?.is_duet) return null;
    const primary = this.party.currentSinger();
    const secondary = this.party.currentDuetSinger();
    if (!primary || !secondary || primary.id === secondary.id) return null;
    return { primary, secondary };
  });

  readonly activeSoloSinger = computed<UserProfile | null>(() => {
    if (this.mergedDuetSingers()) return null;
    return this.party.currentSinger() ?? this.party.roster()[0] ?? null;
  });

  readonly inactiveSingers = computed<UserProfile[]>(() => {
    const roster = this.party.roster();
    const duet = this.mergedDuetSingers();
    if (duet) {
      return roster.filter((s) => s.id !== duet.primary.id && s.id !== duet.secondary.id);
    }
    const active = this.activeSoloSinger();
    return active ? roster.filter((s) => s.id !== active.id) : roster;
  });

  readonly currentSongAssignment = computed<QueueSingerAssignment>(() => {
    const taskId = this.songs.currentQueueTaskId();
    if (taskId) return this.party.queueAssignment(taskId);
    const duet = this.mergedDuetSingers();
    if (duet) {
      return {
        primarySingerId: duet.primary.id,
        secondarySingerId: duet.secondary.id,
        prioritySingerId: null,
      };
    }
    return {
      primarySingerId: this.activeSoloSinger()?.id ?? null,
      secondarySingerId: null,
      prioritySingerId: null,
    };
  });

  constructor() {
    effect(() => {
      const current = this.party.roster();
      untracked(() => {
        if (!this.rosterInitialized) {
          this.rosterInitialized = true;
          this.previousRoster = current;
          if (!hasAnimatedInitialRoster && current.length) {
            hasAnimatedInitialRoster = true;
            this.addedSingerIds.set(new Set(current.map((s) => s.id)));
            if (this.addTimer) clearTimeout(this.addTimer);
            this.addTimer = setTimeout(() => {
              this.addedSingerIds.set(new Set());
              this.addTimer = null;
            }, 380);
          }
          return;
        }
        hasAnimatedInitialRoster = true;
        const prevIds = new Set(this.previousRoster.map((s) => s.id));
        const added = current.filter((s) => !prevIds.has(s.id)).map((s) => s.id);
        this.previousRoster = current;

        if (added.length) {
          this.addedSingerIds.set(new Set(added));
          if (this.addTimer) clearTimeout(this.addTimer);
          this.addTimer = setTimeout(() => {
            this.addedSingerIds.set(new Set());
            this.addTimer = null;
          }, 380);
        }
      });
    });

    this.destroyRef.onDestroy(() => {
      if (this.addTimer) clearTimeout(this.addTimer);
      if (this.activateTimer) clearTimeout(this.activateTimer);
    });
  }

  singerInitial(profile: UserProfile | null): string {
    return profile?.initials || profile?.name.slice(0, 1).toUpperCase() || '?';
  }

  rangeLabel(profile: UserProfile): string {
    return profile.minNote && profile.maxNote ? `${profile.minNote}–${profile.maxNote}` : 'Uncalibrated';
  }

  private pulseSelection(id: string): void {
    this.activatingSingerId.set(id);
    if (this.activateTimer) clearTimeout(this.activateTimer);
    this.activateTimer = setTimeout(() => {
      this.activatingSingerId.set(null);
      this.activateTimer = null;
    }, 360);
  }

  openAssignPopover(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.currentSong()) return;
    this.songAssignMenu()?.openAt(event);
  }

  onHeaderAssignmentChange(assignment: QueueSingerAssignment): void {
    const taskId = this.songs.currentQueueTaskId();
    if (taskId) {
      this.party.setExplicitQueueAssignment(taskId, assignment);
    } else if (assignment.primarySingerId) {
      this.party.setActiveSinger(assignment.primarySingerId);
    }
    this.pulseSelection(this.mergedDuetSingers() ? 'duet-merged' : (assignment.primarySingerId ?? 'active'));
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
    const allItems = this.queueSnapshot()?.karaoke_queue ?? this.queuePreview();
    return allItems.filter((track) => taskIds.has(track.task_id));
  }

  confirmRemoveSinger(singerId: string): void {
    const songs = this.singerAssignedSongs(singerId);
    const removed = this.party.removeSinger(singerId);
    if (!removed) {
      this.toast.error('Could not remove singer.');
      return;
    }
    for (const song of songs) {
      this.queue.removeKaraokeTrack(song.task_id).subscribe({
        error: () => this.toast.error(`Could not remove “${song.raw_title || song.title}” from queue.`),
      });
    }
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