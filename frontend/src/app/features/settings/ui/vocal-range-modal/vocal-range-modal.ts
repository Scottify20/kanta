import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideArrowLeft, LucideCheck, LucideMic, LucideSlidersHorizontal, LucideX } from '@lucide/angular';
import { YIN } from 'pitchfinder';
import { MicTestService } from '../mic-test/mic-test.service';
import { SettingsOptionGroup } from '../../../../shared/components/settings-option-group/settings-option-group';
import { NoteSelector } from '../../../../shared/components/note-selector/note-selector';
import {
  PartySessionService,
  VOCAL_PROFILE_PRESETS,
  ProfileVoiceType,
  UserProfile,
  classifyVocalRange,
  midiToNote,
  midiToHz,
  hzToMidi,
} from '../../../../shared/services/party-session.service';

const MIN_FREQUENCY_HZ = 40;
const MAX_FREQUENCY_HZ = 1200;
const NOISE_CHECK_MS = 1400;
const HOLD_CONFIRMATION_MS = 500;
const PITCH_UPDATE_INTERVAL_MS = 45;
const NOISE_GATE_FLOOR = 0.008;
const NOISE_GATE_MULTIPLIER = 2.2;
const HOLD_RING_CIRCUMFERENCE = 2 * Math.PI * 18;

export type VocalRangeStep = 'lowest' | 'highest';
export type VocalRangeMode = 'mic' | 'manual' | 'presets';

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

function rangeRailPosition(frequency: number): number {
  const range = Math.log2(MAX_FREQUENCY_HZ / MIN_FREQUENCY_HZ);
  return Math.max(0, Math.min(100, (Math.log2(frequency / MIN_FREQUENCY_HZ) / range) * 100));
}

@Component({
  selector: 'app-vocal-range-modal',
  imports: [FormsModule, LucideCheck, LucideMic, LucideSlidersHorizontal, LucideX, SettingsOptionGroup, NoteSelector],
  templateUrl: './vocal-range-modal.html',
  styleUrl: './vocal-range-modal.scss',
})
export class VocalRangeModal implements OnInit, OnDestroy {
  readonly microphoneDeviceId = input('');
  readonly existingProfile = input<UserProfile | null>(null);

  readonly saved = output<UserProfile>();
  readonly closed = output<void>();

  readonly mic = inject(MicTestService);
  protected readonly partySession = inject(PartySessionService);

  readonly mode = signal<VocalRangeMode>('mic');
  readonly step = signal<VocalRangeStep>('lowest');
  readonly profileName = signal('Singer');

  readonly lowMidi = signal<number | null>(null);
  readonly highMidi = signal<number | null>(null);

  readonly presets = VOCAL_PROFILE_PRESETS.map((preset) => ({
    value: preset.voiceType,
    label: preset.voiceType,
    description: `${preset.minNote}–${preset.maxNote}`,
    note: `Comfort ${preset.tessituraMinNote}–${preset.tessituraMaxNote}`,
  }));

