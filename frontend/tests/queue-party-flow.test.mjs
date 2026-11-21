import '@angular/compiler';
import { HttpClient } from '@angular/common/http';
import { createEnvironmentInjector, Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import { QueueService } from '../src/app/features/queue/data-access/queue.service.ts';

describe('queue party assignment events', () => {
  it('emits newly added processed karaoke items for session-only assignment', async () => {
    const item = {
      task_id: 'task-1',
      artist: 'Artist',
      album: 'Album',
      title: 'Duet',
      raw_title: 'Duet',
      raw_artist: 'Artist',
      raw_album: 'Album',
      priority: 1,
      is_duet: true,
      status: 'completed',
    };
    const http = { post: vi.fn(() => of({ item })) };
    const injector = createEnvironmentInjector([
      { provide: HttpClient, useValue: http },
    ], Injector.NULL);
    const queue = runInInjectionContext(injector, () => new QueueService());
    const added = vi.fn();
    queue.trackAdded$.subscribe(added);

    await firstValueFrom(queue.addProcessedTrack(item));

    expect(added).toHaveBeenCalledOnce();
    expect(added).toHaveBeenCalledWith(item);
    injector.destroy();
  });
});
