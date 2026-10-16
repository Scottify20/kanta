import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { QueueService, QUEUE_API_URL } from './queue.service';
import { QueueSnapshot } from '../interfaces/queue.models';

describe('QueueService', () => {
  let service: QueueService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(QueueService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    httpTesting.verify();
  });

  it('emits immediately and keeps polling after a failed request', () => {
    vi.useFakeTimers();
    const snapshots: QueueSnapshot[] = [];
    const subscription = service.queue$.subscribe((snapshot) => snapshots.push(snapshot));

    expect(snapshots[0]).toEqual({
      karaoke_queue: [],
      processing_queue: [],
      current_task: null,
    });

    httpTesting.expectOne(`${QUEUE_API_URL}/api/queue`).flush('Unavailable', {
      status: 503,
      statusText: 'Unavailable',
    });
    expect(snapshots[1]).toEqual(snapshots[0]);

    vi.advanceTimersByTime(1500);
    const liveSnapshot: QueueSnapshot = {
      karaoke_queue: [],
      processing_queue: [],
      current_task: null,
    };
    httpTesting.expectOne(`${QUEUE_API_URL}/api/queue`).flush(liveSnapshot);
    expect(snapshots[2]).toEqual(liveSnapshot);
    subscription.unsubscribe();
  });
});
