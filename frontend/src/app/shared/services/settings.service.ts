import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export const API_URL = 'http://127.0.0.1:8000';

export interface AppSettings {
  output_dir: string;
  output_dirs: string[];
  default_output_dir: string;
  model_dir: string;
  output_mode: 'basic' | 'full';
  output_quality: 'high' | 'standard' | 'low';
  inference_device: 'cuda' | 'vulkan' | 'cpu';
}

export interface InferenceDevice {
  id: 'cuda' | 'vulkan' | 'cpu';
  label: string;
  available: boolean;
}

export interface BrowseFoldersResponse {
  path: string;
  parent: string | null;
  dirs: string[];
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly http = inject(HttpClient);

  getSettings(): Observable<AppSettings> {
    return this.http.get<AppSettings>(`${API_URL}/api/settings`);
  }

  updateSettings(settings: Pick<
    AppSettings,
    'output_dirs' | 'default_output_dir' | 'model_dir' | 'output_mode' | 'output_quality' | 'inference_device'
  >): Observable<AppSettings> {
    return this.http.put<AppSettings>(`${API_URL}/api/settings`, settings);
  }

  getDevices(): Observable<InferenceDevice[]> {
    return this.http.get<InferenceDevice[]>(`${API_URL}/api/settings/devices`);
  }

  browseFolders(path = ''): Observable<BrowseFoldersResponse> {
    const params = new HttpParams().set('path', path);
    return this.http.get<BrowseFoldersResponse>(`${API_URL}/api/fs/browse`, { params });
  }
}
