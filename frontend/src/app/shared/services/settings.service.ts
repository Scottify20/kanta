import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';

export const API_URL = 'http://127.0.0.1:8000';

export type DeviceId = 'cuda' | 'mps' | 'directml' | 'vulkan' | 'cpu';

export interface AppSettings {
  output_dir: string;
  output_dirs: string[];
  default_output_dir: string;
  model_dir: string;
  output_mode: 'basic' | 'full';
  output_quality: 'high' | 'standard' | 'low';
  inference_device: DeviceId;
  output_dirs_status?: OutputDirectoryStatus[];
  suggested_output_dir?: string;
}

export interface LyricsProviderInfo {
  id: string;
  label: string;
  description: string;
  word_level: boolean;
  enabled: boolean;
  key_required: boolean;
  key_url: string | null;
  key_fields: { id: string; label: string; secret: boolean; value: string }[];
}

export interface LyricsSettings {
  providers: LyricsProviderInfo[];
  auto_fetch: boolean;
}

export interface OutputDirectoryStatus {
  path: string;
  available: boolean;
  writable: boolean;
  free_bytes: number | null;
}

export interface StorageDevice {
  id: string;
  label: string;
  path: string;
  removable: boolean;
  total_bytes: number | null;
  free_bytes: number | null;
  writable: boolean;
  mounted: boolean;
}

export interface InferenceDevice {
  id: DeviceId;
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

  getLyricsSettings(): Observable<LyricsSettings> {
    return this.http.get<LyricsSettings>(`${API_URL}/api/settings/lyrics`);
  }

  updateLyricsSettings(update: {
    providers?: Record<string, boolean>;
    auto_fetch?: boolean;
    order?: string[];
    keys?: Record<string, Record<string, string>>;
  }): Observable<LyricsSettings> {
    return this.http.put<LyricsSettings>(`${API_URL}/api/settings/lyrics`, update);
  }

  getSettings(): Observable<AppSettings> {
    return this.http.get<AppSettings>(`${API_URL}/api/settings`);
  }

  updateSettings(settings: Pick<
    AppSettings,
    'output_dirs' | 'default_output_dir' | 'model_dir' | 'output_mode' | 'output_quality' | 'inference_device'
  >): Observable<AppSettings> {
    return this.http.put<AppSettings>(`${API_URL}/api/settings`, settings);
  }

  // Partial update: the backend keeps whatever is not sent.
  patchSettings(settings: Partial<Pick<
    AppSettings,
    'output_dirs' | 'default_output_dir' | 'model_dir' | 'output_mode' | 'output_quality' | 'inference_device'
  >>): Observable<AppSettings> {
    return this.http.put<AppSettings>(`${API_URL}/api/settings`, settings);
  }

  // Native OS folder dialog: Tauri's dialog plugin in the desktop app, the backend host's dialog otherwise.
  // Resolves to undefined when no native dialog is available so callers can fall back.
  async pickFolder(title: string, start = ''): Promise<string | null | undefined> {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false, title, defaultPath: start || undefined });
        return typeof picked === 'string' ? picked : null;
      } catch {
        return undefined;
      }
    }
    try {
      const result = await firstValueFrom(this.http.post<{ path: string | null }>(`${API_URL}/api/fs/pick-folder`, { title, start }));
      return result.path;
    } catch {
      return undefined;
    }
  }

  getStorageDevices(): Observable<StorageDevice[]> {
    return this.http.get<StorageDevice[]>(`${API_URL}/api/fs/devices`);
  }

  getDevices(): Observable<InferenceDevice[]> {
    return this.http.get<InferenceDevice[]>(`${API_URL}/api/settings/devices`);
  }

  browseFolders(path = ''): Observable<BrowseFoldersResponse> {
    const params = new HttpParams().set('path', path);
    return this.http.get<BrowseFoldersResponse>(`${API_URL}/api/fs/browse`, { params });
  }
}
