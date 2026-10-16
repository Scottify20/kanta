import { OverlayModule } from '@angular/cdk/overlay';
import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideFolderOpen, LucidePlus, LucideTrash2 } from '@lucide/angular';
import { Tooltip } from '../../directives/tooltip';

@Component({
  selector: 'app-settings-folders',
  imports: [OverlayModule, FormsModule, LucideFolderOpen, LucidePlus, LucideTrash2, Tooltip],
  templateUrl: './settings-folders.html',
  styleUrl: './settings-folders.scss',
})
export class SettingsFolders {
  readonly outputDirs = input.required<string[]>();
  readonly defaultOutputDir = input.required<string>();
  readonly newOutputDir = input.required<string>();
  readonly outputDirsChange = output<string[]>();
  readonly defaultOutputDirChange = output<string>();
  readonly newOutputDirChange = output<string>();
  readonly browseRequest = output<'output' | 'model'>();

  addOutputDir(): void {
    const path = this.newOutputDir().trim();
    if (!path || this.outputDirs().includes(path)) return;
    this.outputDirsChange.emit([...this.outputDirs(), path]);
    if (!this.defaultOutputDir()) this.defaultOutputDirChange.emit(path);
    this.newOutputDirChange.emit('');
  }

  removeOutputDir(path: string): void {
    if (this.outputDirs().length <= 1) return;
    const remaining = this.outputDirs().filter((directory) => directory !== path);
    this.outputDirsChange.emit(remaining);
    if (this.defaultOutputDir() === path) this.defaultOutputDirChange.emit(remaining[0]);
  }
}
