import { Component, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideLibrary,
  LucideListMusic,
  LucidePlay,
  LucideSettings2,
  LucideX,
} from '@lucide/angular';

import { SearchBar } from '../search-bar/search-bar';

@Component({
  selector: 'app-sidebar',
  imports: [
    LucideLibrary,
    LucideListMusic,
    LucidePlay,
    LucideSettings2,
    LucideX,
    RouterLink,
    RouterLinkActive,
    SearchBar,
  ],
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
