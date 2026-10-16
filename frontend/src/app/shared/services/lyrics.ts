import { Injectable, signal } from '@angular/core';
import {
  ProviderChain,
  createBLyricsProvider,
  createLRCLibSyncedProvider,
} from '@braccato/provider-blyrics';
import { parseLRC, parseTTMLContent } from '@braccato/parsers';
import type { Lyric } from '@braccato/parsers';
import type { LyricsLevel } from './songs.service';

export interface SongQuery {
  artistName: string;
  trackName: string;
  albumName?: string;
  duration?: number; // duration in milliseconds
}

interface ItunesSearchResponse {
  results?: Array<{
    previewUrl?: string;
  }>;
}

@Injectable({
  providedIn: 'root',
})
export class LyricsService {
  private chain = new ProviderChain();
  private requestController: AbortController | null = null;

  // Reactive state for components to consume
  readonly lyrics = signal<Lyric[] | null>(null);
  readonly lyricsLevel = signal<LyricsLevel>('none');
  readonly previewUrl = signal<string | null>(null);
  readonly audioUrl = signal<string | null>(null);
  readonly selectedFileName = signal<string | null>(null);
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // Prefer the TTML provider routed through FastAPI to bypass CORS
    this.chain.register({
      key: 'blyrics',
      displayName: 'Better Lyrics',
      syncType: 'word',
      fetch: createBLyricsProvider({
        apiUrl: 'http://127.0.0.1:8000/api/blyrics/getLyrics',
      }),
    });
    this.chain.register({
      key: 'lrclib',
      displayName: 'LRCLIB',
      syncType: 'line',
      fetch: createLRCLibSyncedProvider(),
    });
  }

  async fetchLyrics(query: SongQuery, preserveExisting = false): Promise<boolean> {
    this.requestController?.abort();
    const requestController = new AbortController();
    this.requestController = requestController;
    const existingLyrics = preserveExisting ? this.lyrics() : null;
    this.isLoading.set(true);
    this.error.set(null);
    if (!preserveExisting) {
      this.lyrics.set(null);
      this.lyricsLevel.set('none');
    }
    this.previewUrl.set(null);
    this.chain.clearCache();

    try {
      const trackName = this.removeParenthesizedText(query.trackName);
      const durationInSeconds =
        query.duration && query.duration > 0
          ? Math.min(3600, Math.max(1, Math.round(query.duration / 1000)))
          : 1;
      const [result, previewUrl] = await Promise.all([
        this.chain.fetchLyrics({
          song: trackName,
          artist: query.artistName,
          album: query.albumName,
          duration: durationInSeconds,
          signal: requestController.signal,
        }),
        this.findPreviewUrl({ ...query, trackName }, requestController.signal),
      ]);

      if (this.requestController !== requestController) {
        return false;
      }
      this.previewUrl.set(previewUrl);

      if (result?.lyrics?.length) {
        this.lyrics.set(result.lyrics);
        this.lyricsLevel.set(this.classifyParsedLyrics(result.lyrics));
        return true;
      }
      if (!existingLyrics?.length) {
        this.lyrics.set(null);
        this.lyricsLevel.set('none');
        this.error.set('No synchronized lyrics found for this track.');
      }
      return false;
    } catch (error: unknown) {
      if (requestController.signal.aborted) {
        return false;
      }
      if (!existingLyrics?.length) {
        this.error.set(error instanceof Error ? error.message : 'Error fetching lyrics.');
        this.lyrics.set(null);
        this.lyricsLevel.set('none');
      }
      return false;
    } finally {
      if (this.requestController === requestController) {
        this.requestController = null;
        this.isLoading.set(false);
      }
    }
  }

  async loadStoredLyrics(url: string, level?: LyricsLevel): Promise<boolean> {
    this.requestController?.abort();
    const requestController = new AbortController();
    this.requestController = requestController;
    this.isLoading.set(true);
    this.error.set(null);
    this.lyrics.set(null);
    this.lyricsLevel.set('none');

    try {
      const response = await fetch(url, { signal: requestController.signal });
      if (!response.ok) {
        throw new Error(`Could not load stored lyrics (${response.status}).`);
      }
      const text = await response.text();
      if (this.requestController !== requestController) return false;
      const lyrics = url.toLowerCase().endsWith('.ttml')
        ? parseTTMLContent(text).lyrics
        : parseLRC(text, 0);
      this.lyrics.set(lyrics.length ? lyrics : null);
      this.lyricsLevel.set(lyrics.length ? (level ?? this.classifyParsedLyrics(lyrics)) : 'none');
      if (!lyrics.length) {
        this.error.set('Stored lyrics are empty.');
      }
      return lyrics.length > 0;
    } catch (error: unknown) {
      if (requestController.signal.aborted) {
        return false;
      }
      this.error.set(error instanceof Error ? error.message : 'Could not load stored lyrics.');
      this.lyrics.set(null);
      this.lyricsLevel.set('none');
      return false;
    } finally {
      if (this.requestController === requestController) {
        this.requestController = null;
        this.isLoading.set(false);
      }
    }
  }

  clearLyrics(): void {
    this.requestController?.abort();
    this.requestController = null;
    this.releaseLocalAudio();
    this.lyrics.set(null);
    this.lyricsLevel.set('none');
    this.previewUrl.set(null);
    this.error.set(null);
    this.isLoading.set(false);
  }

  async readLocalFile(file: File): Promise<SongQuery | null> {
    this.requestController?.abort();
    this.requestController = null;
    this.isLoading.set(false);
    this.error.set(null);
    this.lyrics.set(null);
    this.lyricsLevel.set('none');
    this.previewUrl.set(null);
    this.releaseLocalAudio();
    this.audioUrl.set(URL.createObjectURL(file));
    this.selectedFileName.set(file.name);

    try {
      const { parseBlob } = await import('music-metadata');
      const metadata = await parseBlob(file, { duration: true, skipCovers: true });
      const artistName = metadata.common.artist?.trim() || metadata.common.albumartist?.trim();
      const trackName = this.removeParenthesizedText(
        metadata.common.title?.trim() || file.name.replace(/\.[^/.]+$/, '').trim(),
      );

      if (!artistName || !trackName) {
        this.error.set('The file needs an artist and title tag to search lyrics.');
        return null;
      }

      return {
        artistName,
        trackName,
        albumName: metadata.common.album?.trim() || undefined,
        duration: metadata.format.duration
          ? Math.round(metadata.format.duration * 1000)
          : undefined,
      };
    } catch (error: unknown) {
      this.error.set(
        error instanceof Error
          ? `Could not read audio tags: ${error.message}`
          : 'Could not read the audio file tags.',
      );
      return null;
    }
  }

  private async findPreviewUrl(query: SongQuery, signal: AbortSignal): Promise<string | null> {
    try {
      const search = new URL('https://itunes.apple.com/search');
      search.searchParams.set('term', `${query.artistName} ${query.trackName}`);
      search.searchParams.set('entity', 'song');
      search.searchParams.set('limit', '1');

      const response = await fetch(search, { signal });
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as ItunesSearchResponse;
      return data.results?.[0]?.previewUrl ?? null;
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error;
      }

      return null;
    }
  }

  private removeParenthesizedText(trackName: string): string {
    let cleanedTrackName = trackName;
    let previousTrackName: string;

    do {
      previousTrackName = cleanedTrackName;
      cleanedTrackName = cleanedTrackName
        .replace(/\s*\([^()[\]]*\)/g, '')
        .replace(/\s*\[[^[\]()]*\]/g, '');
    } while (cleanedTrackName !== previousTrackName);

    return cleanedTrackName.trim();
  }

  private classifyParsedLyrics(lyrics: Lyric[]): LyricsLevel {
    return lyrics.some((line) =>
      line.parts?.some((part) => part.durationMs > 0 && part.words.trim().length > 0),
    )
      ? 'word'
      : 'line';
  }

  private releaseLocalAudio(): void {
    const currentUrl = this.audioUrl();
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
    }

    this.audioUrl.set(null);
    this.selectedFileName.set(null);
  }
}
