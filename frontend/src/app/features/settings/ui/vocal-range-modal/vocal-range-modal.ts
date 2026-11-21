import { Component, HostListener, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideArrowLeft, LucideMic, LucideX } from '@lucide/angular';
import { YIN } from 'pitchfinder';
import { MicTestService } from '../mic-test/mic-test.service';
import { SettingsOption, SettingsOptionGroup } from '../../../../shared/components/settings-option-group/settings-option-group';
import {
  createProfileFromPreset,
  PartySessionService,
  VOCAL_PROFILE_PRESETS,
} from '../../../../shared/services/party-session.service';
import type { ProfileVoiceType, UserProfile } from '../../../../shared/services/party-session.service';

const MIN_FREQUENCY_HZ = 40;
const MAX_FREQUENCY_HZ = 1200;
const NOISE_CHECK_MS = 2000;
const HOLD_CONFIRMATION_MS = 600;
const PITCH_UPDATE_INTERVAL_MS = 50;
const NOISE_GATE_FLOOR = 0.008;
const NOISE_GATE_MULTIPLIER = 2.5;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const HOLD_RING_CIRCUMFERENCE = 2 * Math.PI * 17;

export type VocalRangeStep = 'lowest' | 'highest';
export type VocalRangeView = 'measure' | 'presets' | 'result';

export interface NoteHoldGateState {
  candidateMidi: number | null;
  heldSinceMs: number | null;
  progress: number;
  lockedMidi: number | null;
}

export const EMPTY_NOTE_HOLD_GATE: NoteHoldGateState = {
  candidateMidi: null,
  heldSinceMs: null,
  progress: 0,
  lockedMidi: null,
};

export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function frequencyToMidi(frequency: number): number {
  return 69 + 12 * Math.log2(frequency / 440);
}

export function midiToNote(midi: number): string {
  const note = Math.round(midi);
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export function calculateNoiseGateRms(readings: number[]): number {
  const sorted = readings.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NOISE_GATE_FLOOR;
  const percentile90 = sorted[Math.floor((sorted.length - 1) * 0.9)];
  return Math.max(NOISE_GATE_FLOOR, percentile90 * NOISE_GATE_MULTIPLIER);
}

export function advanceNoteHoldGate(
  state: NoteHoldGateState,
  frequency: number | null,
  nowMs: number,
): NoteHoldGateState {
  if (
    frequency == null
    || !Number.isFinite(frequency)
    || frequency < MIN_FREQUENCY_HZ
    || frequency > MAX_FREQUENCY_HZ
  ) return EMPTY_NOTE_HOLD_GATE;
  if (state.lockedMidi !== null) return state;

  const candidateMidi = Math.round(frequencyToMidi(frequency));
  const centsFromNote = 1200 * Math.log2(frequency / midiToFrequency(candidateMidi));
  if (Math.abs(centsFromNote) > 50) return EMPTY_NOTE_HOLD_GATE;

  const heldSinceMs = state.candidateMidi === candidateMidi && state.heldSinceMs !== null
    ? state.heldSinceMs
    : nowMs;
  const progress = Math.min(1, Math.max(0, (nowMs - heldSinceMs) / HOLD_CONFIRMATION_MS));
  const lockedMidi = progress >= 1 ? candidateMidi : null;
  return { candidateMidi, heldSinceMs, progress, lockedMidi };
}

function rangeRailPosition(frequency: number): number {
  const range = Math.log2(MAX_FREQUENCY_HZ / MIN_FREQUENCY_HZ);
  return Math.max(0, Math.min(100, (Math.log2(frequency / MIN_FREQUENCY_HZ) / range) * 100));
}

function getInitials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0].toUpperCase()).join('') || '?';
}

