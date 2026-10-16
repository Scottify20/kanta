# Separation API

**Navigation:** [Home](../README.md) | [API guide](README.md) | [Queue API](queue.md) | **Separation API** | [Songs and media](songs.md) | [Frontend playback](../frontend/playback.md)

These direct endpoints are useful for callers that do not need the queue UI. They still share the backend GPU lock, so only one separation job runs at a time.

## When to use this API

Use the queue API for the normal application workflow, priority ordering, pause/resume, and drag-and-drop control. Use these direct endpoints for scripts, one-off jobs, or integrations that want to wait for a single request.

The request remains open while the separation runs. For long-running tracks, the queue API is usually easier to monitor.

The normal frontend workflow uses the queue API with Processing Only/basic separation as the default. Use full separation only when explicitly requested.

## Basic separation

`POST /api/separate-basic`

Send either an uploaded file or a URL form field.

```bash
curl -X POST http://127.0.0.1:8000/api/separate-basic \
  -F "file=@song.mp3"
```

The basic pipeline creates instrumental and vocal stems, an original MP3 copy, extracted cover art when available, and lyrics when the lyrics provider returns them.

## Full karaoke separation

`POST /api/separate-full`

```bash
curl -X POST http://127.0.0.1:8000/api/separate-full \
  -F "file=@song.mp3"
```

The full pipeline additionally creates lead, backing, and multi-instrument stems according to the configured models.

Full separation generates the additional karaoke stems configured by the separator pipeline.

## URL input

Both endpoints accept a remote audio URL instead of a file:

```bash
curl -X POST http://127.0.0.1:8000/api/separate-basic \
  -F "url=https://example.com/song.mp3"
```

Optional `task_id` can be supplied to associate the request with an existing task record.

For uploads, the file is stored temporarily while the pipeline runs and is removed afterward. The input URL must be reachable by the backend process, not only by the browser.

## Progress and cancellation

Poll progress with:

```bash
curl http://127.0.0.1:8000/api/status/TASK_ID
```

Request cancellation with:

```bash
curl -X POST http://127.0.0.1:8000/api/cancel/TASK_ID
```

The separation result includes the generated task ID and the HTTP base URL for its output directory.

## JSON response example

```json
{
  "status": "success",
  "task_id": "9b2f...",
  "type": "basic",
  "folder_path": "/home/user/kanta/backend/separated/Artist/Album/Song",
  "http_base_url": "http://127.0.0.1:8000/media/Artist/Album/Song"
}
```

## Angular direct request

```ts
const body = new FormData();
body.append('file', file, file.name);

this.http.post<SeparationResult>(
  'http://127.0.0.1:8000/api/separate-basic',
  body
).subscribe(result => console.log(result));
```

For full karaoke separation, use the same code with `/api/separate-full`. The queue API is generally better for Angular because it returns immediately with a queued task.

## Health check

Before submitting a request, verify the backend is available:

```bash
curl http://127.0.0.1:8000/health
```

Expected response:

```json
{"status":"ok","app":"Kanta Backend"}
```
