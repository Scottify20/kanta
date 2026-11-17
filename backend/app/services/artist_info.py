"""Artist biography and photo lookup (TheAudioDB, Wikipedia, Deezer) with an on-disk cache."""

import io
import hashlib
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlsplit

import httpx
from PIL import Image

from app.services.fsutil import atomic_write_json
from app.services.metadata import sanitize_filename
from app.services.paths import DATA_DIR
from app.services.settings import get_output_dirs

logger = logging.getLogger("uvicorn")

CACHE_FILE = DATA_DIR / "artist_info.json"
PHOTO_DIR = DATA_DIR / "artist_photos"
FOUND_TTL_SECONDS = 30 * 24 * 3600
MISSING_TTL_SECONDS = 24 * 3600
TIMEOUT = 8.0
HEADERS = {"User-Agent": "Kanta/1.0 (https://github.com/Scottify20/kanta)"}
MUSIC_WORDS = re.compile(
    r"singer|band|musician|rapper|group|duo|trio|composer|songwriter|vocalist|dj\b|producer|pianist|guitarist|orchestra|boy band|girl group",
    re.IGNORECASE,
)

_lock = threading.Lock()
_photo_locks = tuple(threading.Lock() for _ in range(32))
PHOTO_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".gif")
PHOTO_FORMATS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}
MAX_PHOTO_BYTES = 10 * 1024 * 1024
PHOTO_HOSTS = ("theaudiodb.com", "wikimedia.org", "dzcdn.net", "deezer.com")


def _artist_dirs(folder: str) -> list[tuple[int, Path, Path]]:
    if not folder or folder in {".", ".."} or "/" in folder or "\\" in folder or "\x00" in folder:
        raise ValueError("Invalid artist folder")
    result = []
    for index, root in enumerate(get_output_dirs()):
        root = root.resolve()
        directory = root / folder
        if directory.is_dir() and not directory.is_symlink() and directory.resolve().parent == root:
            result.append((index, root, directory))
    return result


def _existing_photo(directory: Path) -> Optional[Path]:
    for suffix in PHOTO_SUFFIXES:
        photo = directory / f"artist{suffix}"
        if photo.is_file() and not photo.is_symlink():
            return photo
    return None


def _photo_id(name: str) -> str:
    return hashlib.sha256(_key(name).encode("utf-8")).hexdigest()


def artist_photo_path(photo_id: str) -> Optional[Path]:
    if not re.fullmatch(r"[a-f0-9]{64}", photo_id):
        return None
    for suffix in PHOTO_SUFFIXES:
        photo = PHOTO_DIR / f"{photo_id}{suffix}"
        if photo.is_file() and not photo.is_symlink():
            return photo
    return None


def _download_photo(url: str) -> tuple[bytes, str]:
    for _ in range(6):
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        if (parsed.scheme != "https" or parsed.port not in (None, 443) or parsed.username or parsed.password
                or not any(host == allowed or host.endswith("." + allowed) for allowed in PHOTO_HOSTS)):
            raise ValueError("Artist photo URL is not from a supported provider")
        with httpx.stream("GET", url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=False) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise ValueError("Artist photo redirect has no location")
                url = urljoin(url, location)
                continue
            response.raise_for_status()
            payload = bytearray()
            for chunk in response.iter_bytes(chunk_size=64 * 1024):
                payload.extend(chunk)
                if len(payload) > MAX_PHOTO_BYTES:
                    raise ValueError("Artist photo exceeds size limit")
        data = bytes(payload)
        with Image.open(io.BytesIO(data)) as image:
            suffix = PHOTO_FORMATS.get(image.format or "")
            if not suffix:
                raise ValueError("Unsupported artist photo format")
            image.verify()
        return data, suffix
    raise ValueError("Too many artist photo redirects")


def _local_photo(name: str, folder: Optional[str], remote_url: Optional[str], base_url: str) -> Optional[str]:
    photo_id = _photo_id(name)
    with _photo_locks[int(photo_id[:8], 16) % len(_photo_locks)]:
        cached = artist_photo_path(photo_id)
        if cached is None:
            data: Optional[bytes] = None
            suffix = ""
            try:
                # Import a folder photo only if the folder belongs to this artist.
                if folder and _key(sanitize_filename(name)) == _key(folder):
                    source = next(
                        (photo for _, _, directory in _artist_dirs(folder) if (photo := _existing_photo(directory))),
                        None,
                    )
                    if source:
                        data, suffix = source.read_bytes(), source.suffix.lower()
                if data is None and remote_url:
                    data, suffix = _download_photo(remote_url)
                if data:
                    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
                    target = PHOTO_DIR / f"{photo_id}{suffix}"
                    try:
                        with target.open("xb") as file:
                            file.write(data)
                    except FileExistsError:
                        pass
                    except OSError as exc:
                        logger.warning("[Artist] Could not save photo for '%s': %s", name, exc)
                    cached = artist_photo_path(photo_id)
            except (OSError, ValueError, httpx.HTTPError, Image.DecompressionBombError) as exc:
                logger.warning("[Artist] Could not cache photo for '%s': %s", name, exc)
        return f"{base_url.rstrip('/')}/api/artists/photo/{photo_id}" if cached else None


