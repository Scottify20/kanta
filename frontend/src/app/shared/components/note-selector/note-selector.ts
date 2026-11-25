import { Component, computed, input, output, signal } from '@angular/core';
import { NOTE_NAMES, midiToNote, noteToMidi } from '../../services/vocal-classification';

@Component({
  selector: 'app-note-selector',
  templateUrl: 'note-selector.html',
  styleUrl: 'note-selector.scss',
})
export class NoteSelector {
  readonly midi = input<number | null>(null);
  readonly minMidi = input(36); // C2
  readonly maxMidi = input(84); // C6
  readonly label = input('Note');

  readonly midiChange = output<number>();

  readonly pitchNames = NOTE_NAMES;
  readonly octaves = [2, 3, 4, 5, 6];

  readonly currentMidi = computed(() => this.midi() ?? 48); // Defaults to C3
  readonly currentNote = computed(() => midiToNote(this.currentMidi()));

  readonly currentPitch = computed(() => {
    const m = this.currentMidi();
    return NOTE_NAMES[((m % 12) + 12) % 12];
  });

  readonly currentOctave = computed(() => {
    const m = this.currentMidi();
    return Math.floor(m / 12) - 1;
  });

  stepSemitone(delta: number): void {
    const next = Math.max(this.minMidi(), Math.min(this.maxMidi(), this.currentMidi() + delta));
    this.midiChange.emit(next);
  }

  setPitch(pitch: string): void {
    const oct = this.currentOctave();
    const newMidi = noteToMidi(`${pitch}${oct}`);
    if (newMidi !== null) {
      const clamped = Math.max(this.minMidi(), Math.min(this.maxMidi(), newMidi));
      this.midiChange.emit(clamped);
    }
  }

  setOctave(oct: number): void {
    const pitch = this.currentPitch();
    const newMidi = noteToMidi(`${pitch}${oct}`);
    if (newMidi !== null) {
      const clamped = Math.max(this.minMidi(), Math.min(this.maxMidi(), newMidi));
      this.midiChange.emit(clamped);
    }
  }
}