import { Component, input, output } from '@angular/core';
import { LucideRotateCcw, LucideTimer } from '@lucide/angular';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';

@Component({
  selector: 'app-lyrics-timing-control',
  imports: [PopupPanel, LucideRotateCcw, LucideTimer],
  templateUrl: './lyrics-timing-control.html',
  styleUrl: './lyrics-timing-control.scss',
})
export class LyricsTimingControl {
  readonly offsetMs = input.required<number>();
  readonly maxOffsetMs = input(10_000);
  readonly adjust = output<number>();
  readonly offsetChange = output<number>();
  readonly save = output<void>();
  readonly reset = output<void>();

  updateOffset(event: Event): void {
    const seconds = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(seconds)) {
      this.offsetChange.emit(seconds);
    }
  }
}
