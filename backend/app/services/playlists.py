"""JSON-file backed playlists."""
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

import json

from app.services import library
from app.services.fsutil import atomic_write_json
from app.services.settings import BACKEND_DIR

PLAYLISTS_FILE = BACKEND_DIR / "playlists.json"
_lock = threading.RLock()
_cache: dict[str, Any] = {"sig": None, "data": None}


def _sig() -> Optional[tuple[int, int]]:
    try:
        stat = PLAYLISTS_FILE.stat()
        return (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return None


def _load() -> list[dict[str, Any]]:
    with _lock:
        sig = _sig()
        if _cache["data"] is not None and _cache["sig"] == sig:
            return _cache["data"]
        data: list[dict[str, Any]] = []
        if sig is not None:
            try:
                loaded = json.loads(PLAYLISTS_FILE.read_text(encoding="utf-8"))
                raw = loaded.get("playlists") if isinstance(loaded, dict) else None
                data = [p for p in (raw or []) if isinstance(p, dict) and "id" in p]
            except (OSError, ValueError):
                data = []
        _cache.update(sig=sig, data=data)
        return data


def _save(data: list[dict[str, Any]]) -> None:
    with _lock:
        atomic_write_json(PLAYLISTS_FILE, {"playlists": data})
        _cache.update(sig=_sig(), data=data)


def _find(data: list[dict[str, Any]], playlist_id: str) -> dict[str, Any]:
    for playlist in data:
        if playlist["id"] == playlist_id:
            return playlist
    raise KeyError(playlist_id)


def render(playlist: dict[str, Any], base_url: str) -> dict[str, Any]:
    songs = []
    covers: list[str] = []
    total = 0.0
    for entry in playlist.get("songs", []):
        record = library.lookup(entry["artist"], entry["album"], entry["title"])
        cover = base_url.rstrip("/") + record["cover_url"] if record and record["cover_url"] else None
        songs.append({**entry, "cover_url": cover})
        if cover and cover not in covers and len(covers) < 4:
            covers.append(cover)
        total += (record or {}).get("duration_seconds") or 0
    return {
        "id": playlist["id"],
        "name": playlist["name"],
        "songs": songs,
        "cover_urls": covers,
        "song_count": len(songs),
        "total_duration_seconds": round(total, 3),
    }


def list_playlists() -> list[dict[str, Any]]:
    with _lock:
        return [dict(p) for p in _load()]


def get_playlist(playlist_id: str) -> dict[str, Any]:
    with _lock:
        return dict(_find(_load(), playlist_id))


def create_playlist(name: str) -> dict[str, Any]:
    with _lock:
        data = list(_load())
        playlist = {"id": uuid.uuid4().hex[:12], "name": name, "songs": []}
        data.append(playlist)
        _save(data)
        return dict(playlist)


def mutate(playlist_id: str, change) -> dict[str, Any]:
    """Apply change(playlist) to a copy of the playlist and persist; returns the new playlist."""
    with _lock:
        data = list(_load())
        playlist = _find(data, playlist_id)
        updated = {**playlist, "songs": list(playlist.get("songs", []))}
        change(updated)
        data[data.index(playlist)] = updated
        _save(data)
        return dict(updated)


def delete_playlist(playlist_id: str) -> None:
    with _lock:
        data = list(_load())
        playlist = _find(data, playlist_id)
        data.remove(playlist)
        _save(data)


def rename_song(old: tuple[str, str, str], new: tuple[str, str, str]) -> None:
    with _lock:
        data = _load()
        changed = False
        rebuilt = []
        for playlist in data:
            songs = []
            for entry in playlist.get("songs", []):
                if (entry["artist"], entry["album"], entry["title"]) == old:
                    entry = {"artist": new[0], "album": new[1], "title": new[2]}
                    changed = True
                songs.append(entry)
            rebuilt.append({**playlist, "songs": songs})
        if changed:
            _save(rebuilt)
