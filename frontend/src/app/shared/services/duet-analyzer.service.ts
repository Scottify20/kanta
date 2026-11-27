import { Injectable } from '@angular/core';
import { YIN } from 'pitchfinder';
import type { SongManifest } from './songs.service';
import type { UserProfile } from './party-session.models';
import { findPlaybackStems } from './playback-actions.service';

@Injectable({ providedIn: 'root' })
export class DuetAnalyzerService {
  private audioCtx: AudioContext | null = null;

  async analyzeDuetParts(
    song: SongManifest,
    singers: UserProfile[],
  ): Promise<{ part1SingerId: string | null; part2SingerId: string | null }> {
    if (singers.length === 0) return { part1SingerId: null, part2SingerId: null };
    if (singers.length === 1) return { part1SingerId: singers[0].id, part2SingerId: null };

    if (!song || !song.stems || !Array.isArray(song.stems)) {
      return this.fallbackHeuristic(singers);
    }

    const stems = findPlaybackStems(song.stems);
    if (!stems?.vocals?.url) {
      return this.fallbackHeuristic(singers);
    }

    try {
      const response = await fetch(stems.vocals.url, {
        headers: { Range: 'bytes=0-1500000' },
      });
      const arrayBuffer = await response.arrayBuffer();
      this.audioCtx ??= new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      )();
      const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer.slice(0));

      const sampleRate = audioBuffer.sampleRate;
      const channelData = audioBuffer.getChannelData(0);
      const detector = YIN({ sampleRate });
      const frameSize = 2048;
      const hopSize = Math.floor(sampleRate * 0.05);
      const detectedPitches: number[] = [];

      for (let i = 0; i + frameSize < channelData.length; i += hopSize) {
        const frame = channelData.subarray(i, i + frameSize);
        let sum = 0;
        for (let j = 0; j < frame.length; j++) sum += frame[j] * frame[j];
        if (Math.sqrt(sum / frame.length) < 0.02) continue;

        const freq = detector(frame);
        if (freq && freq >= 60 && freq <= 1000) {
          detectedPitches.push(freq);
        }
      }

      if (detectedPitches.length < 20) {
        return this.fallbackHeuristic(singers);
      }

      detectedPitches.sort((a, b) => a - b);
      const lowPitch = detectedPitches[Math.floor(detectedPitches.length * 0.25)];
      const highPitch = detectedPitches[Math.floor(detectedPitches.length * 0.75)];

      return this.matchSingersToPitches(singers, lowPitch, highPitch);
    } catch {
      return this.fallbackHeuristic(singers);
    }
  }

  private matchSingersToPitches(
    singers: UserProfile[],
    _lowPitch: number,
    _highPitch: number,
  ): { part1SingerId: string; part2SingerId: string } {
    const sorted = [...singers].sort((a, b) => {
      const centerA = (a.minHz ?? 130) + (a.maxHz ?? 400);
      const centerB = (b.minHz ?? 130) + (b.maxHz ?? 400);
      return centerA - centerB;
    });

    const s1 = sorted[0];
    const s2 = sorted[sorted.length - 1];
    return {
      part1SingerId: s1.id,
      part2SingerId: s2.id !== s1.id ? s2.id : (sorted[1]?.id ?? s1.id),
    };
  }

  private fallbackHeuristic(singers: UserProfile[]): { part1SingerId: string; part2SingerId: string } {
    const sorted = [...singers].sort((a, b) => {
      const centerA = (a.minHz ?? 130) + (a.maxHz ?? 400);
      const centerB = (b.minHz ?? 130) + (b.maxHz ?? 400);
      return centerA - centerB;
    });
    return {
      part1SingerId: sorted[0].id,
      part2SingerId: sorted.length > 1 ? sorted[sorted.length - 1].id : sorted[0].id,
    };
  }
}