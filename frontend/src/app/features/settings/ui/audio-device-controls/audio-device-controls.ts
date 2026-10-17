import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { LucideMic, LucideMicOff, LucideRefreshCw, LucideVolume2 } from '@lucide/angular';
import { Select } from '../../../../shared/components/select/select';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { AudioPlayerService } from '../../../../shared/services/audio-player.service';
import { MicTestService } from '../mic-test/mic-test.service';

interface DeviceChoice { id: string; label: string; }

@Component({
  selector: 'app-settings-audio-device-controls',
  imports: [Select, LucideMic, LucideMicOff, LucideRefreshCw, LucideVolume2, Tooltip],
  templateUrl: './audio-device-controls.html',
  styleUrl: './audio-device-controls.scss',
})
export class AudioDeviceControls implements OnInit, OnDestroy {
  readonly outputs = signal<DeviceChoice[]>([]);
  readonly inputs = signal<DeviceChoice[]>([]);
  readonly outputOptions = computed(() => [
    { value: '', label: 'System default' },
    ...this.outputs().map((d) => ({ value: d.id, label: d.label })),
  ]);
  readonly inputOptions = computed(() => [
    { value: '', label: 'System default' },
    ...this.inputs().map((d) => ({ value: d.id, label: d.label })),
  ]);
  readonly outputId = signal('');
  readonly inputId = signal('');
  readonly outputRoutingAvailable = signal(false);
  readonly monitor = signal(false);
  readonly namesHidden = signal(false);
  readonly mic = inject(MicTestService);
  readonly peakPercent = () => Math.round(this.mic.peak() * 100);
  private readonly player = inject(AudioPlayerService);
  private readonly onDeviceChange = (): void => { void this.refreshDevices(); };

  ngOnInit(): void {
    this.outputId.set(this.readStorage('kanta.audioOutputDeviceId'));
    this.inputId.set(this.readStorage('kanta.microphoneDeviceId'));
    this.player.setOutputDevice(this.outputId());
    this.detectOutputRouting();
    void this.refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
  }

  ngOnDestroy(): void {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.mic.stop();
  }

  async refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Chromium (WebView2 on Windows) lists "default"/"communications" aliases of real devices.
      const real = (kind: MediaDeviceKind) =>
        devices.filter((device) => device.kind === kind && device.deviceId !== 'default' && device.deviceId !== 'communications');
      const clean = (label: string) => label.replace(/^(default|communications) - /i, '');
      // Device names stay blank until the page has been granted microphone access once.
      this.namesHidden.set(devices.some((device) => device.kind !== 'videoinput' && !device.label));
      this.outputs.set(real('audiooutput').map((device, i) => ({
        id: device.deviceId, label: clean(device.label) || `Audio output ${i + 1}`,
      })));
      this.inputs.set(real('audioinput').map((device, i) => ({
        id: device.deviceId, label: clean(device.label) || `Microphone ${i + 1}`,
      })));
      if (this.mic.running() && this.inputId() && !this.inputs().some((device) => device.id === this.inputId())) {
        this.mic.markUnplugged();
      }
      if (this.outputId() && !this.outputs().some((device) => device.id === this.outputId())) {
        this.outputId.set('');
        this.player.setOutputDevice('');
        this.writeStorage('kanta.audioOutputDeviceId', '');
      }
      if (this.inputId() && !this.inputs().some((device) => device.id === this.inputId())) {
        this.inputId.set('');
        this.writeStorage('kanta.microphoneDeviceId', '');
      }
    } catch { /* Device enumeration is optional in restricted webviews. */ }
  }

  changeOutput(id: string): void {
    this.outputId.set(id);
    this.writeStorage('kanta.audioOutputDeviceId', id);
    this.player.setOutputDevice(id);
  }

  changeInput(id: string): void {
    if (this.mic.running()) this.mic.stop();
    this.inputId.set(id);
    this.writeStorage('kanta.microphoneDeviceId', id);
  }

  async toggleMicTest(): Promise<void> {
    if (this.mic.running()) {
      this.mic.stop();
      return;
    }
    await this.mic.start(this.inputId());
    if (this.mic.running()) void this.refreshDevices();
  }

  // Asking for the microphone once makes the webview reveal real device names.
  async revealDeviceNames(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
    } catch { /* Denied: names stay generic. */ }
    await this.refreshDevices();
  }

  setMonitor(enabled: boolean): void {
    this.monitor.set(enabled);
    this.mic.setMonitor(enabled);
  }

  private detectOutputRouting(): void {
    const media = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
    const context = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    this.outputRoutingAvailable.set(media || context);
  }

  private readStorage(key: string): string {
    try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
  }

  private writeStorage(key: string, value: string): void {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  }
}
