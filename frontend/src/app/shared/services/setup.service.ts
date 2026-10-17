import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_URL } from './settings.service';
import { ToastService } from './toast.service';

export interface SetupJob {
  running: boolean;
  step: string;
  detail: string;
  progress: number;
  error: string;
  finished: boolean;
}

export interface SetupStatus {
  ffmpeg: boolean;
  models: boolean;
  models_full: boolean;
  missing_models: string[];
  ready: boolean;
  ffmpeg_downloadable: boolean;
  output_configured: boolean;
  output_dir: string;
  suggested_output_dir: string;
  output_mode: 'basic' | 'full';
  job: SetupJob;
}

@Injectable({ providedIn: 'root' })
export class SetupService {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private installing = false;
  private lastError = '';
  readonly status = signal<SetupStatus | null>(null);
  readonly dismissed = signal(false);
  readonly minimized = signal(false);
  readonly needsSetup = computed(() => {
    const status = this.status();
    return !!status && !this.dismissed() && (!status.ready || !status.output_configured || status.job.running);
  });

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    let next: SetupStatus;
    try {
      next = await firstValueFrom(this.http.get<SetupStatus>(`${API_URL}/api/setup/status`));
    } catch {
      this.poll(500); // backend still starting
      return;
    }
    this.announce(this.status(), next);
    this.status.set(next);
    if (next.job.running) this.poll();
    else this.installing = false;
  }

  async install(full: boolean): Promise<void> {
    this.installing = true;
    this.lastError = '';
    try {
      this.status.set(
        await firstValueFrom(this.http.post<SetupStatus>(`${API_URL}/api/setup/install`, { full })),
      );
    } catch {
      this.installing = false;
      this.toast.error('Could not start the download. Is the Kanta backend running?');
      return;
    }
    this.poll(500);
  }

  dismiss(): void {
    this.dismissed.set(true);
  }

  private announce(prev: SetupStatus | null, next: SetupStatus): void {
    if (!prev || !this.installing) return;
    if (!prev.ffmpeg && next.ffmpeg) this.toast.success('ffmpeg downloaded');
    if (!prev.models && next.models) this.toast.success('Separation models downloaded');
    if (!prev.models_full && next.models_full && next.models) this.toast.success('Full separation models downloaded');
    if (next.job.error && next.job.error !== this.lastError) {
      this.lastError = next.job.error;
      this.toast.error(`Download failed: ${next.job.error}`);
    }
    if (!prev.job.finished && next.job.finished) this.toast.success('Setup complete. Kanta is ready to process songs.');
  }

  private poll(delay = 800): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }
}
