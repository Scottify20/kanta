import { OverlayModule } from '@angular/cdk/overlay';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideFolderOpen, LucideMenu } from '@lucide/angular';
import { catchError, debounceTime, EMPTY, Subject, retry, switchMap } from 'rxjs';
import { SettingsFolderPicker } from '../../shared/components/settings-folder-picker/settings-folder-picker';
import { SettingsFolders } from '../../shared/components/settings-folders/settings-folders';
import { SettingsOption, SettingsOptionGroup } from '../../shared/components/settings-option-group/settings-option-group';
import { SettingsSection } from '../../shared/components/settings-section/settings-section';
import { AudioDeviceControls } from './ui/audio-device-controls/audio-device-controls';
import { StorageDevices } from './ui/storage-devices/storage-devices';
import { AudioPlayerService } from '../../shared/services/audio-player.service';
import { LayoutService } from '../../shared/services/layout.service';
import { Tooltip } from '../../shared/directives/tooltip';
import { DeviceId, InferenceDevice, OutputDirectoryStatus, SettingsService } from '../../shared/services/settings.service';

interface ReplayGainControls {
  replayGainEnabled?: () => boolean;
  replayGainMode?: () => 'track' | 'album';
  setReplayGainEnabled?: (value: boolean) => void;
  setReplayGainMode?: (value: 'track' | 'album') => void;
}

@Component({
  selector: 'app-settings',
  imports: [
    FormsModule, OverlayModule, LucideFolderOpen, LucideMenu, Tooltip,
    AudioDeviceControls, SettingsFolderPicker, SettingsFolders, SettingsOptionGroup, SettingsSection, StorageDevices,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  private readonly settingsService = inject(SettingsService);
  protected readonly layout = inject(LayoutService);
  private readonly audioPlayer = inject(AudioPlayerService) as AudioPlayerService & ReplayGainControls;
  readonly replayGainEnabled = computed(() => this.audioPlayer.replayGainEnabled?.() ?? false);
  readonly replayGainMode = computed(() => this.audioPlayer.replayGainMode?.() ?? 'track');
  private readonly saveRequests = new Subject<void>();
  readonly outputDirs = signal<string[]>([]);
  readonly defaultOutputDir = signal('');
  readonly newOutputDir = signal('');
  readonly suggestedOutputDir = signal('Path to a folder');
  readonly modelDir = signal('');
  readonly outputMode = signal<'basic' | 'full'>('basic');
  readonly outputQuality = signal<'high' | 'standard' | 'low'>('standard');
  readonly inferenceDevice = signal<DeviceId>('cpu');
  readonly devices = signal<InferenceDevice[]>([]);
  readonly outputDirsStatus = signal<OutputDirectoryStatus[]>([]);
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal('');
  readonly pickerTarget = signal<'output' | 'model' | null>(null);
  readonly pickerStartPath = signal('');
  readonly deviceOptions = computed<SettingsOption[]>(() => {
    const known = this.devices();
    const descriptions: Record<DeviceId, string> = {
      cuda: 'NVIDIA GPU acceleration',
      directml: 'Any DirectX 12 GPU on Windows',
      mps: 'Apple silicon GPU',
      vulkan: 'Cross-vendor GPU acceleration',
      cpu: 'Run on the processor',
    };
    const ids = known.length ? known.map((device) => device.id) : (['cuda', 'cpu'] as DeviceId[]);
    return ids.map((id) => ({
      value: id,
      label: this.deviceLabel(id, id.toUpperCase()),
      description: descriptions[id] ?? '',
      ...this.deviceAvailability(id, known),
    }));
  });
  readonly modeOptions: SettingsOption[] = [
    { value: 'basic', label: 'Basic', description: 'Instrumentals and vocals' },
    { value: 'full', label: 'Full', description: 'Lead & backing vocals, bass, drum, piano, others' },
  ];
  readonly qualityOptions: SettingsOption[] = [
    { value: 'high', label: 'High', description: 'FLAC, 16 bit/44.1 kHz' },
    { value: 'standard', label: 'Standard', description: 'MP3, 320kbps' },
    { value: 'low', label: 'Low', description: 'MP3, 128kbps' },
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
    ).subscribe((settings) => {
      this.outputDirsStatus.set(settings.output_dirs_status ?? this.outputDirsStatus());
      this.saved.set(true);
      this.saving.set(false);
    });

    // The backend can still be starting (first launch loads Python and torch), so retry for a while.
    this.settingsService.getSettings().pipe(retry({ count: 20, delay: 1500 })).subscribe({
      next: (settings) => {
        this.suggestedOutputDir.set(settings.suggested_output_dir || 'Path to a folder');
        const dirs = settings.output_dirs?.length ? settings.output_dirs : [settings.output_dir].filter(Boolean);
        this.outputDirs.set(dirs);
        this.defaultOutputDir.set(settings.default_output_dir || settings.output_dir || dirs[0] || '');
        this.modelDir.set(settings.model_dir ?? '');
        this.outputMode.set(settings.output_mode || 'basic');
        this.outputQuality.set(settings.output_quality || 'standard');
        this.inferenceDevice.set(settings.inference_device || 'cpu');
        this.outputDirsStatus.set(settings.output_dirs_status ?? []);
        this.loaded.set(true);
      },
      error: () => this.error.set('Could not reach the Kanta backend. Make sure it is running, then reopen Settings.'),
    });
    this.settingsService.getDevices().subscribe({ next: (devices) => this.devices.set(devices), error: () => undefined });
  }

  setOutputDirs(dirs: string[]): void { this.outputDirs.set(dirs); this.changed(); }
  setDefaultOutputDir(path: string): void { this.defaultOutputDir.set(path); this.changed(); }
  setNewOutputDir(path: string): void { this.newOutputDir.set(path); }
  setModelDir(path: string): void { this.modelDir.set(path); this.changed(); }
  setOutputMode(value: string): void { this.outputMode.set(value as 'basic' | 'full'); this.changed(); }
  setOutputQuality(value: string): void { this.outputQuality.set(value as 'high' | 'standard' | 'low'); this.changed(); }
  setInferenceDevice(value: string): void { this.inferenceDevice.set(value as DeviceId); this.changed(); }
  setReplayGainEnabled(value: boolean): void { this.audioPlayer.setReplayGainEnabled?.(value); }
  setReplayGainMode(value: 'track' | 'album'): void { this.audioPlayer.setReplayGainMode?.(value); }
  addOutputFolder(path: string): void {
    if (!path || this.outputDirs().includes(path)) return;
    const dirs = [...this.outputDirs(), path];
    this.setOutputDirs(dirs);
    if (!this.defaultOutputDir()) this.setDefaultOutputDir(path);
  }

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

  async openPicker(target: 'output' | 'model'): Promise<void> {
    const start = target === 'model' ? this.modelDir() : this.newOutputDir();
    const picked = await this.settingsService.pickFolder(target === 'model' ? 'Select models folder' : 'Select output folder', start);
    if (picked === null) return;
    if (picked) {
      if (target === 'model') this.setModelDir(picked);
      else this.addOutputFolder(picked);
      return;
    }
    this.pickerTarget.set(target);
    this.pickerStartPath.set(start);
  }

  acceptFolder(path: string): void {
    if (this.pickerTarget() === 'model') this.setModelDir(path);
    else this.addOutputFolder(path);
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