def _key(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().casefold()


def _load() -> dict[str, Any]:
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _audiodb(name: str) -> dict[str, Optional[str]]:
    response = httpx.get(
        "https://www.theaudiodb.com/api/v1/json/123/search.php",
        params={"s": name},
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    for artist in (response.json().get("artists") or []) if response.status_code == 200 else []:
        if _key(artist.get("strArtist") or "") == _key(name):
            return {
                "bio": (artist.get("strBiographyEN") or "").strip() or None,
                "photo": artist.get("strArtistThumb") or artist.get("strArtistFanart") or None,
                "url": artist.get("strWebsite") or None,
            }
    return {}


def _wikipedia(name: str) -> dict[str, Optional[str]]:
    search = httpx.get(
        "https://en.wikipedia.org/w/api.php",
        params={
            "action": "query",
            "list": "search",
            "srsearch": f"{name} musician band singer",
            "srlimit": 5,
            "format": "json",
        },
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    if search.status_code != 200:
        return {}
    wanted = _key(name)
    for hit in search.json().get("query", {}).get("search", []):
        title = hit["title"]
        # "Queen (band)" matches "Queen"; unrelated pages that merely mention the name do not.
        if _key(re.sub(r"\s*\(.*?\)$", "", title)) != wanted:
            continue
        page = httpx.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}",
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        if page.status_code != 200:
            continue
        data = page.json()
        if not MUSIC_WORDS.search(f"{data.get('description', '')} {data.get('extract', '')[:300]}"):
            continue
        return {
            "bio": (data.get("extract") or "").strip() or None,
            "photo": (data.get("thumbnail") or {}).get("source"),
            "url": (data.get("content_urls") or {}).get("desktop", {}).get("page"),
        }
    return {}


def _deezer(name: str) -> dict[str, Optional[str]]:
    response = httpx.get(
        "https://api.deezer.com/search/artist",
        params={"q": name, "limit": 5},
        headers=HEADERS,
        timeout=TIMEOUT,
    )
    for artist in response.json().get("data", []) if response.status_code == 200 else []:
        if _key(artist.get("name") or "") == _key(name):
            return {"photo": artist.get("picture_xl") or artist.get("picture_big"), "url": artist.get("link")}
    return {}


def _lookup(name: str) -> dict[str, Any]:
    merged: dict[str, Any] = {"name": name, "bio": None, "photo_url": None, "source_url": None, "sources": []}
    for label, provider in (("TheAudioDB", _audiodb), ("Wikipedia", _wikipedia), ("Deezer", _deezer)):
        try:
            found = provider(name)
        except Exception as exc:  # one unreachable provider must not hide the others
            logger.warning("[Artist] %s lookup failed for '%s': %s", label, name, exc)
            continue
        if not found:
            continue
        if found.get("bio") and not merged["bio"]:
            merged["bio"] = found["bio"]
            merged["source_url"] = found.get("url")
            merged["sources"].append(label)
        if found.get("photo") and not merged["photo_url"]:
            merged["photo_url"] = found["photo"]
            if label not in merged["sources"]:
                merged["sources"].append(label)
        if merged["bio"] and merged["photo_url"]:
            break
    return merged


def get_artist_info(name: str, folder: Optional[str] = None, base_url: str = "") -> dict[str, Any]:
    key = _key(name)
    now = time.time()
    with _lock:
        cache = _load()
    entry = cache.get(key)
    if entry:
        ttl = FOUND_TTL_SECONDS if (entry["data"]["bio"] or entry["data"]["photo_url"]) else MISSING_TTL_SECONDS
        if now - entry["ts"] < ttl:
            data = entry["data"]
        else:
            data = None
    else:
        data = None
    if data is None:
        data = _lookup(name)
        with _lock:
            cache = _load()
            cache[key] = {"ts": now, "data": data}
            try:
                atomic_write_json(CACHE_FILE, cache, indent=None)
            except OSError as exc:
                logger.warning("[Artist] Could not write cache: %s", exc)
    local_url = _local_photo(name, folder, data.get("photo_url"), base_url)
    if local_url:
        return {**data, "photo_url": local_url}
    return data
