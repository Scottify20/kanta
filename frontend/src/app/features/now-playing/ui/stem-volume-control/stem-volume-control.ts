import { Component, inject } from '@angular/core';
import { LucideGuitar, LucideMicVocal } from '@lucide/angular';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { AudioPlayerService } from '../../../../shared/services/audio-player.service';

@Component({
  selector: 'app-stem-volume-control',
  imports: [PopupPanel, LucideGuitar, LucideMicVocal],
  templateUrl: './stem-volume-control.html',
  styleUrl: './stem-volume-control.scss',
})
export class StemVolumeControl {
  readonly audioPlayer = inject(AudioPlayerService);

  setVocalsVolume(event: Event): void {
    this.audioPlayer.setVocalsVolume(Number((event.target as HTMLInputElement).value));
  }

  setInstrumentalVolume(event: Event): void {
    this.audioPlayer.setInstrumentalVolume(Number((event.target as HTMLInputElement).value));
  }
}