function getVoiceType(lowMidi: number, highMidi: number): ProfileVoiceType {
  const tessituraMidpoint = (lowMidi + highMidi) / 2;
  if (tessituraMidpoint < 48) return 'Bass';
  if (tessituraMidpoint < 53) return 'Baritone';
  if (tessituraMidpoint < 59) return 'Tenor';
  if (tessituraMidpoint < 64) return 'Alto';
  if (tessituraMidpoint < 69) return 'Mezzo-Soprano';
  return 'Soprano';
}

function makeMeasuredProfile(name: string, lowMidi: number, highMidi: number): UserProfile {
  const voiceType = getVoiceType(lowMidi, highMidi);
  const profile = createProfileFromPreset(voiceType, name);
  const range = highMidi - lowMidi;
  const tessituraMinMidi = lowMidi + range * 0.175;
  const tessituraMaxMidi = highMidi - range * 0.175;
  return {
    ...profile,
    minHz: midiToFrequency(lowMidi),
    maxHz: midiToFrequency(highMidi),
    minNote: midiToNote(lowMidi),
    maxNote: midiToNote(highMidi),
    tessituraMinHz: midiToFrequency(tessituraMinMidi),
    tessituraMaxHz: midiToFrequency(tessituraMaxMidi),
  };
}

@Component({
  selector: 'app-vocal-range-modal',
  imports: [FormsModule, LucideArrowLeft, LucideMic, LucideX, SettingsOptionGroup],
  templateUrl: './vocal-range-modal.html',
  styleUrl: './vocal-range-modal.scss',
})
export class VocalRangeModal implements OnInit, OnDestroy {
  readonly microphoneDeviceId = input('');
  readonly existingProfile = input<UserProfile | null>(null);
  readonly closed = output<void>();
  readonly mic = inject(MicTestService);
  readonly presets: SettingsOption[] = VOCAL_PROFILE_PRESETS.map((preset) => ({
    value: preset.voiceType,
    label: preset.voiceType,
    description: `${preset.minNote}–${preset.maxNote}`,
    note: `Comfort zone ${preset.tessituraMinNote}–${preset.tessituraMaxNote}`,
  }));
  readonly view = signal<VocalRangeView>('measure');
  readonly step = signal<VocalRangeStep>('lowest');
  readonly profileName = signal('Singer');
  readonly selectedPreset = signal('');
  readonly lowMidi = signal<number | null>(null);
  readonly highMidi = signal<number | null>(null);
  readonly profilePreview = signal<UserProfile | null>(null);
  readonly manualNotes = Array.from({ length: 61 }, (_, index) => {
    const midi = index + 24;
    return { midi, note: midiToNote(midi) };
  });
  readonly anchors = [
    { note: 'C2', position: rangeRailPosition(midiToFrequency(36)) },
    { note: 'G2', position: rangeRailPosition(midiToFrequency(43)) },
    { note: 'C3', position: rangeRailPosition(midiToFrequency(48)) },
    { note: 'E3', position: rangeRailPosition(midiToFrequency(52)) },
    { note: 'G3', position: rangeRailPosition(midiToFrequency(55)) },
    { note: 'C4', position: rangeRailPosition(midiToFrequency(60)) },
  ];
  readonly holdRingCircumference = HOLD_RING_CIRCUMFERENCE;
  readonly noiseCheckComplete = signal(false);
  readonly noiseGateRms = signal(NOISE_GATE_FLOOR);
  readonly noiseWarning = signal(false);
  readonly liveFrequency = signal<number | null>(null);
  readonly holdGate = signal<NoteHoldGateState>(EMPTY_NOTE_HOLD_GATE);
  readonly error = signal('');
  readonly detectedNote = computed(() => {
    const frequency = this.liveFrequency();
    return frequency == null ? null : midiToNote(frequencyToMidi(frequency));
  });
  readonly bubblePosition = computed(() => {
    const frequency = this.liveFrequency();
    return frequency == null ? null : rangeRailPosition(frequency);
  });
  readonly lowPosition = computed(() => {
    const midi = this.lowMidi();
    return midi === null ? null : rangeRailPosition(midiToFrequency(midi));
  });
  readonly highPosition = computed(() => {
    const midi = this.highMidi();
    return midi === null ? null : rangeRailPosition(midiToFrequency(midi));
  });
  readonly holdRingOffset = computed(() =>
    HOLD_RING_CIRCUMFERENCE * (1 - this.holdGate().progress),
  );
  readonly resultVoiceType = computed(() => this.profilePreview()?.voiceType ?? null);
  readonly resultMinNote = computed(() => this.profilePreview()?.minNote ?? null);
  readonly resultMaxNote = computed(() => this.profilePreview()?.maxNote ?? null);
  readonly resultComfortZone = computed(() => {
    const profile = this.profilePreview();
    if (!profile?.tessituraMinHz || !profile.tessituraMaxHz) return null;
    return `${midiToNote(frequencyToMidi(profile.tessituraMinHz))}–${midiToNote(frequencyToMidi(profile.tessituraMaxHz))}`;
  });

