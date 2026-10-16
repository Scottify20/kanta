import type { LyricsLevel } from '../../../shared/services/songs.service';

export type QueuePriority = 1 | 2;

export type QueueItemStatus =
  'pending' | 'processing' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export type { LyricsLevel } from '../../../shared/services/songs.service';

export interface QueueItem {
  task_id: string;
  file_path: string;
  raw_title: string;
  raw_artist: string;
  raw_album: string;
  title: string;
  artist: string;
  album: string;
  priority: QueuePriority;
  status: QueueItemStatus;
  progress: number;
  step: string;
  position: number;
  output_dir?: string | null;
  cover_url?: string | null;
  lyrics_level?: LyricsLevel;
  lyrics_offset_ms?: number;
  error?: string | null;
}

export interface QueueSnapshot {
  karaoke_queue: QueueItem[];
  processing_queue: QueueItem[];
  current_task: QueueItem | null;
  processing_paused?: boolean;
}
