import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SettingsService } from '../../shared/services/settings.service';
import { SongsService } from '../../shared/services/songs.service';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  private readonly settingsService = inject(SettingsService);
  private readonly songsService = inject(SongsService);
  readonly pageArtwork = computed(() => this.songsService.currentSong()?.covers[0]?.url ?? null);

  readonly outputDirs = signal<string[]>([]);
  readonly defaultOutputDir = signal('');
  readonly newOutputDir = signal('');
  readonly modelDir = signal('');
  readonly saving = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);

  constructor() {
    this.settingsService.getSettings().subscribe({
      next: (settings) => {
        const outputDirs = settings.output_dirs?.length
          ? settings.output_dirs
          : [settings.output_dir];
        this.outputDirs.set(outputDirs);
        this.defaultOutputDir.set(settings.default_output_dir || settings.output_dir);
        this.modelDir.set(settings.model_dir);
      },
      error: () => this.error.set('Could not load settings.'),
    });
  }

  addOutputDir(): void {
    const path = this.newOutputDir().trim();
    if (!path || this.outputDirs().includes(path)) return;
    this.outputDirs.update((directories) => [...directories, path]);
    if (!this.defaultOutputDir()) this.defaultOutputDir.set(path);
    this.newOutputDir.set('');
  }

  removeOutputDir(path: string): void {
    const directories = this.outputDirs();
    if (directories.length <= 1) return;
    const remaining = directories.filter((directory) => directory !== path);
    this.outputDirs.set(remaining);
    if (this.defaultOutputDir() === path) this.defaultOutputDir.set(remaining[0]);
  }

  save(): void {
    this.saving.set(true);
    this.saved.set(false);
    this.error.set('');
    this.settingsService
      .updateSettings({
        output_dirs: this.outputDirs(),
        default_output_dir: this.defaultOutputDir(),
        model_dir: this.modelDir(),
      })
      .subscribe({
        next: (settings) => {
          this.outputDirs.set(settings.output_dirs);
          this.defaultOutputDir.set(settings.default_output_dir);
          this.modelDir.set(settings.model_dir);
          this.saved.set(true);
          this.saving.set(false);
        },
        error: (error) => {
          this.error.set(error.error?.detail ?? 'Could not save settings.');
          this.saving.set(false);
        },
      });
  }
}