  midiToNote(midi: number | null): string {
    return midi === null ? '—' : midiToNote(midi);
  }

  protected readonly partySession = inject(PartySessionService);
  private detector: ReturnType<typeof YIN> | null = null;
  private readonly noiseReadings: number[] = [];
  private noiseStartedAt = 0;
  private lastPitchCheckAt = 0;

  ngOnInit(): void {
    this.profileName.set(this.existingProfile()?.name ?? 'Singer');
    this.mic.setMonitor(false);
    void this.startMeasurement();
  }

  ngOnDestroy(): void {
    this.mic.stop();
  }

  async startMeasurement(resetRange = true): Promise<void> {
    this.resetMeasurement(resetRange);
    this.view.set('measure');
    this.noiseStartedAt = 0;
    try {
      await this.mic.start(this.microphoneDeviceId(), {
        fftSize: 2048,
        onFrame: (samples, rms, sampleRate) => this.onMicrophoneFrame(samples, rms, sampleRate),
      });
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not start microphone testing.');
    }
  }

  showPresets(): void {
    this.mic.stop();
    this.view.set('presets');
  }

  showMicrophone(): void {
    void this.startMeasurement();
  }

  choosePreset(voiceType: string): void {
    const preset = VOCAL_PROFILE_PRESETS.find((item) => item.voiceType === voiceType);
    if (!preset) {
      this.error.set(`Unknown voice preset: ${voiceType}`);
      return;
    }
    this.selectedPreset.set(voiceType);
    this.profilePreview.set(createProfileFromPreset(preset.voiceType, this.profileName()));
    this.view.set('result');
  }

  selectRangeStep(step: VocalRangeStep): void {
    this.step.set(step);
    this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
    this.error.set('');
  }

  setManualNote(step: VocalRangeStep, event: Event): void {
    const midi = Number((event.target as HTMLSelectElement).value);
    if (!Number.isInteger(midi) || midi < 24 || midi > 84) return;
    if (step === 'lowest' && this.highMidi() !== null && midi >= this.highMidi()!) {
      this.error.set('The lowest note must be below the highest note.');
      return;
    }
    if (step === 'highest' && this.lowMidi() !== null && midi <= this.lowMidi()!) {
      this.error.set('The highest note must be above the lowest note.');
      return;
    }
    step === 'lowest' ? this.lowMidi.set(midi) : this.highMidi.set(midi);
    this.updateMeasuredPreview();
    this.error.set('');
  }

  reviewRange(): void {
    if (this.lowMidi() === null || this.highMidi() === null) {
      this.error.set('Choose both a lowest and highest note before reviewing.');
      return;
    }
    this.updateMeasuredPreview();
    this.mic.stop();
    this.view.set('result');
  }

  continueTesting(): void {
    void this.startMeasurement(false);
  }

