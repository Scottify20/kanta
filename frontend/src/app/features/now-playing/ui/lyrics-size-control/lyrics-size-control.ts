import { DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { LucideALargeSmall, LucideRotateCcw } from '@lucide/angular';
import { PopupPanel } from '../../../../shared/components/popup-panel/popup-panel';
import { LyricsSizeService } from '../../../../shared/services/lyrics-size.service';

@Component({
  selector: 'app-lyrics-size-control',
  imports: [DecimalPipe, PopupPanel, LucideALargeSmall, LucideRotateCcw],
  templateUrl: './lyrics-size-control.html',
  styleUrl: './lyrics-size-control.scss',
})
export class LyricsSizeControl {
  protected readonly size = inject(LyricsSizeService);

  update(event: Event): void {
    this.size.set(Number((event.target as HTMLInputElement).value));
  }
}
