import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AudioPlayerService } from '../../services/audio-player.service';

interface DeviceChoice { id: string; label: string; }

@Component({
  selector: 'app-settings-audio-devices',
  imports: [FormsModule],
  templateUrl: './settings-audio-devices.html',
  styleUrl: './settings-audio-devices.scss',
})
export class SettingsAudioDevices implements OnInit, OnDestroy {
  readonly outputs = signal<DeviceChoice[]>([]);
  readonly inputs = signal<DeviceChoice[]>([]);
  readonly outputId = signal('');
  readonly inputId = signal('');
  private readonly player = inject(AudioPlayerService);
  private readonly onDeviceChange = (): void => { void this.refreshDevices(); };

  ngOnInit(): void {
    this.outputId.set(this.readStorage('kanta.audioOutputDeviceId'));
    this.inputId.set(this.readStorage('kanta.microphoneDeviceId'));
    this.player.setOutputDevice(this.outputId());
    void this.refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
  }

  ngOnDestroy(): void {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
  }

  async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.outputs.set(devices.filter((device) => device.kind === 'audiooutput').map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Audio output ${index + 1}`,
      })));
      this.inputs.set(devices.filter((device) => device.kind === 'audioinput').map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      })));
      if (this.outputId() && !this.outputs().some((device) => device.id === this.outputId())) {
        this.outputId.set('');
        this.writeStorage('kanta.audioOutputDeviceId', '');
        this.player.setOutputDevice('');
      }
      if (this.inputId() && !this.inputs().some((device) => device.id === this.inputId())) {
        this.inputId.set('');
        this.writeStorage('kanta.microphoneDeviceId', '');
      }
    } catch { /* Device enumeration is optional; keep selectors in their empty state. */ }
  }

  changeOutput(id: string): void {
    this.outputId.set(id);
    this.writeStorage('kanta.audioOutputDeviceId', id);
    this.player.setOutputDevice(id);
  }

  changeInput(id: string): void {
    this.inputId.set(id);
    this.writeStorage('kanta.microphoneDeviceId', id);
  }

  private readStorage(key: string): string {
    try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
  }

  private writeStorage(key: string, value: string): void {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch { /* Storage can be unavailable in restricted webviews. */ }
  }
}
