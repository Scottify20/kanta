import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  EMPTY,
  Observable,
  Subject,
  catchError,
  exhaustMap,
  filter,
  forkJoin,
  map,
  merge,
  shareReplay,
  startWith,
  tap,
  timeout,
  timer,
} from 'rxjs';

import { QueueItem, QueuePriority, QueueSnapshot } from '../interfaces/queue.models';
import { API_URL } from '../../../app.config';
import { cleanStemTitle } from '../../../shared/services/songs.service';

export function sanitizeQueueItem(item: QueueItem): QueueItem {
  return {
    ...item,
    raw_title: cleanStemTitle(item.raw_title),
  };
}

export function sanitizeQueueSnapshot(snapshot: QueueSnapshot): QueueSnapshot {
  return {
    ...snapshot,
    karaoke_queue: (snapshot.karaoke_queue ?? []).map(sanitizeQueueItem),
    processing_queue: (snapshot.processing_queue ?? []).map(sanitizeQueueItem),
    current_task: snapshot.current_task ? sanitizeQueueItem(snapshot.current_task) : null,
  };
}

const POLL_INITIAL_DELAY_MS = 800;
const POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;

const EMPTY_QUEUE_SNAPSHOT: QueueSnapshot = {
  karaoke_queue: [],
  processing_queue: [],
  current_task: null,
};

@Injectable({ providedIn: 'root' })
export class QueueService {
  private readonly http = inject(HttpClient);
  private readonly refresh$ = new Subject<void>();
  private streaming = false;

  readonly karaokeRemoved$ = new Subject<string | null>();
  readonly trackAdded$ = new Subject<QueueItem>();

  readonly queue$: Observable<QueueSnapshot> = new Observable<QueueSnapshot>((subscriber) => {
    this.streaming = false;
    const source = typeof EventSource === 'undefined' ? null : new EventSource(`${API_URL}/api/queue/stream`);
    const closeSource = (): void => {
      this.streaming = false;
      source?.close();
    };

    if (source) {
      source.onopen = () => (this.streaming = true);
      source.onmessage = (event) => {
        this.streaming = true;
        try {
          const raw = JSON.parse(event.data) as QueueSnapshot;
          subscriber.next(sanitizeQueueSnapshot(raw));
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => (this.streaming = false);
      if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', closeSource);
      }
    }

    const polling = merge(
      timer(source ? POLL_INITIAL_DELAY_MS : 0, POLL_INTERVAL_MS).pipe(filter(() => !this.streaming)),
      this.refresh$,
    )
      .pipe(
        exhaustMap(() =>
          this.http.get<QueueSnapshot>(`${API_URL}/api/queue`).pipe(
            map(sanitizeQueueSnapshot),
            timeout(REQUEST_TIMEOUT_MS),
            catchError(() => EMPTY),
          ),
        ),
      )
      .subscribe((snapshot) => subscriber.next(snapshot));

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', closeSource);
      }
      closeSource();
      polling.unsubscribe();
    };
  }).pipe(
    startWith(EMPTY_QUEUE_SNAPSHOT),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  refresh(force = true): void {
    if (force || !this.streaming) {
      this.refresh$.next();
    }
  }

  addTrack(
    file: File,
    priority: QueuePriority = 2,
    lyrics?: File,
  ): Observable<{ item: QueueItem | null; skipped?: 'already_in_library' | 'already_queued' | null }> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('priority', String(priority));
    if (lyrics) formData.append('lyrics', lyrics, lyrics.name);
    return this.http
      .post<{ item: QueueItem | null; skipped?: 'already_in_library' | 'already_queued' | null }>(`${API_URL}/api/queue/add`, formData)
      .pipe(
        map((res) => (res.item ? { ...res, item: sanitizeQueueItem(res.item) } : res)),
        tap(({ item }) => {
          if (item) this.trackAdded$.next(item);
          this.refresh(false);
        }),
      );
  }

  addProcessedTrack(
    song: Pick<QueueItem, 'artist' | 'album' | 'title'>,
    playNext = false,
    afterTaskId: string | null = null,
    allowDuplicate = true,
  ): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(`${API_URL}/api/queue/add-processed`, {
        ...song,
        play_next: playNext,
        after_task_id: afterTaskId,
        allow_duplicate: allowDuplicate,
      })
      .pipe(
        map((res) => ({ ...res, item: sanitizeQueueItem(res.item) })),
        tap(({ item }) => {
          this.trackAdded$.next(item);
          this.refresh(false);
        }),
      );
  }

  promoteTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(
        `${API_URL}/api/queue/promote/${encodeURIComponent(taskId)}`,
        {},
      )
      .pipe(
        map((res) => ({ ...res, item: sanitizeQueueItem(res.item) })),
        tap(() => this.refresh(false)),
      );
  }

  removeTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .delete<{ item: QueueItem }>(`${API_URL}/api/queue/${encodeURIComponent(taskId)}`)
      .pipe(
        map((res) => ({ ...res, item: sanitizeQueueItem(res.item) })),
        tap(() => {
          this.karaokeRemoved$.next(taskId);
          this.refresh(false);
        }),
      );
  }

  clearQueue(priority: QueuePriority): Observable<{ message: string }> {
    const queueName = priority === 1 ? 'karaoke' : 'processing';
    return this.http
      .delete<{ message: string }>(`${API_URL}/api/queue/clear/${queueName}`)
      .pipe(
        tap(() => {
          if (priority === 1) this.karaokeRemoved$.next(null);
          this.refresh(false);
        }),
      );
  }

  removeKaraokeTrack(taskId: string): Observable<{ message: string }> {
    return this.http
      .delete<{ message: string }>(
        `${API_URL}/api/queue/karaoke/${encodeURIComponent(taskId)}`,
      )
      .pipe(
        tap(() => {
          this.karaokeRemoved$.next(taskId);
          this.refresh(false);
        }),
      );
  }

  clearAllQueue(): Observable<[{ message: string }, { message: string }]> {
    return forkJoin([this.clearQueue(1), this.clearQueue(2)]).pipe(tap(() => this.refresh(false)));
  }

  pauseTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(
        `${API_URL}/api/queue/pause/${encodeURIComponent(taskId)}`,
        {},
      )
      .pipe(
        map((res) => ({ ...res, item: sanitizeQueueItem(res.item) })),
        tap(() => this.refresh(false)),
      );
  }

  resumeTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(
        `${API_URL}/api/queue/resume/${encodeURIComponent(taskId)}`,
        {},
      )
      .pipe(
        map((res) => ({ ...res, item: sanitizeQueueItem(res.item) })),
        tap(() => this.refresh(false)),
      );
  }

  pauseAll(): Observable<{ message: string }> {
    return this.http
      .post<{ message: string }>(`${API_URL}/api/queue/pause-all`, {})
      .pipe(tap(() => this.refresh(false)));
  }

  resumeAll(): Observable<{ message: string }> {
    return this.http
      .post<{ message: string }>(`${API_URL}/api/queue/resume-all`, {})
      .pipe(tap(() => this.refresh(false)));
  }

  reorderProcessingTracks(processingQueue: string[]): Observable<{ message: string }> {
    return this.http.patch<{ message: string }>(`${API_URL}/api/queue/reorder-processing`, {
      processing_queue: processingQueue,
    });
  }

  reorderKaraokeTracks(karaokeQueue: string[]): Observable<{ message: string }> {
    return this.http.patch<{ message: string }>(`${API_URL}/api/queue/reorder`, {
      karaoke_queue: karaokeQueue,
    });
  }
}