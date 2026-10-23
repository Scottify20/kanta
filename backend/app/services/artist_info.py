"""Artist biography and photo lookup (TheAudioDB, Wikipedia, Deezer) with an on-disk cache."""

import json
import logging
import re
import threading
import time
from typing import Any, Optional

import httpx

from app.services.fsutil import atomic_write_json
from app.services.paths import DATA_DIR

logger = logging.getLogger("uvicorn")

CACHE_FILE = DATA_DIR / "artist_info.json"
FOUND_TTL_SECONDS = 30 * 24 * 3600
MISSING_TTL_SECONDS = 24 * 3600
TIMEOUT = 8.0
HEADERS = {"User-Agent": "Kanta/1.0 (https://github.com/Scottify20/kanta)"}
MUSIC_WORDS = re.compile(
    r"singer|band|musician|rapper|group|duo|trio|composer|songwriter|vocalist|dj\b|producer|pianist|guitarist|orchestra|boy band|girl group",
    re.IGNORECASE,
)

_lock = threading.Lock()


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


def get_artist_info(name: str) -> dict[str, Any]:
    key = _key(name)
    now = time.time()
    with _lock:
        cache = _load()
    entry = cache.get(key)
    if entry:
        ttl = FOUND_TTL_SECONDS if (entry["data"]["bio"] or entry["data"]["photo_url"]) else MISSING_TTL_SECONDS
        if now - entry["ts"] < ttl:
            return entry["data"]
    data = _lookup(name)
    with _lock:
        cache = _load()
        cache[key] = {"ts": now, "data": data}
        try:
            atomic_write_json(CACHE_FILE, cache, indent=None)
        except OSError as exc:
            logger.warning("[Artist] Could not write cache: %s", exc)
    return data
