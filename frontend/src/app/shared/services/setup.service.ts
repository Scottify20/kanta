import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_URL } from './settings.service';

export interface SetupStatus {
  ffmpeg: boolean;
  models: boolean;
  missing_models: string[];
  ready: boolean;
  ffmpeg_downloadable: boolean;
  job: { running: boolean; step: string; done: number; total: number; error: string };
}

@Injectable({ providedIn: 'root' })
export class SetupService {
  private readonly http = inject(HttpClient);
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly status = signal<SetupStatus | null>(null);
  readonly dismissed = signal(false);
  readonly needsSetup = computed(() => {
    const status = this.status();
    return !!status && !status.ready && !this.dismissed();
  });

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const status = await firstValueFrom(this.http.get<SetupStatus>(`${API_URL}/api/setup/status`));
      this.status.set(status);
      if (status.job.running) this.poll();
    } catch {
      // Backend not reachable yet; retry shortly.
      this.poll(2000);
    }
  }

  async install(): Promise<void> {
    try {
      this.status.set(await firstValueFrom(this.http.post<SetupStatus>(`${API_URL}/api/setup/install`, {})));
    } catch {
      return;
    }
    this.poll();
  }

  dismiss(): void {
    this.dismissed.set(true);
  }

  private poll(delay = 1000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }
}
