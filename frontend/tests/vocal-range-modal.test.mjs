import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import {
  advanceNoteHoldGate,
  calculateNoiseGateRms,
  EMPTY_NOTE_HOLD_GATE,
  frequencyToMidi,
  midiToFrequency,
  midiToNote,
} from '../src/app/features/settings/ui/vocal-range-modal/vocal-range-modal.ts';

describe('vocal range pitch helpers', () => {
  it('converts note numbers and frequencies in equal temperament', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToNote(60)).toBe('C4');
    expect(frequencyToMidi(440)).toBe(69);
    expect(midiToFrequency(60)).toBeCloseTo(261.63, 1);
  });

  it('fills the hold ring over 600ms and locks a stable note', () => {
    const started = advanceNoteHoldGate(EMPTY_NOTE_HOLD_GATE, 440, 1000);
    expect(started).toMatchObject({ candidateMidi: 69, progress: 0, lockedMidi: null });

    const halfway = advanceNoteHoldGate(started, 445, 1300);
    expect(halfway.progress).toBeCloseTo(0.5);
    expect(halfway.lockedMidi).toBeNull();

    const locked = advanceNoteHoldGate(halfway, 440, 1600);
    expect(locked).toMatchObject({ candidateMidi: 69, progress: 1, lockedMidi: 69 });
  });

  it('restarts verification when the note changes and resets for out-of-range input', () => {
    const started = advanceNoteHoldGate(EMPTY_NOTE_HOLD_GATE, 440, 1000);
    const changed = advanceNoteHoldGate(started, midiToFrequency(70), 1200);
    expect(changed).toMatchObject({ candidateMidi: 70, heldSinceMs: 1200, progress: 0 });

    expect(advanceNoteHoldGate(changed, 39, 1300)).toEqual(EMPTY_NOTE_HOLD_GATE);
  });

  it('sets a floor for the ambient RMS gate and raises it for louder rooms', () => {
    expect(calculateNoiseGateRms([0, 0.001, 0.002])).toBe(0.008);
    expect(calculateNoiseGateRms([0.02, 0.03, 0.04])).toBeGreaterThan(0.008);
  });
});
