import { Component, computed, inject, input } from '@angular/core';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { AudioPlayerService } from '../../../../shared/services/audio-player.service';
import { PartySessionService } from '../../../../shared/services/party-session.service';
import { ToastService } from '../../../../shared/services/toast.service';
import type { SongManifest } from '../../../../shared/services/songs.service';

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PITCH_INDEX: Record<string, number> = {
  C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3,
  E: 4, Fb: 4, 'E#': 5, F: 5, 'F#': 6, Gb: 6, G: 7,
  'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
};

function transposeKey(key: string, semitones: number): string {
  const match = /^([A-G](?:#|b)?)(m?)$/i.exec(key.trim());
  if (!match) return key;
  const pitch = PITCH_INDEX[match[1][0].toUpperCase() + match[1].slice(1)];
  if (pitch === undefined) return key;
  return `${PITCH_CLASSES[((pitch + semitones) % 12 + 12) % 12]}${match[2]}`;
}

function transposeNote(note: string, semitones: number): string {
  const match = /^([A-G](?:#|b)?)(-?\d+)$/i.exec(note.trim());
  if (!match) return note;
  const pitch = PITCH_INDEX[match[1][0].toUpperCase() + match[1].slice(1)];
  if (pitch === undefined) return note;
  const midi = (Number(match[2]) + 1) * 12 + pitch + semitones;
  return `${PITCH_CLASSES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

@Component({
  selector: 'app-key-adjustment-control',
  imports: [PopupPanel, Tooltip],
  templateUrl: './key-adjustment-control.html',
  styleUrl: './key-adjustment-control.scss',
})
export class KeyAdjustmentControl {
  readonly audioPlayer = inject(AudioPlayerService);
  readonly partySession = inject(PartySessionService);
  private readonly toast = inject(ToastService);
  readonly quickSteps = [-2, -1, 0, 1, 2];
  readonly song = input<SongManifest | null>(null);
  readonly keyTransition = computed(() => {
    const key = this.song()?.musical_key;
    return key ? `${key} → ${transposeKey(key, this.audioPlayer.effectiveSemitones())}` : null;
  });
  readonly rangeTransition = computed(() => {
    const song = this.song();
    if (!song?.vocal_min_note || !song.vocal_max_note) return null;
    const shift = this.audioPlayer.effectiveSemitones();
    return `${song.vocal_min_note}–${song.vocal_max_note} → ${transposeNote(song.vocal_min_note, shift)}–${transposeNote(song.vocal_max_note, shift)}`;
  });

  updateSemitoneShift(event: Event): void {
    this.handleKeyChange(
      this.audioPlayer.setSemitoneShift(Number((event.target as HTMLInputElement).value)),
    );
  }

  setSemitoneShift(semitones: number): void {
    this.handleKeyChange(this.audioPlayer.setSemitoneShift(semitones));
  }

  setKeyShiftEnabled(event: Event): void {
    this.handleKeyChange(
      this.audioPlayer.setKeyShiftEnabled((event.target as HTMLInputElement).checked),
    );
  }

  private handleKeyChange(change: Promise<void>): void {
    void change.catch((error: unknown) => {
      console.error('Could not update the playback key:', error);
      this.toast.error('Could not adjust the key.');
    });
  }
}
