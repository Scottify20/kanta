import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  PartySessionService,
  QueueSingerAssignment,
  UserProfile,
  recommendDuetKey,
} from '../../services/party-session.service';
import { SongManifest } from '../../services/songs.service';

@Component({
  selector: 'app-song-assignment-dialog',
  templateUrl: './song-assignment-dialog.html',
  styleUrl: './song-assignment-dialog.scss',
})
export class SongAssignmentDialog {
  readonly song = input.required<SongManifest>();
  readonly isDuet = input(false);
  readonly initialAssignment = input.required<QueueSingerAssignment>();
  readonly batchIndex = input<number>(1);
  readonly batchTotal = input<number>(1);
  readonly headerMode = input(false);
  readonly highlightedPart = input<'primary' | 'secondary' | null>(null);

  readonly confirmed = output<QueueSingerAssignment>();
  readonly dismissed = output<QueueSingerAssignment>();
  readonly assignmentChange = output<QueueSingerAssignment>();

  protected readonly party = inject(PartySessionService);

  readonly primarySingerId = signal<string | null>(null);
  readonly secondarySingerId = signal<string | null>(null);
  readonly prioritySingerId = signal<string | null>(null);
  readonly conflictExpanded = signal(false);
  readonly isClosing = signal(false);

  constructor() {
    effect(() => {
      const init = this.initialAssignment();
      if (!init) return;
      this.primarySingerId.set(init.primarySingerId);
      this.secondarySingerId.set(init.secondarySingerId);
      this.prioritySingerId.set(init.prioritySingerId);
      this.conflictExpanded.set(false);
    });
  }

  readonly currentAssignment = computed<QueueSingerAssignment>(() => ({
    primarySingerId: this.primarySingerId(),
    secondarySingerId: this.secondarySingerId(),
    prioritySingerId: this.prioritySingerId(),
  }));

  readonly primarySinger = computed(() =>
    this.party.roster().find((s) => s.id === this.primarySingerId()) ?? null,
  );
  readonly secondarySinger = computed(() =>
    this.party.roster().find((s) => s.id === this.secondarySingerId()) ?? null,
  );

  readonly batchRemaining = computed(() =>
    Math.max(0, this.batchTotal() - this.batchIndex()),
  );

  /** Uses recommendDuetKey as the single source of truth so all shifts match playback. */
  private readonly duetAnalysis = computed(() => {
    const s = this.song();
    const s1 = this.primarySinger();
    const s2 = this.secondarySinger();
    if (!this.isDuet() || !s || !s1 || !s2) return null;

    const rec = recommendDuetKey({ ...s, is_duet: true }, s1, s2);
    if (!rec || rec.unanalyzed || rec.uncalibrated) return null;

    return {
      shift1: rec.shift1,
      shift2: rec.shift2,
      diff: Math.abs(rec.shift1 - rec.shift2),
      compromise: rec.semitones,
      conflict: rec.conflict,
    };
  });

  readonly hasVocalConflict = computed(() => this.duetAnalysis()?.conflict === true);
  readonly conflictDifference = computed(() => this.duetAnalysis()?.diff ?? 0);

  readonly s1ShiftLabel = computed(() => this.formatShift(this.duetAnalysis()?.shift1 ?? 0));
  readonly s2ShiftLabel = computed(() => this.formatShift(this.duetAnalysis()?.shift2 ?? 0));
  readonly compromiseShiftLabel = computed(() => this.formatShift(this.duetAnalysis()?.compromise ?? 0));

  readonly activeConflictSummary = computed(() => {
    const prio = this.prioritySingerId();
    if (prio === 'original') return 'Original · 0 ST';
    if (prio && prio === this.primarySinger()?.id) {
      return `${this.primarySinger()!.name} · ${this.s1ShiftLabel()}`;
    }
    if (prio && prio === this.secondarySinger()?.id) {
      return `${this.secondarySinger()!.name} · ${this.s2ShiftLabel()}`;
    }
    return `Balanced · ${this.compromiseShiftLabel()}`;
  });

  private formatShift(st: number): string {
    if (st === 0) return '0 ST';
    return `${st > 0 ? '+' : ''}${st} ST`;
  }

  singerInitial(singer: UserProfile | null): string {
    return singer?.initials || singer?.name.slice(0, 1).toUpperCase() || '?';
  }

  rangeLabel(singer: UserProfile | null): string {
    if (!singer || !singer.minNote || !singer.maxNote) return 'Uncalibrated';
    return `${singer.minNote}–${singer.maxNote}`;
  }

  toggleConflictExpanded(): void {
    this.conflictExpanded.update((v) => !v);
  }

  selectSinger(singerId: string | null, part: 'primary' | 'secondary'): void {
    const curPrimary = this.primarySingerId();
    const curSecondary = this.secondarySingerId();

    if (part === 'primary') {
      if (singerId !== null && singerId === curSecondary) {
        this.secondarySingerId.set(curPrimary);
      }
      this.primarySingerId.set(singerId);
    } else {
      if (singerId !== null && singerId === curPrimary) {
        this.primarySingerId.set(curSecondary);
      }
      this.secondarySingerId.set(singerId);
    }
    this.prioritySingerId.set(null);
    this.conflictExpanded.set(false);
    this.assignmentChange.emit(this.currentAssignment());
  }

  swapParts(): void {
    const p = this.primarySingerId();
    const s = this.secondarySingerId();
    if (!p && !s) return;
    this.primarySingerId.set(s);
    this.secondarySingerId.set(p);
    this.prioritySingerId.set(null);
    this.assignmentChange.emit(this.currentAssignment());
  }

  prioritizeSinger(singerId: string | null): void {
    this.prioritySingerId.set(singerId);
    this.assignmentChange.emit(this.currentAssignment());
  }

  confirm(): void {
    if (this.isClosing()) return;
    this.isClosing.set(true);
    setTimeout(() => {
      this.confirmed.emit(this.currentAssignment());
    }, 160);
  }

  dismiss(): void {
    if (this.headerMode() || this.isClosing()) return;
    this.isClosing.set(true);
    setTimeout(() => {
      this.dismissed.emit(this.currentAssignment());
    }, 160);
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event?: Event): void {
    if (this.headerMode()) return;
    event?.preventDefault();
    event?.stopPropagation();
    this.dismiss();
  }
}