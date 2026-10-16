# Kanta API

**Navigation:** [Home](../README.md) | **API guide** | [Queue API](queue.md) | [Separation API](separation.md) | [Songs and media](songs.md) | [Frontend playback](../frontend/playback.md)

The FastAPI backend defaults to:

```text
http://127.0.0.1:8000
```

Interactive documentation is available at:

- `GET /docs` for Swagger UI
- `GET /redoc` for ReDoc

## Endpoint overview

| Area | Endpoints | Purpose |
| --- | --- | --- |
| Health | `GET /health` | Confirm that the server is running. |
| Queue | `/api/queue/*` | Submit and control GPU separation jobs and processed-library entries. |
| Status | `GET /api/status/{task_id}` | Read a task record. |
| Direct separation | `POST /api/separate-basic`, `POST /api/separate-full` | Run separation without queue UI semantics. |
| Songs | `GET /api/songs`, `GET /api/songs/{artist}/{album}/{title}` | List processed songs or read one manifest. |
| Media | `/media/*`, `/media-roots/{root_index}/*` | Download generated files from the default or indexed output folder. |
| Lyrics | `GET /api/blyrics/getLyrics` | Serve saved TTML/LRC lyrics or proxy the external provider. |
| Settings | `GET/PUT /api/settings` | Read or update processed output folders, the default output folder, and model folder. |

## Common conventions

### Task IDs

Queue uploads generate UUID task IDs. Save the ID returned by `POST /api/queue/add`; use it for polling, cancellation, pause/resume, and reordering.

### Metadata and paths

The backend keeps raw tags such as `raw_artist` and `raw_title` for display and lyrics queries. It sanitizes artist, album, and title values before using them as directory names. Use the manifest URLs instead of constructing media paths manually whenever possible.

Processed output folders and the selected default, plus the model folder, are stored in `backend/settings.json`. New jobs write under the default output folder; the library reads songs across all configured output folders. Manifests return root-indexed media URLs when files are outside the default folder.

### Settings payload

`GET /api/settings` returns `output_dirs`, `default_output_dir`, and `model_dir`. `PUT /api/settings` accepts the same fields. The legacy `output_dir` field remains available as an alias for `default_output_dir`.

```json
{
	"output_dirs": ["/home/user/Music/Kanta", "/mnt/archive/Kanta"],
	"default_output_dir": "/home/user/Music/Kanta",
	"model_dir": "/home/user/kanta/backend/models"
}
```

### GPU serialization

Only one separation pipeline runs at a time. Karaoke jobs have priority `1`; Processing Only jobs have priority `2`. Direct separation endpoints share the same GPU lock with queued jobs.

### Errors

Typical responses are:

| Status | Meaning |
| --- | --- |
| `400` | Invalid upload, priority, reorder payload, or URL input. |
| `404` | Unknown task or missing song directory. |
| `409` | Operation is invalid for the task's current state. |
| `499` | A direct separation request was cancelled. |
| `500` | Separation or file processing failed. |

## Sections

- [Queue API](queue.md): add, monitor, reorder, pause, resume, and cancel jobs.
- [Separation API](separation.md): use the direct basic or full separation endpoints.
- [Songs and media API](songs.md): retrieve generated files and manifests.
- [Frontend playback](../frontend/playback.md): play vocal and instrumental stems independently.

## Important behavior

- Only one separation pipeline runs at a time because separation uses the GPU.
- Queue priority `1` is Karaoke and priority `2` is Processing Only.
- New uploads default to priority `2` and therefore use basic separation.
- Queue positions are separate from priority and can be changed by reordering.
- Uploaded metadata is extracted before a queued job starts.
- Processed library songs can be added as completed Karaoke Queue entries without running separation again.
