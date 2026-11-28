"""Cached library index: song records, queue asset lookups and the search index."""
import hashlib
import json
import logging
import queue as thread_queue
import re
import sqlite3
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from app.services.fsutil import atomic_write_json
from app.services.paths import DATA_DIR
from app.services.lyrics import (
    classify_lyrics_file,
    get_lyrics_offset_ms,
    max_offset_ms_for_duration,
    saved_lyrics_is_duet,
    saved_lyrics_level,
)
from app.services.storage import is_available
from app.services.settings import (
    find_song_directory,
    get_output_dirs,
    get_settings_version,
)
from app.services.tagging import AUDIO_SUFFIXES, EXTENDED_FIELDS, read_display_names, read_duration, read_tags

LIST_TTL_SECONDS = 300.0
ASSET_HIT_TTL = 120.0
ASSET_MISS_TTL = 15.0
SIDECAR_NAME = ".kanta.json"
MEDIA_PREFIX = "/media-roots/"
VOCAL_RANGE_FIELDS = {
    "vocal_min_hz": "min_hz",
    "vocal_max_hz": "max_hz",
    "vocal_min_note": "min_note",
    "vocal_max_note": "max_note",
    "vocal_tessitura_min_hz": "tessitura_min_hz",
    "vocal_tessitura_max_hz": "tessitura_max_hz",
    "vocal_tessitura_min_note": "tessitura_min_note",
    "vocal_tessitura_max_note": "tessitura_max_note",
    "vocal_voice_type": "voice_type",
}
ANALYSIS_FIELDS = ("musical_key_mode", "camelot_key")
logger = logging.getLogger("uvicorn")

_lock = threading.RLock()
_scan_lock = threading.Lock()
_refresh_in_flight = False
_song_cache: dict[Path, tuple[tuple, dict[str, Any]]] = {}
_loaded_roots: set[Path] = set()
_state: dict[str, Any] = {
    "records": None,
    "built_at": 0.0,
    "settings_version": -1,
    "by_key": {},
    "abs_cache": {},
    "search": None,
    "etag": "0",
}
_assets: dict[Any, tuple[float, tuple]] = {}


def _cache_path(root: Path) -> Path:
    """Store SQLite index on fast local DATA_DIR (never on /mnt/d 9p shares)."""
    root_hash = hashlib.sha1(str(root.resolve()).encode("utf-8")).hexdigest()[:12]
    return DATA_DIR / "cache" / f"library_{root_hash}.sqlite3"


def _load_root_cache(root: Path, root_index: Optional[int] = None) -> list[dict[str, Any]]:
    resolved_root = root.resolve()
    records: list[dict[str, Any]] = []
    if resolved_root in _loaded_roots:
        with _lock:
            for song_dir, (_sig, rec) in _song_cache.items():
                if song_dir.is_relative_to(resolved_root):
                    if root_index is None or rec.get("_root_index") == root_index:
                        records.append(rec)
            return records
    _loaded_roots.add(resolved_root)
    path = _cache_path(resolved_root)
    if not path.is_file():
        return records
    try:
        with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1.0) as db:
            rows = db.execute("SELECT path, signature, record FROM songs_v1").fetchall()
        for relative, signature_json, record_json in rows:
            song_dir = (resolved_root / relative).resolve()
            signature = json.loads(signature_json)
            record = json.loads(record_json)
            if (
                song_dir.is_relative_to(resolved_root)
                and isinstance(signature, list)
                and len(signature) == 8
                and all(isinstance(value, int) for value in signature)
                and isinstance(record, dict)
                and record.get("path") == str(song_dir)
                and all(key in record for key in (
                    "_root_index", "root_index", "artist", "album", "title",
                    "stems", "lyrics", "covers", "master", "cover_url", "is_duet",
                ))
                and all(field in record for field in EXTENDED_FIELDS)
                and all(field in record for field in VOCAL_RANGE_FIELDS)
                and all(field in record for field in ANALYSIS_FIELDS)
                and all(isinstance(record[key], list) for key in ("stems", "lyrics", "covers"))
            ):
                if root_index is not None and record.get("_root_index") != root_index:
                    # Root index changed in settings; let live scan rebuild URLs cleanly.
                    continue
                with _lock:
                    _song_cache.setdefault(song_dir, (tuple(signature), record))
                records.append(record)
    except (OSError, sqlite3.Error, ValueError, TypeError) as exc:
        logger.warning("Could not read library cache %s: %s", path, exc)
    return records


