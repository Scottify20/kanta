import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { LucideLibrary, LucidePlay, LucideSettings2 } from '@lucide/angular';

import { SearchBar } from '../search-bar/search-bar';

@Component({
  selector: 'app-sidebar',
  imports: [LucideLibrary, LucidePlay, LucideSettings2, RouterLink, RouterLinkActive, SearchBar],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {}
