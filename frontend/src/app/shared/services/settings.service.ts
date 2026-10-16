import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export const API_URL = 'http://127.0.0.1:8000';

export interface AppSettings {
  output_dir: string;
  output_dirs: string[];
  default_output_dir: string;
  model_dir: string;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly http = inject(HttpClient);

  getSettings(): Observable<AppSettings> {
    return this.http.get<AppSettings>(`${API_URL}/api/settings`);
  }

  updateSettings(
    settings: Pick<AppSettings, 'output_dirs' | 'default_output_dir' | 'model_dir'>,
  ): Observable<AppSettings> {
    return this.http.put<AppSettings>(`${API_URL}/api/settings`, settings);
  }
}
