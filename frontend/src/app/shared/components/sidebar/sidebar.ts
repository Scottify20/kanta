import { Component, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideListMusic,
  LucidePlay,
  LucideSearch,
  LucideSettings2,
  LucideX,
} from '@lucide/angular';

@Component({
  selector: 'app-sidebar',
  imports: [LucideListMusic, LucidePlay, LucideSearch, LucideSettings2, LucideX, RouterLink],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  readonly close = output<void>();
  readonly queueSelected = output<void>();

  closeSidebar(): void {
    this.close.emit();
  }

  openQueue(): void {
    this.queueSelected.emit();
  }
}
