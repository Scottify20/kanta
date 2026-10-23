"""Remote lyrics sources. Each provider returns {"ttml": str|None, "lrc": str|None} or None."""

import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Callable, Optional

import httpx

logger = logging.getLogger("uvicorn")

LyricsPayload = dict[str, Optional[str]]
Keys = dict[str, str]
USER_AGENT = "Kanta (https://github.com/Scottify20/kanta)"
TIMEOUT = 10.0
DURATION_TOLERANCE_SECONDS = 6
HAS_TIMESTAMPS = re.compile(r"(?m)^\s*\[\d{1,3}:\d{2}(?:[.:]\d+)?\]")


def _norm(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value or "", flags=re.UNICODE).casefold().strip()


def _timed(lrc: Optional[str]) -> Optional[str]:
    return lrc if lrc and HAS_TIMESTAMPS.search(lrc) else None


def _blyrics(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    base = {"s": title, "a": artist, "d": duration}
    for params in ({**base, "al": album} if album else base, base):
        response = httpx.get("https://lyrics-api.boidu.dev/getLyrics", params=params, timeout=TIMEOUT)
        if response.status_code != 200:
            continue
        data = response.json()
        if data.get("ttml") or _timed(data.get("lrc")):
            return {"ttml": data.get("ttml"), "lrc": data.get("lrc")}
    return None


def _lrclib(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers = {"User-Agent": USER_AGENT}
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


def _netease(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
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


def _ttml_time(milliseconds: float) -> str:
    return f"{max(0.0, milliseconds) / 1000:.3f}s"


def _word_ttml(lines: list[dict]) -> str:
    """Build word-timed TTML from [{"begin", "end", "words": [(begin, end, text)]}] in milliseconds."""
    root = ET.Element("tt", {"xmlns": "http://www.w3.org/ns/ttml"})
    div = ET.SubElement(ET.SubElement(root, "body"), "div")
    for line in lines:
        paragraph = ET.SubElement(
            div, "p", {"begin": _ttml_time(line["begin"]), "end": _ttml_time(line["end"])}
        )
        previous: Optional[ET.Element] = None
        for begin, end, text in line["words"]:
            if text[:1].isspace() and previous is not None:
                previous.tail = (previous.tail or "") + " "
            span = ET.SubElement(paragraph, "span", {"begin": _ttml_time(begin), "end": _ttml_time(end)})
            span.text = text.strip()
            if text[-1:].isspace():
                span.tail = " "
            previous = span
    return '<?xml version="1.0" encoding="UTF-8"?>' + ET.tostring(root, encoding="unicode")


def _lrc_from_lines(lines: list[tuple[float, str]]) -> Optional[str]:
    rows = []
    for begin, text in lines:
        text = text.strip()
        if not text:
            continue
        seconds = begin / 1000
        rows.append(f"[{int(seconds // 60):02d}:{seconds % 60:05.2f}]{text}")
    return "\n".join(rows) if rows else None


def _lyricsplus(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    base = {"title": title, "artist": artist, "duration": duration}
    # Album-qualified lookups sometimes resolve to unsynced text, so fall back to the plain query.
    for params in ({**base, "album": album} if album else base, base):
        response = httpx.get(
            "https://lyricsplus.binimum.org/v2/lyrics/get",
            params=params,
            headers={"User-Agent": USER_AGENT},
            timeout=TIMEOUT,
        )
        if response.status_code != 200:
            continue
        data = response.json()
        lines = data.get("lyrics") or []
        if data.get("type") == "Word" and any(line.get("syllabus") for line in lines):
            built = []
            for line in lines:
                words = [
                    (w["time"], w["time"] + w.get("duration", 0), w["text"])
                    for w in line.get("syllabus") or []
                    if w.get("text", "").strip()
                ]
                if words:
                    built.append(
                        {"begin": line["time"], "end": line["time"] + line.get("duration", 0), "words": words}
                    )
            if built:
                return {"ttml": _word_ttml(built), "lrc": None}
        times = [line.get("time") or 0 for line in lines]
        if len(set(times)) > 1:
            lrc = _lrc_from_lines([(line["time"], line.get("text", "")) for line in lines if "time" in line])
            if _timed(lrc):
                return {"ttml": None, "lrc": lrc}
    return None


def _lrcred(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers = {"User-Agent": USER_AGENT}
    search = httpx.get(
        "https://lrc.red/search.json", params={"q": f"{title} {artist}"}, headers=headers, timeout=TIMEOUT
    )
    if search.status_code != 200:
        return None
    wanted_artist = _norm(artist)
    for hit in search.json().get("hits", [])[:8]:
        if abs(float(hit.get("duration") or 0) - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        names = _norm(hit.get("artist", ""))
        if wanted_artist and wanted_artist not in names and names not in wanted_artist:
            continue
        lyric = httpx.get(f"https://lrc.red/s/{hit['isrc']}.ttml", headers=headers, timeout=TIMEOUT)
        if lyric.status_code == 200 and lyric.text.lstrip().startswith(("<?xml", "<tt")):
            return {"ttml": lyric.text, "lrc": None}
    return None


def _unison(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    params = {"song": title, "artist": artist, "duration": duration}
    if album:
        params["album"] = album
    response = httpx.get(
        "https://unison.boidu.dev/lyrics", params=params, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT
    )
    if response.status_code != 200:
        return None
    body = ((response.json().get("data")) or {}).get("lyrics") or ""
    if body.lstrip().startswith(("<?xml", "<tt")):
        return {"ttml": body, "lrc": None}
    return {"ttml": None, "lrc": body} if _timed(body) else None


def _megalobiz(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers = {"User-Agent": USER_AGENT}
    if keys.get("api_key"):
        headers["X-API-Key"] = keys["api_key"]
    base = "https://api.megalobiz.com/api/public/v1"
    search = httpx.get(
        f"{base}/search",
        params={"title": title, "artist": artist, "duration": duration, "limit": 5},
        headers=headers,
        timeout=TIMEOUT,
    )
    if search.status_code != 200:
        return None
    for result in search.json().get("results", []):
        if float(result.get("duration_diff") or 0) > DURATION_TOLERANCE_SECONDS:
            continue
        lrc = httpx.get(f"{base}/lrc/{result['id']}", params={"format": "lrc"}, headers=headers, timeout=TIMEOUT)
        if lrc.status_code == 200 and _timed(lrc.text):
            return {"ttml": None, "lrc": lrc.text}
    return None


def _qq(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://y.qq.com/portal/player.html", "Origin": "https://y.qq.com"}
    search = httpx.get(
        "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg",
        params={"key": f"{artist} {title}", "format": "json"},
        headers=headers,
        timeout=TIMEOUT,
    )
    if search.status_code != 200:
        return None
    songs = (((search.json().get("data") or {}).get("song")) or {}).get("itemlist") or []
    wanted_artist, wanted_title = _norm(artist), _norm(title)
    for song in songs:
        names = _norm(song.get("singer", ""))
        if _norm(song.get("name", "")) != wanted_title:
            continue
        if wanted_artist and wanted_artist not in names and names not in wanted_artist:
            continue
        lyric = httpx.get(
            "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
            params={"songmid": song["mid"], "g_tk": 5381, "format": "json", "inCharset": "utf8", "outCharset": "utf-8", "nobase64": 1},
            headers=headers,
            timeout=TIMEOUT,
        )
        if lyric.status_code != 200:
            continue
        lrc = _timed(lyric.json().get("lyric"))
        if lrc:
            return {"ttml": None, "lrc": lrc}
    return None


def _apple(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    developer_token, user_token = keys.get("developer_token"), keys.get("media_user_token")
    if not developer_token or not user_token:
        return None
    storefront = (keys.get("storefront") or "us").strip().lower()
    headers = {
        "Authorization": f"Bearer {developer_token}",
        "Media-User-Token": user_token,
        "Origin": "https://music.apple.com",
        "User-Agent": "Mozilla/5.0",
    }
    base = f"https://amp-api.music.apple.com/v1/catalog/{storefront}"
    search = httpx.get(
        f"{base}/search", params={"term": f"{artist} {title}", "types": "songs", "limit": 5}, headers=headers, timeout=TIMEOUT
    )
    if search.status_code != 200:
        return None
    wanted_artist = _norm(artist)
    for song in (((search.json().get("results") or {}).get("songs")) or {}).get("data", []):
        attributes = song.get("attributes") or {}
        seconds = float(attributes.get("durationInMillis") or 0) / 1000
        names = _norm(attributes.get("artistName", ""))
        if abs(seconds - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        if wanted_artist and wanted_artist not in names and names not in wanted_artist:
            continue
        for endpoint in ("syllable-lyrics", "lyrics"):
            lyric = httpx.get(f"{base}/songs/{song['id']}/{endpoint}", headers=headers, timeout=TIMEOUT)
            if lyric.status_code != 200:
                continue
            ttml = (((lyric.json().get("data") or [{}])[0]).get("attributes") or {}).get("ttml")
            if ttml:
                return {"ttml": ttml, "lrc": None}
    return None


@dataclass(frozen=True)
class KeyField:
    id: str
    label: str
    secret: bool = True


@dataclass(frozen=True)
class LyricsProvider:
    id: str
    label: str
    description: str
    word_level: bool
    fetch: Callable[[str, str, str, int, Keys], Optional[LyricsPayload]]
    key_fields: tuple[KeyField, ...] = ()
    key_url: Optional[str] = None
    key_required: bool = False


# Default order is quality first: word-level sources, then line-synced fallbacks.
PROVIDERS: tuple[LyricsProvider, ...] = (
    LyricsProvider("blyrics", "Better Lyrics", "Word-synced lyrics (Apple Music based)", True, _blyrics),
    LyricsProvider("lyricsplus", "LyricsPlus", "Word-synced lyrics aggregated from several sources", True, _lyricsplus),
    LyricsProvider("lrcred", "lrc.red", "Word-synced lyrics with a large catalogue", True, _lrcred),
    LyricsProvider("unison", "Unison", "Crowdsourced word-synced lyrics from Better Lyrics users", True, _unison),
    LyricsProvider(
        "apple", "Apple Music", "Syllable-synced lyrics. Needs an Apple Music subscription and your own tokens.", True, _apple,
        key_fields=(
            KeyField("developer_token", "Developer token"),
            KeyField("media_user_token", "Media user token"),
            KeyField("storefront", "Storefront (e.g. us)", False),
        ),
        key_url="https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens",
        key_required=True,
    ),
    LyricsProvider("lrclib", "LRCLIB", "Community line-synced lyrics", False, _lrclib),
    LyricsProvider(
        "megalobiz", "Megalobiz", "Line-synced LRC sheets. An API key is optional and raises the rate limit.", False, _megalobiz,
        key_fields=(KeyField("api_key", "API key"),),
        key_url="https://megalobiz.com/developers",
    ),
    LyricsProvider("netease", "NetEase Cloud Music", "Line-synced lyrics, large catalogue", False, _netease),
    LyricsProvider("qq", "QQ Music", "Line-synced lyrics from QQ Music", False, _qq),
)
PROVIDER_IDS = tuple(provider.id for provider in PROVIDERS)
PROVIDERS_BY_ID = {provider.id: provider for provider in PROVIDERS}


def run_provider(
    provider: LyricsProvider, artist: str, album: str, title: str, duration: int, keys: Optional[Keys] = None
) -> Optional[LyricsPayload]:
    try:
        return provider.fetch(artist, album, title, duration, keys or {})
    except Exception as exc:  # network or parsing failures must not abort the pipeline
        logger.warning("[Lyrics] %s failed for '%s': %s", provider.label, title, exc)
        return None
