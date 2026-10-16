# Kanta

Kanta is a desktop karaoke companion with a FastAPI backend and an Angular/Tauri
frontend. It queues audio separation jobs, serves generated stems and lyrics,
and provides synchronized playback and a processed-song library.

## Project layout

- [`backend/`](./backend/) — FastAPI service
- [`frontend/`](./frontend/) — Angular and Tauri application
- [`docs/`](./docs/README.md) — API and application documentation

## Development

Start the backend on `http://127.0.0.1:8000`, then run the frontend development
server from `frontend/` with `npm install` and `npm start`. The API reference is
available at `http://127.0.0.1:8000/docs`.

See the [documentation](./docs/README.md) for API details and workflows.
