import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_URL } from './settings.service';

export interface ArtistInfo {
  name: string;
  bio: string | null;
  photo_url: string | null;
  source_url: string | null;
  sources: string[];
}

const MAX_PARALLEL = 3;
const keyOf = (name: string): string => name.trim().toLowerCase();

/** Artist bios and photos from the backend lookup; requests are queued and cached per session. */
@Injectable({ providedIn: 'root' })
export class ArtistInfoService {
  private readonly http = inject(HttpClient);
  // null = looked up with nothing found (or failed); absent = not requested yet.
  private readonly cache = signal<ReadonlyMap<string, ArtistInfo | null>>(new Map());
  private readonly pending: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;

  info(name: string): ArtistInfo | null {
    return this.cache().get(keyOf(name)) ?? null;
  }

  request(name: string): void {
    const key = keyOf(name);
    if (!key || this.cache().has(key) || this.queued.has(key)) return;
    this.queued.add(key);
    this.pending.push(name.trim());
    this.pump();
  }

  private pump(): void {
    while (this.running < MAX_PARALLEL && this.pending.length) {
      const name = this.pending.shift()!;
      this.running++;
      firstValueFrom(
        this.http.get<ArtistInfo>(`${API_URL}/api/artists/info`, { params: { name } }),
      )
        .then((info) => this.store(name, info.bio || info.photo_url ? info : null))
        .catch(() => this.store(name, null))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private store(name: string, info: ArtistInfo | null): void {
    const key = keyOf(name);
    this.queued.delete(key);
    this.cache.update((current) => new Map(current).set(key, info));
  }
}