  readonly anchors = [
    { note: 'C2', position: rangeRailPosition(midiToHz(36)) },
    { note: 'G2', position: rangeRailPosition(midiToHz(43)) },
    { note: 'C3', position: rangeRailPosition(midiToHz(48)) },
    { note: 'G3', position: rangeRailPosition(midiToHz(55)) },
    { note: 'C4', position: rangeRailPosition(midiToHz(60)) },
    { note: 'G4', position: rangeRailPosition(midiToHz(67)) },
    { note: 'C5', position: rangeRailPosition(midiToHz(72)) },
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
    return frequency == null ? null : midiToNote(hzToMidi(frequency));
  });

  readonly bubblePosition = computed(() => {
    const frequency = this.liveFrequency();
    return frequency == null ? null : rangeRailPosition(frequency);
  });

  readonly lowPosition = computed(() => {
    const midi = this.lowMidi();
    return midi === null ? null : rangeRailPosition(midiToHz(midi));
  });

  readonly highPosition = computed(() => {
    const midi = this.highMidi();
    return midi === null ? null : rangeRailPosition(midiToHz(midi));
  });

  readonly spanStyle = computed(() => {
    const low = this.lowPosition();
    const high = this.highPosition();
    if (low === null || high === null || low >= high) return null;
    return {
      left: `${low}%`,
      width: `${high - low}%`,
    };
  });

  readonly holdRingOffset = computed(() =>
    HOLD_RING_CIRCUMFERENCE * (1 - this.holdGate().progress),
  );

  readonly detectedVoiceType = computed<ProfileVoiceType>(() => {
    const low = this.lowMidi();
    const high = this.highMidi();
    if (low === null || high === null || low >= high) return 'Uncalibrated';
    return classifyVocalRange(low, high);
  });

  readonly comfortZoneLabel = computed(() => {
    const low = this.lowMidi();
    const high = this.highMidi();
    if (low === null || high === null || low >= high) return null;
    const range = high - low;
    const tessMin = Math.round(low + range * 0.175);
    const tessMax = Math.round(high - range * 0.175);
    return `${midiToNote(tessMin)} – ${midiToNote(tessMax)}`;
  });

  private detector: ReturnType<typeof YIN> | null = null;
  private readonly noiseReadings: number[] = [];
  private noiseStartedAt = 0;
  private lastPitchCheckAt = 0;

  ngOnInit(): void {
    const existing = this.existingProfile();
    if (existing) {
      this.profileName.set(existing.name);
      if (existing.minHz && existing.maxHz) {
        this.lowMidi.set(Math.round(hzToMidi(existing.minHz)));
        this.highMidi.set(Math.round(hzToMidi(existing.maxHz)));
      }
    }
    this.mic.setMonitor(false);
    void this.startMeasurement();
  }

  ngOnDestroy(): void {
    this.mic.stop();
  }

  midiToNote(midi: number | null): string {
    return midi === null ? '—' : midiToNote(midi);
  }

  setMode(mode: VocalRangeMode): void {
    this.mode.set(mode);
    if (mode === 'mic') {
      void this.startMeasurement(false);
    } else {
      this.mic.stop();
    }
  }

  async startMeasurement(resetRange = true): Promise<void> {
    this.mic.stop();
    this.error.set('');
    this.step.set('lowest');
    if (resetRange && !this.existingProfile()?.minHz) {
      this.lowMidi.set(null);
      this.highMidi.set(null);
    }
    this.noiseCheckComplete.set(false);
    this.noiseGateRms.set(NOISE_GATE_FLOOR);
    this.noiseWarning.set(false);
    this.liveFrequency.set(null);
    this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
    this.noiseReadings.length = 0;
    this.noiseStartedAt = 0;
    this.detector = null;

    try {
      await this.mic.start(this.microphoneDeviceId(), {
        fftSize: 2048,
        onFrame: (samples, rms, sampleRate) => this.onMicrophoneFrame(samples, rms, sampleRate),
      });
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not start microphone.');
      this.mode.set('manual');
    }
  }

  selectStep(step: VocalRangeStep): void {
    this.step.set(step);
    this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
    this.error.set('');
  }

  choosePreset(voiceType: string): void {
    const preset = VOCAL_PROFILE_PRESETS.find((p) => p.voiceType === voiceType);
    if (!preset || preset.minHz == null || preset.maxHz == null) return;
    this.lowMidi.set(Math.round(hzToMidi(preset.minHz)));
    this.highMidi.set(Math.round(hzToMidi(preset.maxHz)));
    this.error.set('');
  }

  setManualMidiValue(which: 'lowest' | 'highest', midi: number): void {
    if (which === 'lowest') {
      if (this.highMidi() !== null && midi >= this.highMidi()!) {
        this.error.set('Lowest note must be lower than highest note.');
        return;
      }
      this.lowMidi.set(midi);
    } else {
      if (this.lowMidi() !== null && midi <= this.lowMidi()!) {
        this.error.set('Highest note must be higher than lowest note.');
        return;
      }
      this.highMidi.set(midi);
    }
    this.error.set('');
  }

  applyAndSave(): void {
    const low = this.lowMidi();
    const high = this.highMidi();
    if (low === null || high === null || low >= high) {
      this.error.set('Please define both a lowest and highest note.');
      return;
    }

    this.mic.stop();
    const voiceType = classifyVocalRange(low, high);
    const existing = this.existingProfile();
    const name = existing?.name ?? this.profileName() ?? 'Singer';

    const range = high - low;
    const tessituraMinHz = midiToHz(low + range * 0.175);
    const tessituraMaxHz = midiToHz(high - range * 0.175);

    const updated: UserProfile = {
      id: existing?.id ?? `profile-${Date.now().toString(36)}`,
      name,
      initials: name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?',
      avatar: existing?.avatar ?? null,
      accentColor: existing?.accentColor ?? '#4a8f8c',
      voiceType,
      minHz: midiToHz(low),
      maxHz: midiToHz(high),
      minNote: midiToNote(low),
      maxNote: midiToNote(high),
      tessituraMinHz,
      tessituraMaxHz,
      isGuest: existing?.isGuest ?? true,
    };

    if (existing && existing.id !== 'draft-guest') {
      if (existing.isGuest) this.partySession.updateGuestProfile(updated);
      else this.partySession.saveProfile(updated);
    }

    this.saved.emit(updated);
    this.closed.emit();
  }

  skip(): void {
    this.mic.stop();
    this.closed.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.skip();
  }

  private onMicrophoneFrame(samples: Float32Array, rms: number, sampleRate: number): void {
    if (!this.noiseStartedAt) this.noiseStartedAt = performance.now();
    if (!this.noiseCheckComplete()) {
      this.noiseReadings.push(rms);
      if (performance.now() - this.noiseStartedAt < NOISE_CHECK_MS) return;
      const sorted = this.noiseReadings.filter(Number.isFinite).sort((a, b) => a - b);
      const gate = Math.max(NOISE_GATE_FLOOR, (sorted[Math.floor((sorted.length - 1) * 0.9)] || NOISE_GATE_FLOOR) * NOISE_GATE_MULTIPLIER);
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
    const candidateMidi = Math.round(hzToMidi(frequency));
    const centsFromNote = 1200 * Math.log2(frequency / midiToHz(candidateMidi));
    if (Math.abs(centsFromNote) > 50) {
      this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
      return;
    }

    const current = this.holdGate();
    const heldSinceMs = current.candidateMidi === candidateMidi && current.heldSinceMs !== null
      ? current.heldSinceMs
      : now;
    const progress = Math.min(1, Math.max(0, (now - heldSinceMs) / HOLD_CONFIRMATION_MS));
    const lockedMidi = progress >= 1 ? candidateMidi : null;
    this.holdGate.set({ candidateMidi, heldSinceMs, progress, lockedMidi });
    if (lockedMidi !== null) this.lockNote(lockedMidi);
  }

  private lockNote(midi: number): void {
    if (this.step() === 'lowest') {
      if (this.highMidi() !== null && midi >= this.highMidi()!) {
        this.error.set('Hold a note lower than your highest note.');
        this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
        return;
      }
      this.lowMidi.set(midi);
      this.step.set('highest');
      this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
      return;
    }
    const low = this.lowMidi();
    if (low !== null && midi <= low) {
      this.error.set('Hold a note higher than your lowest note.');
      this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
      return;
    }
    this.highMidi.set(midi);
    this.holdGate.set(EMPTY_NOTE_HOLD_GATE);
  }
}