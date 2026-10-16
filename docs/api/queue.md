# Queue API

**Navigation:** [Home](../README.md) | [API guide](README.md) | **Queue API** | [Separation API](separation.md) | [Songs and media](songs.md) | [Frontend playback](../frontend/playback.md)

All queue endpoints use the `/api/queue` prefix. The queue worker starts with FastAPI and processes jobs automatically.

## Queue model

Kanta exposes two separate queue views:

- **Karaoke Queue:** an ordered playback list. It contains processed library songs and karaoke uploads, including placeholders while those uploads are still processing.
- **Processing Queue:** the actual worker jobs. A karaoke upload appears here once, with the same `task_id` as its Karaoke Queue entry. Processing-only uploads appear only here.

Priority `1` selects full karaoke separation; priority `2` selects basic separation. Worker order uses priority and processing position. Reordering Karaoke Queue changes playback order only and never changes worker order. Processed library songs do not enter the worker queue. Adding one refreshes the queue presentation without clearing or reordering active jobs.

Only one item can be `processing` at once because the separator uses the GPU.

Queue state is persisted in `backend/queue_state.json`. Pending and paused uploads can be restored after a backend restart when their temporary input still exists. Karaoke playback order is persisted separately from worker order.

## Add a track

`POST /api/queue/add`

Send a multipart form with:

- `file`: audio file.
- `priority`: `1` for Karaoke or `2` for Processing Only. Defaults to `2`.

```bash
curl -X POST http://127.0.0.1:8000/api/queue/add \
  -F "file=@song.mp3" \
  -F "priority=1"
```

The response includes a generated `task_id`, raw metadata, sanitized path metadata, status, and position.

Important response fields:

| Field | Description |
| --- | --- |
| `task_id` | UUID used by all later operations. |
| `raw_artist`, `raw_album`, `raw_title` | Original metadata for display and lyrics lookup. |
| `artist`, `album`, `title` | Sanitized values used in output paths. |
| `priority` | `1` or `2`. |
| `status` | Initially `pending`. |
| `position` | Position within its priority queue. |

An unreadable or unsupported audio upload returns `400` and is not added to the queue.

The frontend uses priority `2` as its default. Priority `1` is an explicit user choice when dropping an external file into Karaoke Queue.

## Add a processed library song

`POST /api/queue/add-processed`

Adds an already processed song as a completed Karaoke Queue entry. It does not run separation, copy the song, or delete existing generated stems. An entry with the same artist, album, and title is not added twice. It never creates a Processing Queue job.

```bash
curl -X POST http://127.0.0.1:8000/api/queue/add-processed \
  -H "Content-Type: application/json" \
  -d '{"artist":"Artist","album":"Album","title":"Song"}'
```

## Read queue state

`GET /api/queue`

```bash
curl http://127.0.0.1:8000/api/queue
```

Response shape:

```json
{
  "karaoke_queue": [],
  "processing_queue": [],
  "current_task": null
}
```

The Karaoke Queue is ordered for playback and may contain pending, processing, completed, or failed entries. The Processing Queue contains each active worker job once, including karaoke uploads mirrored in the Karaoke Queue. It contains pending, processing, paused, and cancelling jobs; terminal jobs leave this queue. Each item includes `status`, `progress`, `step`, and `priority`.

The `current_task` field contains the active worker item or `null`; it shares its ID with its Processing Queue entry. Poll this endpoint every 1.5 seconds in the frontend.

## Reorder or move tracks

`PATCH /api/queue/reorder`

Send every Karaoke Queue item ID exactly once in its desired playback order.

```bash
curl -X PATCH http://127.0.0.1:8000/api/queue/reorder \
  -H "Content-Type: application/json" \
  -d '{
    "karaoke_queue": ["karaoke-task-id", "processed-song-id"]
  }'
```

Reordering changes only playback order. It does not modify processing priority, position, or worker state.

If the payload is incomplete, contains duplicates, or includes an unknown task ID, the request fails with `400`; no partial reorder is applied.

## Pause and resume

Pause a job:

```bash
curl -X POST http://127.0.0.1:8000/api/queue/pause/TASK_ID
```

Resume it:

```bash
curl -X POST http://127.0.0.1:8000/api/queue/resume/TASK_ID
```

