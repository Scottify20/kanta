import { OverlayModule } from '@angular/cdk/overlay';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideChevronLeft, LucideFolderOpen } from '@lucide/angular';
import { catchError, debounceTime, EMPTY, Subject, switchMap } from 'rxjs';
import { SettingsAudioDevices } from '../../shared/components/settings-audio-devices/settings-audio-devices';
import { SettingsFolderPicker } from '../../shared/components/settings-folder-picker/settings-folder-picker';
import { SettingsFolders } from '../../shared/components/settings-folders/settings-folders';
import { SettingsOption, SettingsOptionGroup } from '../../shared/components/settings-option-group/settings-option-group';
import { SettingsSection } from '../../shared/components/settings-section/settings-section';
import { Tooltip } from '../../shared/directives/tooltip';
import { InferenceDevice, SettingsService } from '../../shared/services/settings.service';

@Component({
  selector: 'app-settings',
  imports: [
    FormsModule, RouterLink, OverlayModule, LucideChevronLeft, LucideFolderOpen, Tooltip,
    SettingsAudioDevices, SettingsFolderPicker, SettingsFolders, SettingsOptionGroup, SettingsSection,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  private readonly settingsService = inject(SettingsService);
  private readonly saveRequests = new Subject<void>();
  readonly outputDirs = signal<string[]>([]);
  readonly defaultOutputDir = signal('');
  readonly newOutputDir = signal('');
  readonly modelDir = signal('');
  readonly outputMode = signal<'basic' | 'full'>('full');
  readonly outputQuality = signal<'high' | 'standard' | 'low'>('standard');
  readonly inferenceDevice = signal<'cuda' | 'vulkan' | 'cpu'>('cpu');
  readonly devices = signal<InferenceDevice[]>([]);
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal('');
  readonly pickerTarget = signal<'output' | 'model' | null>(null);
  readonly pickerStartPath = signal('');
  readonly deviceOptions = computed<SettingsOption[]>(() => {
    const known = this.devices();
    return [
      { value: 'cuda', label: this.deviceLabel('cuda', 'CUDA'), description: 'NVIDIA GPU acceleration', ...this.deviceAvailability('cuda', known) },
      { value: 'vulkan', label: this.deviceLabel('vulkan', 'Vulkan'), description: 'Cross-vendor GPU acceleration', ...this.deviceAvailability('vulkan', known) },
      { value: 'cpu', label: this.deviceLabel('cpu', 'CPU'), description: 'Run on the processor', ...this.deviceAvailability('cpu', known) },
    ];
  });
  readonly modeOptions: SettingsOption[] = [
    { value: 'basic', label: 'Basic', description: 'Instrumentals and vocals' },
    { value: 'full', label: 'Full', description: 'Lead & backing vocals, bass, drums, piano, and others' },
  ];
  readonly qualityOptions: SettingsOption[] = [
    { value: 'high', label: 'High', description: 'FLAC · 16 bit / 44.1 kHz' },
    { value: 'standard', label: 'Standard', description: 'MP3 · 320 kbps' },
    { value: 'low', label: 'Low', description: 'MP3 · 128 kbps' },
  ];

  constructor() {
    this.saveRequests.pipe(
      debounceTime(450),
      switchMap(() => this.settingsService.updateSettings(this.settingsPayload()).pipe(
        catchError((error: { error?: { detail?: string } }) => {
          this.error.set(error.error?.detail ?? 'Could not save settings.');
          this.saving.set(false);
          return EMPTY;
        }),
      )),
    ).subscribe(() => {
      this.saved.set(true);
      this.saving.set(false);
    });

    this.settingsService.getSettings().subscribe({
      next: (settings) => {
        const dirs = settings.output_dirs?.length ? settings.output_dirs : [settings.output_dir].filter(Boolean);
        this.outputDirs.set(dirs);
        this.defaultOutputDir.set(settings.default_output_dir || settings.output_dir || dirs[0] || '');
        this.modelDir.set(settings.model_dir ?? '');
        this.outputMode.set(settings.output_mode || 'full');
        this.outputQuality.set(settings.output_quality || 'standard');
        this.inferenceDevice.set(settings.inference_device || 'cpu');
        this.loaded.set(true);
      },
      error: () => this.error.set('Could not load settings.'),
    });
    this.settingsService.getDevices().subscribe({ next: (devices) => this.devices.set(devices), error: () => undefined });
  }

  setOutputDirs(dirs: string[]): void { this.outputDirs.set(dirs); this.changed(); }
  setDefaultOutputDir(path: string): void { this.defaultOutputDir.set(path); this.changed(); }
  setNewOutputDir(path: string): void { this.newOutputDir.set(path); }
  setModelDir(path: string): void { this.modelDir.set(path); this.changed(); }
  setOutputMode(value: string): void { this.outputMode.set(value as 'basic' | 'full'); this.changed(); }
  setOutputQuality(value: string): void { this.outputQuality.set(value as 'high' | 'standard' | 'low'); this.changed(); }
  setInferenceDevice(value: string): void { this.inferenceDevice.set(value as 'cuda' | 'vulkan' | 'cpu'); this.changed(); }

  addOutputDir(): void {
    const path = this.newOutputDir().trim();
    if (!path || this.outputDirs().includes(path)) return;
    this.setOutputDirs([...this.outputDirs(), path]);
    if (!this.defaultOutputDir()) this.setDefaultOutputDir(path);
    this.newOutputDir.set('');
  }

  removeOutputDir(path: string): void {
    const dirs = this.outputDirs();
    if (dirs.length <= 1) return;
    this.setOutputDirs(dirs.filter((dir) => dir !== path));
    if (this.defaultOutputDir() === path) this.setDefaultOutputDir(this.outputDirs()[0]);
  }

  openPicker(target: 'output' | 'model'): void {
    this.pickerTarget.set(target);
    this.pickerStartPath.set(target === 'model' ? this.modelDir() : this.newOutputDir());
  }

  acceptFolder(path: string): void {
    if (this.pickerTarget() === 'model') this.setModelDir(path);
    else this.setNewOutputDir(path);
    this.pickerTarget.set(null);
  }

  save(): void { this.changed(); }

  private changed(): void {
    if (!this.loaded()) return;
    this.saving.set(true);
    this.saved.set(false);
    this.error.set('');
    this.saveRequests.next();
  }

  private settingsPayload() {
    return {
      output_dirs: this.outputDirs(),
      default_output_dir: this.defaultOutputDir(),
      model_dir: this.modelDir(),
      output_mode: this.outputMode(),
      output_quality: this.outputQuality(),
      inference_device: this.inferenceDevice(),
    };
  }

  private deviceLabel(id: string, fallback: string): string {
    return this.devices().find((device) => device.id === id)?.label || fallback;
  }

  private deviceAvailability(id: string, devices: InferenceDevice[]): Pick<SettingsOption, 'disabled' | 'note'> {
    if (!devices.length) return id === 'cpu' ? {} : { disabled: true, note: 'Unavailable' };
    return devices.some((device) => device.id === id && device.available)
      ? {}
      : { disabled: true, note: 'Unavailable' };
  }
}
