import { OverlayModule } from '@angular/cdk/overlay';
import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { LucideArrowUp, LucideCheck, LucideFolder, LucideX } from '@lucide/angular';
import { Tooltip } from '../../directives/tooltip';
import { BrowseFoldersResponse, SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-settings-folder-picker',
  imports: [OverlayModule, Tooltip, LucideArrowUp, LucideCheck, LucideFolder, LucideX],
  templateUrl: './settings-folder-picker.html',
  styleUrl: './settings-folder-picker.scss',
})
export class SettingsFolderPicker implements OnInit {
  readonly initialPath = input('');
  readonly selected = output<string>();
  readonly cancelled = output<void>();
  readonly current = signal<BrowseFoldersResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  private readonly settings = inject(SettingsService);

  ngOnInit(): void { this.load(this.initialPath()); }

  load(path: string): void {
    this.loading.set(true);
    this.error.set('');
    this.settings.browseFolders(path).subscribe({
      next: (result) => { this.current.set(result); this.loading.set(false); },
      error: () => { this.error.set('Could not browse this folder.'); this.loading.set(false); },
    });
  }

  openDirectory(name: string): void {
    const path = this.current()?.path ?? '';
    this.load(`${path.replace(/\/$/, '')}/${name}`);
  }

  goUp(): void {
    const parent = this.current()?.parent;
    if (parent) this.load(parent);
  }
}