Pause is cooperative. A running separation pauses at a pipeline checkpoint instead of interrupting CUDA inference in the middle of a model operation. Pausing a pending item lets the worker skip it and run another job. Pausing the active GPU job holds the single worker until that item is resumed.

For a pending task, pause takes effect immediately. For the active task, the current model operation finishes first. Resume changes a paused pending task back to `pending`, or allows a paused active task to continue.

Pause or resume the complete worker queue:

```bash
curl -X POST http://127.0.0.1:8000/api/queue/pause-all
curl -X POST http://127.0.0.1:8000/api/queue/resume-all
```

Queue-wide pause prevents pending jobs from starting and pauses the active job at its next checkpoint. Because the GPU worker is single-consumer, later jobs wait until the active job is resumed and finishes. The `processing_paused` snapshot field reports the global state.

## Cancel or remove

`DELETE /api/queue/{task_id}`

```bash
curl -X DELETE http://127.0.0.1:8000/api/queue/TASK_ID
```

Pending jobs are cancelled immediately. The active job receives a cancellation request and stops at its next pipeline checkpoint.

Cancellation is not the same as pausing: cancelled jobs cannot be resumed, and their temporary upload is removed.

Remove a task from the playback list without cancelling its processing job:

```bash
curl -X DELETE http://127.0.0.1:8000/api/queue/karaoke/TASK_ID
```

## Promote a track

`POST /api/queue/promote/{task_id}` promotes a pending Processing Only task to Karaoke priority.

```bash
curl -X POST http://127.0.0.1:8000/api/queue/promote/TASK_ID
```

## Clear a queue

Clear Karaoke Queue membership without affecting jobs, or clear the actual Processing Queue jobs:

```bash
curl -X DELETE http://127.0.0.1:8000/api/queue/clear/karaoke
curl -X DELETE http://127.0.0.1:8000/api/queue/clear/processing
```

Clearing Processing Queue requests cancellation for its active job and removes pending jobs. Karaoke entries remain visible with their resulting status. Processed-library media is never deleted by queue clearing.

## Angular usage

### Upload a track

```ts
addTrack(file: File, priority: 1 | 2) {
  const body = new FormData();
  body.append('file', file, file.name);
  body.append('priority', String(priority));

  return this.http.post<{ message: string; item: QueueItem }>(
    'http://127.0.0.1:8000/api/queue/add',
    body
  );
}
```

### Poll queue state

```ts
readonly queue$ = interval(1500).pipe(
  startWith(0),
  switchMap(() => this.http.get<QueueSnapshot>(
    'http://127.0.0.1:8000/api/queue'
  )),
  shareReplay({ bufferSize: 1, refCount: true })
);
```

Example JSON response:

```json
{
  "karaoke_queue": [
    {
      "task_id": "9b2f...",
      "raw_title": "My Song (Live)",
      "raw_artist": "Artist",
      "raw_album": "Album",
      "title": "My Song (Live)",
      "artist": "Artist",
      "album": "Album",
      "priority": 1,
      "position": 0,
      "status": "pending",
      "progress": 0,
      "step": "Queued"
    }
  ],
  "processing_queue": [
    {
      "task_id": "9b2f...",
      "priority": 1,
      "status": "pending",
      "progress": 0,
      "step": "Queued"
    }
  ],
  "current_task": null
}
```

### Reorder Karaoke Queue

```ts
reorderKaraokeTracks(karaokeQueue: string[]) {
  return this.http.patch<{ message: string }>(
    'http://127.0.0.1:8000/api/queue/reorder',
    {
      karaoke_queue: karaokeQueue
    }
  );
}
```

The array must contain every Karaoke Queue item exactly once. This does not reorder the Processing Queue.

### Pause, resume, and cancel

```ts
pauseTrack(taskId: string) {
  return this.http.post<{ message: string; item: QueueItem }>(
    `http://127.0.0.1:8000/api/queue/pause/${encodeURIComponent(taskId)}`,
    {}
  );
}

resumeTrack(taskId: string) {
  return this.http.post<{ message: string; item: QueueItem }>(
    `http://127.0.0.1:8000/api/queue/resume/${encodeURIComponent(taskId)}`,
    {}
  );
}

cancelTrack(taskId: string) {
  return this.http.delete<{ message: string; item: QueueItem }>(
    `http://127.0.0.1:8000/api/queue/${encodeURIComponent(taskId)}`
  );
}
```
