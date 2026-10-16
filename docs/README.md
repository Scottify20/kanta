# Kanta Documentation

**Navigation:** **Home** | [API guide](api/README.md) | [Queue API](api/queue.md) | [Separation API](api/separation.md) | [Songs and media](api/songs.md) | [Frontend playback](frontend/playback.md)

Kanta is a desktop karaoke companion. The FastAPI backend extracts metadata, queues GPU-bound separation jobs, fetches and serves stored lyrics, and serves generated media. The Angular frontend provides the player, processed-song library, queue controls, synchronized stem playback, and settings.

## Start here

1. Start the backend on `http://127.0.0.1:8000`.
2. Open the interactive API reference at [`/docs`](http://127.0.0.1:8000/docs).
3. Open the Angular app at `http://localhost:4200/`.
4. Add an external track through the [Queue API](api/queue.md); Processing Only/basic separation is the default.
5. Poll the queue until the task is `completed`.
6. Use the [Songs and media API](api/songs.md) to retrieve stems, lyrics, and cover art.
7. Load the generated URLs in the [frontend player](frontend/playback.md).

## Documentation map

- [API guide](api/README.md): backend concepts, conventions, and endpoint map.
- [Queue API](api/queue.md): uploads, priorities, processed-library entries, persistence, drag-and-drop ordering, pause, resume, clearing, and cancellation.
- [Separation API](api/separation.md): direct basic and full separation requests.
- [Songs and media API](api/songs.md): manifests and static media URLs.
- [Frontend playback](frontend/playback.md): Angular queue polling and synchronized stem playback.
- Settings: the `/settings` screen configures the parent output directory for future processed songs.

## Base URLs

| Service | Default URL |
| --- | --- |
| FastAPI | `http://127.0.0.1:8000` |
| Generated media | `http://127.0.0.1:8000/media/...` |
| Angular development server | Usually `http://localhost:4200` |
