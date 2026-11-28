import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_URL } from '../../app.config';

export interface ArtistInfo {
  name: string;
  bio: string | null;
  photo_url: string | null;
  source_url: string | null;
  sources: string[];
}

interface StoredArtistEntry {
  at: number;
  info: ArtistInfo | null;
}

const MAX_PARALLEL = 2;
const STORAGE_KEY = 'kanta-artist-info-v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORED = 250;

const keyOf = (name: string): string => name.trim().normalize('NFKC').toLocaleLowerCase();

/** Artist bios and photos from the backend lookup; requests are queued and cached persistently. */
@Injectable({ providedIn: 'root' })
export class ArtistInfoService {
  private readonly http = inject(HttpClient);
  private readonly cache = signal<ReadonlyMap<string, ArtistInfo | null>>(this.loadStored());
  private readonly pending: { name: string; folder?: string }[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  info(name: string): ArtistInfo | null {
    return this.cache().get(keyOf(name)) ?? null;
  }

  request(name: string, folder?: string): void {
    const key = keyOf(name);
    if (!name.trim() || this.cache().has(key) || this.queued.has(key)) return;
    this.queued.add(key);
    this.pending.push({ name: name.trim(), folder });
    this.pump();
  }

  private pump(): void {
    while (this.running < MAX_PARALLEL && this.pending.length) {
      const { name, folder } = this.pending.shift()!;
      this.running++;
      firstValueFrom(
        this.http.get<ArtistInfo>(`${API_URL}/api/artists/info`, {
          params: folder ? { name, folder } : { name },
        }),
      )
        .then((info) => this.store(name, info.bio || info.photo_url ? info : null))
        .catch((error: unknown) => {
          console.error('Could not load artist information:', error);
          this.store(name, null);
        })
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
    this.schedulePersist();
  }

  private loadStored(): ReadonlyMap<string, ArtistInfo | null> {
    const map = new Map<string, ArtistInfo | null>();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return map;
      const parsed = JSON.parse(raw) as Record<string, StoredArtistEntry>;
      const cutoff = Date.now() - CACHE_TTL_MS;
      for (const [key, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.at === 'number' && entry.at >= cutoff) {
          map.set(key, entry.info ?? null);
        }
      }
    } catch {
      // ignore corrupted storage
    }
    return map;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const now = Date.now();
        const out: Record<string, StoredArtistEntry> = {};
        let count = 0;
        for (const [key, info] of this.cache().entries()) {
          if (count >= MAX_STORED) break;
          // Persist found entries; allow missing ones to retry after reload.
          if (info) {
            out[key] = { at: now, info };
            count++;
          }
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
      } catch {
        // ignore storage quota errors
      }
    }, 500);
  }
}