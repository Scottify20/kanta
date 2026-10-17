import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideDownload, LucideFolderOpen, LucideMinus } from '@lucide/angular';
import { Tooltip } from '../../directives/tooltip';
import { SettingsService } from '../../services/settings.service';
import { SetupService } from '../../services/setup.service';

type Step = 'folder' | 'models';

@Component({
  selector: 'app-setup-modal',
  imports: [FormsModule, LucideDownload, LucideFolderOpen, LucideMinus, Tooltip],
  templateUrl: './setup-modal.html',
  styleUrl: './setup-modal.scss',
})
export class SetupModal {
  readonly setup = inject(SetupService);
  private readonly settings = inject(SettingsService);
  readonly job = computed(() => this.setup.status()?.job);
  readonly percent = computed(() => Math.round(this.job()?.progress ?? 0));
  readonly folder = signal(this.setup.status()?.suggested_output_dir ?? '');
  readonly full = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  private readonly chosenStep = signal<Step>(this.setup.status()?.output_configured ? 'models' : 'folder');
  readonly step = computed<Step>(() => (this.setup.status()?.output_configured ? this.chosenStep() : 'folder'));
  readonly downloading = computed(() => !!this.job()?.running);

  async browse(): Promise<void> {
    const picked = await this.settings.pickFolder('Choose where processed songs are saved', this.folder());
    if (picked) this.folder.set(picked);
  }

  async saveFolder(): Promise<void> {
    const path = this.folder().trim();
    if (!path) {
      this.error.set('Choose a folder for your processed songs.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      await new Promise<void>((resolve, reject) =>
        this.settings.patchSettings({ output_dirs: [path], default_output_dir: path }).subscribe({
          next: () => resolve(),
          error: (err: { error?: { detail?: string } }) => reject(new Error(err.error?.detail ?? 'Could not use that folder.')),
        }),
      );
      this.chosenStep.set('models');
      await this.setup.refresh();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not use that folder.');
    } finally {
      this.saving.set(false);
    }
  }

  async download(): Promise<void> {
    this.error.set('');
    this.settings.patchSettings({ output_mode: this.full() ? 'full' : 'basic' }).subscribe({
      next: () => void this.setup.install(this.full()),
      error: () => void this.setup.install(this.full()),
    });
  }
}
