import { DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { LucideALargeSmall, LucideRotateCcw } from '@lucide/angular';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { LyricsSizeService } from '../../../../shared/services/lyrics-size.service';
import { LyricsColorService } from '../../../../shared/services/lyrics-color.service';

@Component({
  selector: 'app-lyrics-size-control',
  imports: [DecimalPipe, PopupPanel, LucideALargeSmall, LucideRotateCcw],
  templateUrl: './lyrics-size-control.html',
  styleUrl: './lyrics-size-control.scss',
})
export class LyricsSizeControl {
  protected readonly size = inject(LyricsSizeService);
  protected readonly colors = inject(LyricsColorService);

  update(event: Event): void {
    this.size.set(Number((event.target as HTMLInputElement).value));
  }

  setColor(index: 0 | 1, event: Event): void {
    this.colors.setCustom(index, (event.target as HTMLInputElement).value);
  }
}
