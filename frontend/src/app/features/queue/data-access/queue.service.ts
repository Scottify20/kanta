import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  Subject,
  catchError,
  exhaustMap,
  filter,
  forkJoin,
  merge,
  shareReplay,
  startWith,
  tap,
  timeout,
  timer,
} from 'rxjs';

import { QueueItem, QueuePriority, QueueSnapshot } from '../interfaces/queue.models';

export const QUEUE_API_URL = 'http://127.0.0.1:8000';

const POLL_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 20000;

const EMPTY_QUEUE_SNAPSHOT: QueueSnapshot = {
  karaoke_queue: [],
  processing_queue: [],
  current_task: null,
};

@Injectable({ providedIn: 'root' })
export class QueueService {
  private readonly http = inject(HttpClient);
  private readonly refresh$ = new BehaviorSubject<void>(undefined);

  // Emits the removed task id, or null when the whole karaoke queue was cleared.
  readonly karaokeRemoved$ = new Subject<string | null>();

  // Live snapshot: SSE when the backend supports it, otherwise non-overlapping polling.
  // Failed or slow requests never replace the last known snapshot with an empty one.
  readonly queue$: Observable<QueueSnapshot> = new Observable<QueueSnapshot>((subscriber) => {
    let streaming = false;
    const source = typeof EventSource === 'undefined' ? null : new EventSource(`${QUEUE_API_URL}/api/queue/stream`);
    if (source) {
      source.onopen = () => (streaming = true);
      source.onmessage = (event) => {
        try {
          subscriber.next(JSON.parse(event.data) as QueueSnapshot);
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => (streaming = false);
    }
    const polling = merge(timer(0, POLL_INTERVAL_MS).pipe(filter(() => !streaming)), this.refresh$)
      .pipe(
        exhaustMap(() =>
          this.http.get<QueueSnapshot>(`${QUEUE_API_URL}/api/queue`).pipe(
            timeout(REQUEST_TIMEOUT_MS),
            catchError(() => EMPTY),
          ),
        ),
      )
      .subscribe((snapshot) => subscriber.next(snapshot));
    return () => {
      source?.close();
      polling.unsubscribe();
    };
  }).pipe(
    startWith(EMPTY_QUEUE_SNAPSHOT),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  refresh(): void {
    this.refresh$.next();
  }

  addTrack(file: File, priority: QueuePriority = 2): Observable<{ item: QueueItem }> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('priority', String(priority));
    return this.http
      .post<{ item: QueueItem }>(`${QUEUE_API_URL}/api/queue/add`, formData)
      .pipe(tap(() => this.refresh()));
  }

  addProcessedTrack(
    song: Pick<QueueItem, 'artist' | 'album' | 'title'>,
    playNext = false,
    afterTaskId: string | null = null,
  ): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(`${QUEUE_API_URL}/api/queue/add-processed`, {
        ...song,
        play_next: playNext,
        after_task_id: afterTaskId,
      })
      .pipe(tap(() => this.refresh()));
  }

  promoteTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(
        `${QUEUE_API_URL}/api/queue/promote/${encodeURIComponent(taskId)}`,
        {},
      )
      .pipe(tap(() => this.refresh()));
  }

  removeTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .delete<{ item: QueueItem }>(`${QUEUE_API_URL}/api/queue/${encodeURIComponent(taskId)}`)
      .pipe(
        tap(() => {
          this.karaokeRemoved$.next(taskId);
          this.refresh();
        }),
      );
  }

  clearQueue(priority: QueuePriority): Observable<{ message: string }> {
    const queueName = priority === 1 ? 'karaoke' : 'processing';
    return this.http
      .delete<{ message: string }>(`${QUEUE_API_URL}/api/queue/clear/${queueName}`)
      .pipe(
        tap(() => {
          if (priority === 1) this.karaokeRemoved$.next(null);
          this.refresh();
        }),
      );
  }

  removeKaraokeTrack(taskId: string): Observable<{ message: string }> {
    return this.http
      .delete<{ message: string }>(
        `${QUEUE_API_URL}/api/queue/karaoke/${encodeURIComponent(taskId)}`,
      )
      .pipe(
        tap(() => {
          this.karaokeRemoved$.next(taskId);
          this.refresh();
        }),
      );
  }

  clearAllQueue(): Observable<[{ message: string }, { message: string }]> {
    return forkJoin([this.clearQueue(1), this.clearQueue(2)]).pipe(tap(() => this.refresh()));
  }

  pauseTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(
        `${QUEUE_API_URL}/api/queue/pause/${encodeURIComponent(taskId)}`,
        {},
      )
      .pipe(tap(() => this.refresh()));
  }

  resumeTrack(taskId: string): Observable<{ item: QueueItem }> {
    return this.http
      .post<{ item: QueueItem }>(
        `${QUEUE_API_URL}/api/queue/resume/${encodeURIComponent(taskId)}`,
        {},
      )
      .pipe(tap(() => this.refresh()));
  }

  pauseAll(): Observable<{ message: string }> {
    return this.http
      .post<{ message: string }>(`${QUEUE_API_URL}/api/queue/pause-all`, {})
      .pipe(tap(() => this.refresh()));
  }

  resumeAll(): Observable<{ message: string }> {
    return this.http
      .post<{ message: string }>(`${QUEUE_API_URL}/api/queue/resume-all`, {})
      .pipe(tap(() => this.refresh()));
  }

  reorderKaraokeTracks(karaokeQueue: string[]): Observable<{ message: string }> {
    return this.http.patch<{ message: string }>(`${QUEUE_API_URL}/api/queue/reorder`, {
      karaoke_queue: karaokeQueue,
    });
  }
}
