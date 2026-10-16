"""Cached library index: song records, queue asset lookups and the search index."""
import json
import re
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from app.services.fsutil import atomic_write_json
from app.services.lyrics import (
    classify_lyrics_file,
    get_lyrics_offset_ms,
    max_offset_ms_for_duration,
    saved_lyrics_level,
)
from app.services.settings import (
    find_song_directory,
    get_output_dirs,
    get_settings_version,
)
from app.services.tagging import AUDIO_SUFFIXES, EXTENDED_FIELDS, read_duration, read_tags

LIST_TTL_SECONDS = 60.0
ASSET_HIT_TTL = 30.0
ASSET_MISS_TTL = 3.0
SIDECAR_NAME = ".kanta.json"
MEDIA_PREFIX = "/media-roots/"

_lock = threading.RLock()
_song_cache: dict[Path, tuple[tuple, dict[str, Any]]] = {}
_state: dict[str, Any] = {
    "records": None,  # list[dict] with relative urls
    "built_at": 0.0,
    "settings_version": -1,
    "by_key": {},
    "abs_cache": {},
    "search": None,
}
_assets: dict[Any, tuple[float, tuple]] = {}


def _mtime(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


def _files_in(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted((f for f in directory.iterdir() if f.is_file()), key=lambda f: f.name)


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
    try:
        value = json.loads(sidecar.read_text(encoding="utf-8")).get("date_added")
        if isinstance(value, (int, float)):
            return float(value)
    except (OSError, ValueError, AttributeError):
        pass
    try:
        value = round(min((reference or song_dir).stat().st_mtime, song_dir.stat().st_mtime), 3)
    except OSError:
        value = round(time.time(), 3)
    try:
        atomic_write_json(sidecar, {"date_added": value}, indent=None)
    except OSError:
        pass
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
    )


def build_song_record(
    song_dir: Path, root: Path, root_index: int, artist: str, album: str, title: str
) -> dict[str, Any]:
    reference = reference_audio(song_dir)
    signature = _signature(song_dir, reference)
    with _lock:
        cached = _song_cache.get(song_dir)
        if cached and cached[0] == signature:
            record = cached[1]
            if (record["_root_index"], record["artist"], record["album"], record["title"]) == (
                root_index,
                artist,
                album,
                title,
            ):
                return record

    media = lambda path: _media_path(root_index, root, path)
    lyrics_dir = song_dir / "lyrics"
    covers = [{"name": f.name, "url": media(f)} for f in _files_in(song_dir / "covers")]
    cover_file = song_dir / "covers" / "cover.jpg"
    cover_url = None
    if cover_file.is_file():
        cover_url = f"{media(cover_file)}?v={_mtime(cover_file) // 1_000_000_000}"
    elif covers:
        cover_url = covers[0]["url"]

    tags = read_tags(reference) if reference else {field: None for field in EXTENDED_FIELDS}
    duration = read_duration(reference) if reference else None
    duration_seconds = round(duration, 3) if duration else 0
    masters = top_level_audio(song_dir)
    record: dict[str, Any] = {
        "artist": artist,
        "album": album,
        "title": title,
        "stems": [{"name": f.name, "url": media(f)} for f in _files_in(song_dir / "stems")],
        "lyrics": [
            {"name": f.name, "url": media(f), "level": classify_lyrics_file(f)}
            for f in _files_in(lyrics_dir)
            if f.suffix.lower() in {".ttml", ".lrc"}
        ],
        "lyrics_level": saved_lyrics_level(lyrics_dir),
        "lyrics_offset_ms": get_lyrics_offset_ms(lyrics_dir),
        "covers": covers,
        "master": media(masters[0]) if masters else None,
        "cover_url": cover_url,
        "duration_seconds": duration_seconds,
        "date_added": _date_added(song_dir, reference),
        "max_offset_ms": max_offset_ms_for_duration(duration_seconds),
        "path": str(song_dir),
        "root_index": root_index,
        "_root_index": root_index,
        **tags,
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


def _scan() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    live: set[Path] = set()
    for root_index, root in enumerate(get_output_dirs()):
        if not root.is_dir():
            continue
        for artist_dir in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if not artist_dir.is_dir() or artist_dir.name == "temp":
                continue
            for album_dir in sorted(artist_dir.iterdir(), key=lambda p: p.name.lower()):
                if not album_dir.is_dir():
                    continue
                for song_dir in sorted(album_dir.iterdir(), key=lambda p: p.name.lower()):
                    if not song_dir.is_dir():
                        continue
                    key = (artist_dir.name, album_dir.name, song_dir.name)
                    if key in seen:
                        continue
                    seen.add(key)
                    resolved = song_dir.resolve()
                    live.add(resolved)
                    records.append(build_song_record(resolved, root, root_index, *key))
    with _lock:
        for stale in set(_song_cache) - live:
            _song_cache.pop(stale, None)
    return records


def _ensure_records() -> list[dict[str, Any]]:
    version = get_settings_version()
    with _lock:
        fresh = (
            _state["records"] is not None
            and _state["settings_version"] == version
            and time.monotonic() - _state["built_at"] < LIST_TTL_SECONDS
        )
        if fresh:
            return _state["records"]
    records = _scan()
    with _lock:
        _state.update(
            records=records,
            built_at=time.monotonic(),
            settings_version=version,
            by_key={(r["artist"], r["album"], r["title"]): r for r in records},
            abs_cache={},
            search=None,
        )
        return records


def invalidate(song_dir: Optional[Path] = None) -> None:
    """Mark the library stale. Pass a song_dir to drop its cached record too."""
    with _lock:
        if song_dir is not None:
            _song_cache.pop(Path(song_dir).resolve(), None)
        _state["records"] = None
        _state["abs_cache"] = {}
        _state["search"] = None
        _assets.clear()


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
    """Fresh single-song record (per-song cache validated by signature)."""
    location = find_song_directory(artist, album, title)
    if location is None:
        return None
    song_dir, root, root_index = location
    return absolutize(build_song_record(song_dir, root, root_index, artist, album, title), base_url)


def lookup(artist: str, album: str, title: str) -> Optional[dict[str, Any]]:
    """Relative-url record from the cached index."""
    _ensure_records()
    with _lock:
        return _state["by_key"].get((artist, album, title))


def queue_assets(
    artist: str, album: str, title: str, output_dir: Optional[str]
) -> tuple[str, int, Optional[str]]:
    """(lyrics_level, lyrics_offset_ms, cover_path_url); cached to avoid per-poll disk walks."""
    key = (output_dir, artist, album, title)
    now = time.monotonic()
    with _lock:
        hit = _assets.get(key)
        if hit and hit[0] > now:
            return hit[1]

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

    value: tuple[str, int, Optional[str]] = ("none", 0, None)
    ttl = ASSET_MISS_TTL
    if song_dir is not None and root_index is not None and song_dir.is_dir():
        lyrics_dir = song_dir / "lyrics"
        cover = song_dir / "covers" / "cover.jpg"
        cover_url = None
        if cover.is_file():
            cover_url = f"{_media_path(root_index, roots[root_index], cover)}?v={_mtime(cover) // 1_000_000_000}"
        value = (saved_lyrics_level(lyrics_dir), get_lyrics_offset_ms(lyrics_dir), cover_url)
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
