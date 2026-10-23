"""Remote lyrics sources. Each provider returns {"ttml": str|None, "lrc": str|None} or None."""

import logging
import re
from dataclasses import dataclass
from typing import Callable, Optional

import httpx

logger = logging.getLogger("uvicorn")

LyricsPayload = dict[str, Optional[str]]
TIMEOUT = 10.0
DURATION_TOLERANCE_SECONDS = 6
HAS_TIMESTAMPS = re.compile(r"(?m)^\s*\[\d{1,3}:\d{2}(?:[.:]\d+)?\]")


def _norm(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value or "", flags=re.UNICODE).casefold().strip()


def _timed(lrc: Optional[str]) -> Optional[str]:
    return lrc if lrc and HAS_TIMESTAMPS.search(lrc) else None


def _blyrics(artist: str, album: str, title: str, duration: int) -> Optional[LyricsPayload]:
    base = {"s": title, "a": artist, "d": duration}
    for params in ({**base, "al": album} if album else base, base):
        response = httpx.get("https://lyrics-api.boidu.dev/getLyrics", params=params, timeout=TIMEOUT)
        if response.status_code != 200:
            continue
        data = response.json()
        if data.get("ttml") or _timed(data.get("lrc")):
            return {"ttml": data.get("ttml"), "lrc": data.get("lrc")}
    return None


def _lrclib(artist: str, album: str, title: str, duration: int) -> Optional[LyricsPayload]:
    headers = {"User-Agent": "Kanta (https://github.com/Scottify20/kanta)"}
    response = httpx.get(
        "https://lrclib.net/api/get",
        params={"artist_name": artist, "track_name": title, "album_name": album, "duration": duration},
        headers=headers,
        timeout=TIMEOUT,
    )
    if response.status_code == 200 and _timed(response.json().get("syncedLyrics")):
        return {"ttml": None, "lrc": response.json()["syncedLyrics"]}

    response = httpx.get(
        "https://lrclib.net/api/search",
        params={"track_name": title, "artist_name": artist},
        headers=headers,
        timeout=TIMEOUT,
    )
    if response.status_code != 200:
        return None
    for entry in response.json():
        close = abs(float(entry.get("duration") or 0) - duration) <= DURATION_TOLERANCE_SECONDS
        if close and _timed(entry.get("syncedLyrics")):
            return {"ttml": None, "lrc": entry["syncedLyrics"]}
    return None


def _netease(artist: str, album: str, title: str, duration: int) -> Optional[LyricsPayload]:
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com"}
    search = httpx.post(
        "https://music.163.com/api/search/get",
        data={"s": f"{artist} {title}", "type": 1, "limit": 8, "offset": 0},
        headers=headers,
        timeout=TIMEOUT,
    )
    if search.status_code != 200:
        return None
    songs = (search.json().get("result") or {}).get("songs") or []
    wanted_artist = _norm(artist)
    for song in songs:
        names = " ".join(_norm(a.get("name", "")) for a in song.get("artists", []))
        seconds = float(song.get("duration") or 0) / 1000
        if abs(seconds - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        if wanted_artist and wanted_artist not in names and names not in wanted_artist:
            continue
        lyric = httpx.get(
            "https://music.163.com/api/song/lyric",
            params={"id": song["id"], "lv": 1, "kv": 1, "tv": -1},
            headers=headers,
            timeout=TIMEOUT,
        )
        if lyric.status_code != 200:
            continue
        lrc = _timed((lyric.json().get("lrc") or {}).get("lyric"))
        if lrc:
            return {"ttml": None, "lrc": lrc}
    return None


@dataclass(frozen=True)
class LyricsProvider:
    id: str
    label: str
    description: str
    word_level: bool
    fetch: Callable[[str, str, str, int], Optional[LyricsPayload]]


# Order is the lookup priority: word-level sources first, then line-synced fallbacks.
PROVIDERS: tuple[LyricsProvider, ...] = (
    LyricsProvider("blyrics", "Better Lyrics", "Word-synced TTML lyrics (Apple Music based)", True, _blyrics),
    LyricsProvider("lrclib", "LRCLIB", "Community line-synced lyrics", False, _lrclib),
    LyricsProvider("netease", "NetEase Cloud Music", "Line-synced lyrics, large catalogue", False, _netease),
)
PROVIDER_IDS = tuple(provider.id for provider in PROVIDERS)


def run_provider(
    provider: LyricsProvider, artist: str, album: str, title: str, duration: int
) -> Optional[LyricsPayload]:
    try:
        return provider.fetch(artist, album, title, duration)
    except Exception as exc:  # network or parsing failures must not abort the pipeline
        logger.warning("[Lyrics] %s failed for '%s': %s", provider.label, title, exc)
        return None