  async saveProfile(): Promise<void> {
    const preview = this.profilePreview();
    if (!preview) return;
    this.mic.stop();
    this.error.set('');
    const name = this.profileName().trim() || 'Singer';
    const existing = this.existingProfile();
    const profile = {
      ...preview,
      id: existing?.id ?? preview.id,
      name,
      initials: getInitials(name),
      avatar: existing?.avatar ?? preview.avatar,
      accentColor: existing?.accentColor ?? preview.accentColor,
      isGuest: existing?.isGuest ?? false,
    };
    try {
      if (existing?.isGuest) this.partySession.updateGuestProfile(profile);
      else {
        this.partySession.saveProfile(profile);
        if (!existing) this.partySession.addSavedProfile(profile.id);
      }
      this.closed.emit();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save this voice profile.');
    }
  }

  skip(): void {
    this.mic.stop();
    this.closed.emit();
  }

  closeFromBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.skip();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.skip();
  }

  private resetMeasurement(resetRange = true): void {
    this.mic.stop();
    this.error.set('');
    this.step.set('lowest');
    if (resetRange) {
      this.lowMidi.set(null);
      this.highMidi.set(null);
      this.profilePreview.set(null);
    }
    this.noiseCheckComplete.set(false);
    this.noiseGateRms.set(NOISE_GATE_FLOOR);
    this.noiseWarning.set(false);
    this.liveFrequency.set(null);
    this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
    this.noiseReadings.length = 0;
    this.noiseStartedAt = 0;
    this.detector = null;
    this.lastPitchCheckAt = 0;
  }

  private onMicrophoneFrame(samples: Float32Array, rms: number, sampleRate: number): void {
    if (!this.noiseStartedAt) this.noiseStartedAt = performance.now();
    if (!this.noiseCheckComplete()) {
      this.noiseReadings.push(rms);
      if (performance.now() - this.noiseStartedAt < NOISE_CHECK_MS) return;
      const gate = calculateNoiseGateRms(this.noiseReadings);
      this.noiseGateRms.set(gate);
      this.noiseWarning.set(gate >= 0.08);
      this.noiseCheckComplete.set(true);
      return;
    }

    const now = performance.now();
    if (rms < this.noiseGateRms() || now - this.lastPitchCheckAt < PITCH_UPDATE_INTERVAL_MS) {
      if (rms < this.noiseGateRms()) {
        this.liveFrequency.set(null);
        this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
      }
      return;
    }
    this.lastPitchCheckAt = now;
    this.detector ??= YIN({ sampleRate });
    const frequency = this.detector(samples);
    if (
      frequency == null
      || !Number.isFinite(frequency)
      || frequency < MIN_FREQUENCY_HZ
      || frequency > MAX_FREQUENCY_HZ
    ) {
      this.liveFrequency.set(null);
      this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
      return;
    }

    this.liveFrequency.set(frequency);
    const next = advanceNoteHoldGate(this.holdGate(), frequency, now);
    this.holdGate.set(next);
    if (next.lockedMidi !== null) this.lockNote(next.lockedMidi);
  }

  private lockNote(midi: number): void {
    if (this.step() === 'lowest') {
      if (this.highMidi() !== null && midi >= this.highMidi()!) {
        this.error.set('Try a note lower than your selected highest note.');
        this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
        return;
      }
      this.lowMidi.set(midi);
      this.step.set('highest');
      this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
      this.updateMeasuredPreview();
      return;
    }
    const low = this.lowMidi();
    if (low !== null && midi <= low) {
      this.error.set('Try a note higher than your lowest comfortable note.');
      this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
      return;
    }
    this.highMidi.set(midi);
    this.updateMeasuredPreview();
  }

  private updateMeasuredPreview(): void {
    const low = this.lowMidi();
    const high = this.highMidi();
    if (low === null || high === null || low >= high) {
      this.profilePreview.set(null);
      return;
    }
    this.profilePreview.set(makeMeasuredProfile(this.profileName(), low, high));
  }
}