def _save_root_cache(root: Path, records: list[dict[str, Any]]) -> None:
    resolved_root = root.resolve()
    path = _cache_path(resolved_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path, timeout=2.0) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS songs_v1 "
                "(path TEXT PRIMARY KEY, signature TEXT NOT NULL, record TEXT NOT NULL)"
            )
            rows = []
            with _lock:
                for record in records:
                    song_dir = Path(record["path"])
                    cached = _song_cache.get(song_dir)
                    if cached and cached[1] is record:
                        rows.append((
                            str(song_dir.relative_to(resolved_root)),
                            json.dumps(cached[0]),
                            json.dumps(record),
                        ))
            db.execute("DELETE FROM songs_v1")
            db.executemany("INSERT INTO songs_v1 VALUES (?, ?, ?)", rows)
    except (OSError, sqlite3.Error, ValueError, TypeError) as exc:
        logger.warning("Could not write library cache %s: %s", path, exc)


def _mtime(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


def _files_in(directory: Path) -> list[Path]:
    try:
        if not directory.is_dir():
            return []
        return sorted((f for f in directory.iterdir() if f.is_file()), key=lambda f: f.name)
    except OSError:
        return []


def top_level_audio(song_dir: Path) -> list[Path]:
    return [f for f in _files_in(song_dir) if f.suffix.lower() in AUDIO_SUFFIXES]


def reference_audio(song_dir: Path) -> Optional[Path]:
    masters = top_level_audio(song_dir)
    if masters:
        return masters[0]
    stems = [f for f in _files_in(song_dir / "stems") if f.suffix.lower() in AUDIO_SUFFIXES]
    return stems[0] if stems else None


def _date_added(song_dir: Path, reference: Optional[Path]) -> float:
    sidecar = song_dir / SIDECAR_NAME
    sidecar_data: dict[str, Any] = {}
    sidecar_writable = True
    try:
        loaded = json.loads(sidecar.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("sidecar must contain a JSON object")
        sidecar_data = loaded
        value = sidecar_data.get("date_added")
        if isinstance(value, (int, float)):
            return float(value)
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as exc:
        logger.warning("Could not read song sidecar %s: %s", sidecar, exc)
        sidecar_writable = False
    try:
        value = round(min((reference or song_dir).stat().st_mtime, song_dir.stat().st_mtime), 3)
    except OSError:
        value = round(time.time(), 3)
    if sidecar_writable:
        sidecar_data["date_added"] = value
        try:
            atomic_write_json(sidecar, sidecar_data, indent=None)
        except OSError as exc:
            logger.warning("Could not update song sidecar %s: %s", sidecar, exc)
    return value


def _media_path(root_index: int, root: Path, path: Path) -> str:
    return f"{MEDIA_PREFIX}{root_index}/{quote(path.relative_to(root).as_posix(), safe='/')}"


def _signature(song_dir: Path, reference: Optional[Path]) -> tuple:
    return (
        _mtime(song_dir),
        _mtime(song_dir / "stems"),
        _mtime(song_dir / "lyrics"),
        _mtime(song_dir / "covers"),
        _mtime(song_dir / "lyrics" / "timing.json"),
        _mtime(song_dir / "covers" / "cover.jpg"),
        _mtime(reference) if reference else 0,
        _mtime(song_dir / SIDECAR_NAME),
    )


def _vocal_range_fields(song_dir: Path) -> dict[str, Any]:
    empty: dict[str, Any] = {field: None for field in VOCAL_RANGE_FIELDS}
    empty["duet_vocal_ranges"] = None
    try:
        sidecar_data = json.loads((song_dir / SIDECAR_NAME).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty
    except (OSError, ValueError) as exc:
        logger.warning("Could not read vocal range from song sidecar %s: %s", song_dir / SIDECAR_NAME, exc)
        return empty
    if not isinstance(sidecar_data, dict):
        return empty
    vocal_range = sidecar_data.get("vocal_range")
    result: dict[str, Any] = (
        {field: vocal_range.get(source) for field, source in VOCAL_RANGE_FIELDS.items()}
        if isinstance(vocal_range, dict)
        else {field: None for field in VOCAL_RANGE_FIELDS}
    )
    duet_ranges = sidecar_data.get("duet_vocal_ranges")
    result["duet_vocal_ranges"] = duet_ranges if isinstance(duet_ranges, dict) else None
    return result


def _song_analysis_fields(song_dir: Path, tags: dict[str, Any]) -> dict[str, Any]:
    try:
        sidecar_data = json.loads((song_dir / SIDECAR_NAME).read_text(encoding="utf-8"))
    except FileNotFoundError:
        sidecar_data = {}
    except (OSError, ValueError) as exc:
        logger.warning(
            "Could not read analysis metadata from song sidecar %s: %s",
            song_dir / SIDECAR_NAME,
            exc,
        )
        sidecar_data = {}
    if not isinstance(sidecar_data, dict):
        sidecar_data = {}
    analysis_fields = {
        "musical_key_mode": sidecar_data.get("musical_key_mode"),
        "camelot_key": sidecar_data.get("camelot_key"),
    }
    for field in ("musical_key", "bpm"):
        if field in tags or sidecar_data.get(field) is not None:
            analysis_fields[field] = (
                sidecar_data[field]
                if sidecar_data.get(field) is not None
                else tags.get(field)
            )
    return analysis_fields


def update_sidecar_analysis_fields(song_dir: Path, fields: dict[str, Any]) -> None:
    updates = {name: fields[name] for name in ("musical_key", "bpm") if name in fields}
    if not updates:
        return
    sidecar_path = song_dir / SIDECAR_NAME
    try:
        data = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as exc:
        raise ValueError(f"Could not read song sidecar {sidecar_path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Song sidecar must contain a JSON object: {sidecar_path}")
    data.update(updates)
    if "musical_key" in updates:
        key = updates["musical_key"]
        data["musical_key_mode"] = (
            "Minor" if isinstance(key, str) and key.casefold().endswith("m")
            else "Major" if key
            else None
        )
        data["camelot_key"] = None
    atomic_write_json(sidecar_path, data, indent=None)


def build_song_record(
    song_dir: Path, root: Path, root_index: int, artist: str, album: str, title: str
) -> dict[str, Any]:
    resolved_root = root.resolve()
    reference = reference_audio(song_dir)
    signature = _signature(song_dir, reference)
    with _lock:
        cached = _song_cache.get(song_dir)
        if (
            cached
            and cached[0] == signature
            and "is_duet" in cached[1]
            and all(field in cached[1] for field in EXTENDED_FIELDS)
            and all(field in cached[1] for field in VOCAL_RANGE_FIELDS)
            and all(field in cached[1] for field in ANALYSIS_FIELDS)
        ):
            record = cached[1]
            if (record["_root_index"], record["artist"], record["album"], record["title"]) == (
                root_index,
                artist,
                album,
                title,
            ):
                return record

    date_added = _date_added(song_dir, reference)
    signature = _signature(song_dir, reference)
    media = lambda path: _media_path(root_index, resolved_root, path)
    lyrics_dir = song_dir / "lyrics"
    covers = [{"name": f.name, "url": media(f)} for f in _files_in(song_dir / "covers")]
    cover_file = song_dir / "covers" / "cover.jpg"
    cover_url = None
    if cover_file.is_file():
        cover_url = f"{media(cover_file)}?v={_mtime(cover_file) // 1_000_000_000}"
    elif covers:
        cover_url = covers[0]["url"]

    tags = read_tags(reference) if reference else {field: None for field in EXTENDED_FIELDS}
    names = read_display_names(reference) if reference else {}
    duration = read_duration(reference) if reference else None
    duration_seconds = round(duration, 3) if duration else 0
    masters = top_level_audio(song_dir)
    record: dict[str, Any] = {
        "artist": artist,
        "album": album,
        "title": title,
        "display_title": names.get("title") or title,
        "display_artist": names.get("artist") or artist,
        "display_album": names.get("album") or album,
        "stems": [{"name": f.name, "url": media(f)} for f in _files_in(song_dir / "stems")],
        "lyrics": [
            {"name": f.name, "url": media(f), "level": classify_lyrics_file(f)}
            for f in _files_in(lyrics_dir)
            if f.suffix.lower() in {".ttml", ".lrc"}
        ],
        "lyrics_level": saved_lyrics_level(lyrics_dir),
        "is_duet": saved_lyrics_is_duet(lyrics_dir),
        "lyrics_offset_ms": get_lyrics_offset_ms(lyrics_dir),
        "covers": covers,
        "master": media(masters[0]) if masters else None,
        "cover_url": cover_url,
        "duration_seconds": duration_seconds,
        "date_added": date_added,
        "max_offset_ms": max_offset_ms_for_duration(duration_seconds),
        "path": str(song_dir),
        "root_index": root_index,
        "_root_index": root_index,
        **tags,
        **_song_analysis_fields(song_dir, tags),
        **_vocal_range_fields(song_dir),
    }
    with _lock:
        _song_cache[song_dir] = (signature, record)
    return record


def absolutize(record: dict[str, Any], base_url: str) -> dict[str, Any]:
    base = base_url.rstrip("/")
    out = {k: v for k, v in record.items() if not k.startswith("_")}
    for key in ("stems", "lyrics", "covers"):
        out[key] = [{**e, "url": base + e["url"]} for e in record[key]]
    out["master"] = base + record["master"] if record["master"] else None
    out["cover_url"] = base + record["cover_url"] if record["cover_url"] else None
    return out


def _safe_sorted_subdirs(directory: Path) -> list[Path]:
    try:
        entries = list(directory.iterdir())
    except OSError as exc:
        logger.warning("[Library] Could not read directory %s: %s", directory, exc)
        return []
    subdirs: list[Path] = []
    for entry in entries:
        try:
            if entry.is_dir():
                subdirs.append(entry)
        except OSError as exc:
            logger.warning("[Library] Skipping unreadable entry %s: %s", entry, exc)
    subdirs.sort(key=lambda p: p.name.lower())
    return subdirs


def _iter_scan(cancel: Optional[threading.Event] = None):
    """Yield song records one at a time; per-folder errors skip only that folder, never the root."""
    seen: set[tuple[str, str, str]] = set()
    live: set[Path] = set()
    completed_all_roots = True

    for root_index, root in enumerate(get_output_dirs()):
        if cancel and cancel.is_set():
            completed_all_roots = False
            break
        if not is_available(root):
            continue

        resolved_root = root.resolve()
        _load_root_cache(resolved_root, root_index)
        root_records: list[dict[str, Any]] = []
        skipped_count = 0

        for artist_dir in _safe_sorted_subdirs(resolved_root):
            if cancel and cancel.is_set():
                completed_all_roots = False
                break
            if (
                artist_dir.name == "temp"
                or artist_dir.name.startswith((".", "$"))
                or artist_dir.name == "System Volume Information"
            ):
                continue

            for album_dir in _safe_sorted_subdirs(artist_dir):
                if cancel and cancel.is_set():
                    completed_all_roots = False
                    break

                for song_dir in _safe_sorted_subdirs(album_dir):
                    if cancel and cancel.is_set():
                        completed_all_roots = False
                        break
                    key = (artist_dir.name, album_dir.name, song_dir.name)
                    if key in seen:
                        continue
                    seen.add(key)
                    try:
                        resolved = song_dir.resolve()
                        if not resolved.is_relative_to(resolved_root):
                            continue
                        record = build_song_record(resolved, resolved_root, root_index, *key)
                    except Exception as exc:
                        skipped_count += 1
                        logger.warning("[Library] Skipping song %s: %s", song_dir, exc)
                        continue
                    live.add(resolved)
                    root_records.append(record)
                    yield record

        if completed_all_roots:
            logger.info(
                "[Library] Indexed %d songs from %s (skipped %d)",
                len(root_records),
                resolved_root,
                skipped_count,
            )
            _save_root_cache(resolved_root, root_records)

    if completed_all_roots:
        with _lock:
            for stale in set(_song_cache) - live:
                _song_cache.pop(stale, None)


def _current_version() -> tuple:
    return (get_settings_version(), tuple(is_available(root) for root in get_output_dirs()))


def _compute_etag(records: list[dict[str, Any]]) -> str:
    h = hashlib.sha1()
    for r in records:
        h.update(
            f"{r['artist']}|{r['album']}|{r['title']}|{r.get('cover_url')}|{r.get('lyrics_level')}|{r.get('date_added')}\n".encode(
                "utf-8"
            )
        )
    return h.hexdigest()[:16]


def _store_records(records: list[dict[str, Any]], version: tuple, built_at: Optional[float] = None) -> None:
    etag = _compute_etag(records)
    with _lock:
        _state.update(
            records=records,
            built_at=time.monotonic() if built_at is None else built_at,
            settings_version=version,
            by_key={(r["artist"], r["album"], r["title"]): r for r in records},
            abs_cache={},
            search=None,
            etag=etag,
        )


def _hydrate_from_sqlite_if_empty() -> Optional[list[dict[str, Any]]]:
    """Load persisted SQLite records into memory in ~15ms so first request never stalls."""
    with _lock:
        if _state["records"] is not None:
            return _state["records"]
    version = _current_version()
    hydrated: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for root_index, root in enumerate(get_output_dirs()):
        if not is_available(root):
            continue
        for rec in _load_root_cache(root, root_index):
            key = (rec["artist"], rec["album"], rec["title"])
            if key not in seen:
                seen.add(key)
                hydrated.append(rec)
    if hydrated:
        _store_records(hydrated, version, built_at=0.0)
        return hydrated
    return None


def _schedule_background_refresh() -> None:
    global _refresh_in_flight
    with _lock:
        if _refresh_in_flight:
            return
        _refresh_in_flight = True

    def _run() -> None:
        global _refresh_in_flight
        try:
            with _scan_lock:
                version = _current_version()
                records = list(_iter_scan())
                _store_records(records, version)
        except Exception as exc:
            logger.warning("Background library refresh failed: %s", exc)
        finally:
            with _lock:
                _refresh_in_flight = False

    threading.Thread(target=_run, name="library-refresh", daemon=True).start()


def _ensure_records() -> list[dict[str, Any]]:
    version = _current_version()
    with _lock:
        records: Optional[list[dict[str, Any]]] = _state["records"]
        if records is not None:
            is_fresh = (
                _state["settings_version"] == version
                and (time.monotonic() - _state["built_at"]) < LIST_TTL_SECONDS
            )
            if not is_fresh:
                _schedule_background_refresh()
            return records

    hydrated = _hydrate_from_sqlite_if_empty()
    if hydrated is not None:
        _schedule_background_refresh()
        return hydrated

    with _scan_lock:
        with _lock:
            existing: Optional[list[dict[str, Any]]] = _state["records"]
            if existing is not None:
                return existing
        scanned = list(_iter_scan())
        _store_records(scanned, version)
        return scanned


def get_etag() -> str:
    _ensure_records()
    with _lock:
        return f'"{_state["etag"]}"'


def warm_up() -> None:
    def _boot() -> None:
        _hydrate_from_sqlite_if_empty()
        _schedule_background_refresh()

    threading.Thread(target=_boot, name="library-warmup", daemon=True).start()


def stream_songs(base_url: str, batch_size: int = 80, cancel: Optional[threading.Event] = None):
    """Yield lists of absolutized records without holding _scan_lock across yields."""
    base = base_url.rstrip("/")
    version = _current_version()

    with _lock:
        cached: Optional[list[dict[str, Any]]] = _state["records"]
        stale = (
            cached is None
            or _state["settings_version"] != version
            or (time.monotonic() - _state["built_at"]) >= LIST_TTL_SECONDS
        )

    if cached is None:
        cached = _hydrate_from_sqlite_if_empty()
        stale = True

    if cached is not None:
        if stale:
            _schedule_background_refresh()
        chunk = batch_size * 4
        for start in range(0, len(cached), chunk):
            if cancel and cancel.is_set():
                return
            yield [absolutize(r, base) for r in cached[start : start + chunk]]
        return

    # True cold scan: producer thread feeds a bounded queue with non-deadlocking cancellation.
    q: thread_queue.Queue[Optional[list[dict[str, Any]]]] = thread_queue.Queue(maxsize=4)
    stop_event = cancel or threading.Event()

    def _enqueue(item: Optional[list[dict[str, Any]]]) -> bool:
        while not stop_event.is_set():
            try:
                q.put(item, timeout=0.25)
                return True
            except thread_queue.Full:
                continue
        return False

    def _producer() -> None:
        records: list[dict[str, Any]] = []
        batch: list[dict[str, Any]] = []
        try:
            with _scan_lock:
                # Re-check in case warm_up finished while waiting for _scan_lock.
                with _lock:
                    ready: Optional[list[dict[str, Any]]] = _state["records"]
                if ready is not None:
                    chunk = batch_size * 4
                    for start in range(0, len(ready), chunk):
                        if not _enqueue([absolutize(r, base) for r in ready[start : start + chunk]]):
                            return
                    return

                for record in _iter_scan(stop_event):
                    records.append(record)
                    batch.append(absolutize(record, base))
                    if len(batch) >= batch_size:
                        if not _enqueue(batch):
                            return
                        batch = []
                if batch and not stop_event.is_set():
                    _enqueue(batch)
                if not stop_event.is_set():
                    _store_records(records, _current_version())
        finally:
            try:
                q.put_nowait(None)
            except thread_queue.Full:
                try:
                    q.get_nowait()
                    q.put_nowait(None)
                except thread_queue.Empty:
                    pass

    threading.Thread(target=_producer, name="library-cold-stream", daemon=True).start()
    while True:
        item = q.get()
        if item is None:
            return
        if stop_event.is_set():
            continue
        yield item


def _upsert_state_record(record: dict[str, Any]) -> None:
    """Update or insert a single song record in memory so GET /api/songs reflects edits immediately."""
    with _lock:
        records: Optional[list[dict[str, Any]]] = _state["records"]
        if records is None:
            return
        path_str = record["path"]
        updated = [r for r in records if r.get("path") != path_str]
        updated.append(record)
        _state["records"] = updated
        _state["by_key"] = {(r["artist"], r["album"], r["title"]): r for r in updated}
        _state["abs_cache"] = {}
        _state["search"] = None
        _state["etag"] = _compute_etag(updated)


def invalidate(song_dir: Optional[Path] = None) -> None:
    """Mark the library stale and immediately prune deleted folders from memory."""
    resolved = Path(song_dir).resolve() if song_dir is not None else None
    removed = resolved is not None and not resolved.exists()
    with _lock:
        if resolved is not None:
            _song_cache.pop(resolved, None)
            if removed and _state["records"] is not None:
                remaining = [r for r in _state["records"] if r.get("path") != str(resolved)]
                if len(remaining) != len(_state["records"]):
                    _state["records"] = remaining
                    _state["by_key"] = {(r["artist"], r["album"], r["title"]): r for r in remaining}
                    _state["etag"] = _compute_etag(remaining)
        _state["built_at"] = 0.0
        _state["abs_cache"] = {}
        _state["search"] = None
        _assets.clear()
    _schedule_background_refresh()


def refresh_now() -> list[dict[str, Any]]:
    """Synchronously rescan all output roots and refresh the SQLite cache."""
    with _scan_lock:
        version = _current_version()
        records = list(_iter_scan())
        _store_records(records, version)
        return records

def list_songs(base_url: str) -> list[dict[str, Any]]:
    base = base_url.rstrip("/")
    records = _ensure_records()
    with _lock:
        cached = _state["abs_cache"].get(base)
        if cached is None:
            cached = [absolutize(r, base) for r in records]
            _state["abs_cache"][base] = cached
        return cached


def get_song(artist: str, album: str, title: str, base_url: str) -> Optional[dict[str, Any]]:
    location = find_song_directory(artist, album, title)
    if location is None:
        return None
    song_dir, root, root_index = location
    record = build_song_record(song_dir, root, root_index, artist, album, title)
    _upsert_state_record(record)
    return absolutize(record, base_url)

def lookup(artist: str, album: str, title: str) -> Optional[dict[str, Any]]:
    _ensure_records()
    with _lock:
        return _state["by_key"].get((artist, album, title))


def queue_assets(
    artist: str, album: str, title: str, output_dir: Optional[str]
) -> tuple[str, int, Optional[str], bool]:
    key = (output_dir, artist, album, title)
    now = time.monotonic()
    with _lock:
        hit = _assets.get(key)
        if hit and hit[0] > now:
            return hit[1]

    with _lock:
        indexed = _state["by_key"].get((artist, album, title))
    if indexed is not None:
        value = (
            indexed.get("lyrics_level", "none"),
            indexed.get("lyrics_offset_ms", 0),
            indexed.get("cover_url"),
            bool(indexed.get("is_duet", False)),
        )
        with _lock:
            _assets[key] = (now + ASSET_HIT_TTL, value)
        return value

    roots = get_output_dirs()
    song_dir: Optional[Path] = None
    root_index: Optional[int] = None
    if output_dir:
        song_dir = Path(output_dir).resolve()
        root_index = next(
            (i for i, root in enumerate(roots) if song_dir.is_relative_to(root)), None
        )
    else:
        location = find_song_directory(artist, album, title)
        if location:
            song_dir, _, root_index = location

    value = ("none", 0, None, False)
    ttl = ASSET_MISS_TTL
    if song_dir is not None and root_index is not None and song_dir.is_dir():
        lyrics_dir = song_dir / "lyrics"
        cover = song_dir / "covers" / "cover.jpg"
        cover_url = None
        if cover.is_file():
            cover_url = f"{_media_path(root_index, roots[root_index], cover)}?v={_mtime(cover) // 1_000_000_000}"
        value = (
            saved_lyrics_level(lyrics_dir),
            get_lyrics_offset_ms(lyrics_dir),
            cover_url,
            saved_lyrics_is_duet(lyrics_dir),
        )
        ttl = ASSET_HIT_TTL
    with _lock:
        _assets[key] = (now + ttl, value)
    return value


def normalize_text(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", stripped.casefold()).strip()


def _score(query: str, fields: tuple[str, ...], weights: tuple[int, ...]) -> Optional[int]:
    best: Optional[int] = None
    for field, offset in zip(fields, weights):
        if not field:
            continue
        if field.startswith(query):
            score = offset
        elif (" " + query) in field:
            score = offset + 1
        elif query in field:
            score = offset + 2
        else:
            continue
        if best is None or score < best:
            best = score
    return best


def _build_search_index(records: list[dict[str, Any]]) -> dict[str, Any]:
    albums: dict[tuple[str, str], dict[str, Any]] = {}
    artists: dict[str, dict[str, Any]] = {}
    for r in records:
        album = albums.setdefault(
            (r["artist"], r["album"]),
            {"artist": r["artist"], "album": r["album"], "cover_url": None, "song_count": 0},
        )
        album["song_count"] += 1
        album["cover_url"] = album["cover_url"] or r["cover_url"]
        artist = artists.setdefault(
            r["artist"],
            {"artist": r["artist"], "cover_url": None, "song_count": 0, "_albums": set()},
        )
        artist["song_count"] += 1
        artist["_albums"].add(r["album"])
        artist["cover_url"] = artist["cover_url"] or r["cover_url"]
    for artist in artists.values():
        artist["album_count"] = len(artist.pop("_albums"))
    return {
        "songs": [
            ((normalize_text(r["title"]), normalize_text(r["artist"]), normalize_text(r["album"])), r)
            for r in records
        ],
        "albums": [
            ((normalize_text(a["album"]), normalize_text(a["artist"])), a) for a in albums.values()
        ],
        "artists": [((normalize_text(a["artist"]),), a) for a in artists.values()],
    }


def search_library(query: str, limit: int, base_url: str) -> dict[str, list]:
    records = _ensure_records()
    with _lock:
        index = _state["search"]
        if index is None:
            index = _state["search"] = _build_search_index(records)
    base = base_url.rstrip("/")
    q = normalize_text(query)
    if not q:
        return {"songs": [], "albums": [], "artists": []}

    def rank(entries: list, weights: tuple[int, ...]) -> list[dict[str, Any]]:
        hits = []
        for fields, entry in entries:
            score = _score(q, fields, weights)
            if score is not None:
                hits.append((score, fields[0], entry))
        hits.sort(key=lambda hit: (hit[0], hit[1]))
        return [hit[2] for hit in hits[:limit]]

    def with_cover(entry: dict[str, Any]) -> dict[str, Any]:
        return {**entry, "cover_url": base + entry["cover_url"] if entry["cover_url"] else None}

    return {
        "songs": [absolutize(r, base) for r in rank(index["songs"], (0, 4, 8))],
        "albums": [with_cover(a) for a in rank(index["albums"], (0, 4))],
        "artists": [with_cover(a) for a in rank(index["artists"], (0,))],
    }