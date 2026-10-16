import { Component, OnInit, input, output, inject, signal } from '@angular/core';
import { LucideHardDrive, LucideRefreshCw } from '@lucide/angular';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { OutputDirectoryStatus, SettingsService, StorageDevice } from '../../../../shared/services/settings.service';

@Component({
  selector: 'app-settings-storage-devices',
  imports: [LucideHardDrive, LucideRefreshCw, Tooltip],
  templateUrl: './storage-devices.html',
  styleUrl: './storage-devices.scss',
})
export class StorageDevices implements OnInit {
  readonly configuredPaths = input.required<string[]>();
  readonly statuses = input<OutputDirectoryStatus[]>([]);
  readonly addPath = output<string>();
  readonly devices = signal<StorageDevice[]>([]);
  readonly loading = signal(false);
  readonly unavailable = signal(false);
  private readonly settings = inject(SettingsService);

  ngOnInit(): void { this.refresh(); }

  refresh(): void {
    this.loading.set(true);
    this.unavailable.set(false);
    this.settings.getStorageDevices().subscribe({
      next: (devices) => { this.devices.set(devices); this.loading.set(false); },
      error: () => { this.devices.set([]); this.unavailable.set(true); this.loading.set(false); },
    });
  }

  add(device: StorageDevice): void {
    if (!device.mounted || !device.writable) return;
    const separator = /[\\]/.test(device.path) || /^[A-Za-z]:/.test(device.path) ? '\\' : '/';
    const path = device.path.replace(/[\\/]+$/, '');
    this.addPath.emit(`${path}${separator}Kanta`);
  }

  usage(device: StorageDevice): number {
    if (!device.total_bytes || !Number.isFinite(device.free_bytes)) return 0;
    return Math.max(0, Math.min(100, 100 * (device.total_bytes - (device.free_bytes ?? 0)) / device.total_bytes));
  }

  status(path: string): OutputDirectoryStatus | undefined {
    return this.statuses().find((item) => item.path === path);
  }

  formatBytes(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'Storage space unavailable';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]} free`;
  }
}
