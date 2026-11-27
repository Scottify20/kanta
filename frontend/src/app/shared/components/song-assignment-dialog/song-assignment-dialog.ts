import {
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  PartySessionService,
  QueueSingerAssignment,
  UserProfile,
  recommendSoloKey,
  recommendDuetKey,
} from '../../services/party-session.service';
import { SongManifest } from '../../services/songs.service';

@Component({
  selector: 'app-song-assignment-dialog',
  templateUrl: './song-assignment-dialog.html',
  styleUrl: './song-assignment-dialog.scss',
})
export class SongAssignmentDialog implements OnInit {
  readonly song = input.required<SongManifest>();
  readonly isDuet = input(false);
  readonly initialAssignment = input.required<QueueSingerAssignment>();
  readonly batchIndex = input<number>(1);
  readonly batchTotal = input<number>(1);

  readonly confirmed = output<QueueSingerAssignment>();
  readonly dismissed = output<QueueSingerAssignment>();

  protected readonly party = inject(PartySessionService);

  readonly primarySingerId = signal<string | null>(null);
  readonly secondarySingerId = signal<string | null>(null);
  readonly prioritySingerId = signal<string | null>(null);

  readonly primaryDropdownOpen = signal(false);
  readonly secondaryDropdownOpen = signal(false);
  readonly isClosing = signal(false);

  ngOnInit(): void {
    const init = this.initialAssignment();
    if (init) {
      this.primarySingerId.set(init.primarySingerId);
      this.secondarySingerId.set(init.secondarySingerId);
      this.prioritySingerId.set(init.prioritySingerId);
    }
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

  readonly isCompactRow = computed(() => this.party.roster().length <= 3);

  readonly batchRemaining = computed(() =>
    Math.max(0, this.batchTotal() - this.batchIndex()),
  );

  readonly recommendation = computed(() => {
    const s = this.song();
    const primary = this.primarySinger();
    if (!s || !primary) return null;
    const secondary = this.secondarySinger();
    if (this.isDuet() && secondary) {
      return recommendDuetKey(s, primary, secondary);
    }
    return recommendSoloKey(s, primary);
  });

  readonly hasVocalConflict = computed(() => {
    const rec = this.recommendation();
    return !!(rec && rec.kind === 'duet' && rec.conflict && this.primarySinger() && this.secondarySinger());
  });

  readonly conflictDifference = computed(() => {
    const rec = this.recommendation();
    if (!rec || rec.kind !== 'duet') return 0;
    return Math.abs(rec.shift1 - rec.shift2);
  });

  readonly s1ShiftLabel = computed(() => {
    const s = this.song();
    const s1 = this.primarySinger();
    if (!s || !s1) return '0 ST';
    const shift = recommendSoloKey(s, s1).semitones;
    return `${shift > 0 ? '+' : ''}${shift} ST`;
  });

  readonly s2ShiftLabel = computed(() => {
    const s = this.song();
    const s2 = this.secondarySinger();
    if (!s || !s2) return '0 ST';
    const shift = recommendSoloKey(s, s2).semitones;
    return `${shift > 0 ? '+' : ''}${shift} ST`;
  });

  readonly compromiseShiftLabel = computed(() => {
    const rec = this.recommendation();
    if (!rec || rec.kind !== 'duet') return '0 ST';
    const avg = Math.round((rec.shift1 + rec.shift2) / 2);
    return `${avg > 0 ? '+' : ''}${avg} ST`;
  });

  singerInitial(singer: UserProfile | null): string {
    return singer?.initials || singer?.name.slice(0, 1).toUpperCase() || '?';
  }

  rangeLabel(singer: UserProfile | null): string {
    if (!singer || !singer.minNote || !singer.maxNote) return 'Uncalibrated';
    return `${singer.minNote}–${singer.maxNote}`;
  }

  toggleDropdown(part: 'primary' | 'secondary'): void {
    if (part === 'primary') {
      this.primaryDropdownOpen.update((v) => !v);
      this.secondaryDropdownOpen.set(false);
    } else {
      this.secondaryDropdownOpen.update((v) => !v);
      this.primaryDropdownOpen.set(false);
    }
  }

  selectSinger(singerId: string | null, part: 'primary' | 'secondary'): void {
    if (part === 'primary') {
      this.primarySingerId.set(singerId);
      this.primaryDropdownOpen.set(false);
    } else {
      this.secondarySingerId.set(singerId);
      this.secondaryDropdownOpen.set(false);
    }
  }

  canAssign(singer: UserProfile, part: 'primary' | 'secondary'): boolean {
    const otherId = part === 'primary' ? this.secondarySingerId() : this.primarySingerId();
    return singer.id !== otherId;
  }

  prioritizeSinger(singerId: string | null): void {
    this.prioritySingerId.set(singerId);
  }

  confirm(): void {
    if (this.isClosing()) return;
    this.isClosing.set(true);
    setTimeout(() => {
      this.confirmed.emit(this.currentAssignment());
    }, 180);
  }

  dismiss(): void {
    if (this.isClosing()) return;
    this.isClosing.set(true);
    setTimeout(() => {
      this.dismissed.emit(this.currentAssignment());
    }, 180);
  }

@HostListener('document:keydown.escape', ['$event'])
  onEscape(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.primaryDropdownOpen() || this.secondaryDropdownOpen()) {
      this.primaryDropdownOpen.set(false);
      this.secondaryDropdownOpen.set(false);
    } else {
      this.dismiss();
    }
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.custom-select-container')) {
      this.primaryDropdownOpen.set(false);
      this.secondaryDropdownOpen.set(false);
    }
  }
}