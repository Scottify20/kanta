"""Remote lyrics sources with connection pooling, rate limiting, cooldowns, and mirror rotation."""

import base64
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import logging
import re
import threading
import time
from typing import Any, Callable, Optional
import xml.etree.ElementTree as ET

import httpx

logger = logging.getLogger("uvicorn")

LyricsPayload = dict[str, Optional[str]]
Keys = dict[str, str]

USER_AGENT = "Kanta/1.0 (https://github.com/Scottify20/kanta)"
TIMEOUT = 8.0
DURATION_TOLERANCE_SECONDS = 6
MISS_CACHE_TTL_SECONDS = 900.0
MAX_MISS_CACHE_ENTRIES = 2000

HAS_TIMESTAMPS = re.compile(r"(?m)^\s*\[\d{1,3}:\d{2}(?:[.:]\d+)?\]")
ENHANCED_WORD_TAG = re.compile(r"<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>")
YRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.+)$")
YRC_WORD_RE = re.compile(r"\((\d+),(\d+),\d+\)([^(]*)")
QRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.+)$")
QRC_WORD_RE = re.compile(r"([^(]+?)\((\d+),(\d+)\)")
FEAT_SPLIT_RE = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|with|x|×)\s+", re.IGNORECASE)
PRIMARY_ARTIST_SPLIT_RE = re.compile(r"\s*(?:,|;|&|/|\+|feat\.?|ft\.?|featuring)\s*", re.IGNORECASE)
CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
LEADING_PUNCT_RE = re.compile(r"^[,.;:!?)}\]]")

_http_lock = threading.Lock()
_http_client: Optional[httpx.Client] = None

_rate_lock = threading.Lock()
_last_request_at: dict[str, float] = {}
_cooldown_until: dict[str, float] = {}
_consecutive_429s: dict[str, int] = {}
_miss_cache: dict[tuple[str, str, str, int], float] = {}

_mxm_lock = threading.Lock()
_mxm_token: dict[str, Any] = {"token": None, "expires_at": 0.0}

PROVIDER_MIN_INTERVAL: dict[str, float] = {
    "blyrics": 0.35,
    "blyrics_qq": 0.35,
    "binilyrics": 0.30,
    "lrcred": 0.30,
    "lyricsplus": 0.30,
    "unison": 0.35,
    "amll": 0.15,
    "lrcmux": 1.15,
    "paxsenix": 0.65,
    "apple": 0.25,
    "lrclib": 0.25,
    "megalobiz": 0.60,
    "kugou": 0.40,
    "musixmatch": 1.10,
    "netease": 0.40,
    "qq": 0.40,
}

LYRICSPLUS_MIRRORS = (
    "https://lyricsplus.binimum.org",
    "https://lyricsplus.atomix.one",
    "https://lyricsplus.prjktla.my.id",
    "https://lyricsplus.prjktla.workers.dev",
)

BETTERLYRICS_HOSTS = (
    "https://api.betterlyrics.org",
    "https://lyrics-api.boidu.dev",
)

UNISON_HOSTS = (
    "https://unison.betterlyrics.org",
    "https://unison.boidu.dev",
)


def _client() -> httpx.Client:
    global _http_client
    with _http_lock:
        if _http_client is None or _http_client.is_closed:
            _http_client = httpx.Client(
                timeout=TIMEOUT,
                follow_redirects=True,
                limits=httpx.Limits(max_connections=24, max_keepalive_connections=12),
                headers={"User-Agent": USER_AGENT},
            )
        return _http_client


def _parse_retry_after(header_value: Optional[str], default_seconds: float) -> float:
    if not header_value:
        return default_seconds
    raw = header_value.strip()
    try:
        return max(1.0, min(600.0, float(raw)))
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(raw)
        delta = dt.timestamp() - time.time()
        return max(1.0, min(600.0, delta))
    except (TypeError, ValueError):
        return default_seconds


def is_in_cooldown(provider_id: str) -> bool:
    with _rate_lock:
        return time.monotonic() < _cooldown_until.get(provider_id, 0.0)


def _record_cooldown(provider_id: str, seconds: float, reason: str) -> None:
    until = time.monotonic() + seconds
    with _rate_lock:
        if until > _cooldown_until.get(provider_id, 0.0):
            _cooldown_until[provider_id] = until
    logger.warning("[Lyrics] %s entering %.0fs cooldown (%s)", provider_id, seconds, reason)


def _pace(provider_id: str) -> bool:
    min_interval = PROVIDER_MIN_INTERVAL.get(provider_id, 0.30)
    while True:
        with _rate_lock:
            now = time.monotonic()
            if now < _cooldown_until.get(provider_id, 0.0):
                return False
            last = _last_request_at.get(provider_id, 0.0)
            wait = min_interval - (now - last)
            if wait <= 0:
                _last_request_at[provider_id] = now
                return True
        time.sleep(min(wait, 1.5))


def _request(
    provider_id: str,
    method: str,
    url: str,
    *,
    params: Optional[dict[str, Any]] = None,
    data: Optional[dict[str, Any]] = None,
    headers: Optional[dict[str, str]] = None,
    timeout: float = TIMEOUT,
) -> Optional[httpx.Response]:
    if not _pace(provider_id):
        return None
    try:
        response = _client().request(
            method, url, params=params, data=data, headers=headers, timeout=timeout
        )
    except (httpx.TimeoutException, httpx.HTTPError):
        return None

    if response.status_code == 429:
        with _rate_lock:
            strikes = _consecutive_429s.get(provider_id, 0) + 1
            _consecutive_429s[provider_id] = strikes
        default_wait = min(300.0, 30.0 * (2 ** min(strikes - 1, 3)))
        wait_s = _parse_retry_after(response.headers.get("Retry-After"), default_wait)
        _record_cooldown(provider_id, wait_s, "HTTP 429")
        return None

    if response.status_code == 503:
        wait_s = _parse_retry_after(response.headers.get("Retry-After"), 25.0)
        _record_cooldown(provider_id, wait_s, "HTTP 503")
        return None

    if response.status_code < 400:
        with _rate_lock:
            _consecutive_429s.pop(provider_id, None)

    return response


def _norm(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value or "", flags=re.UNICODE).casefold().strip()


def _clean_title(title: str) -> str:
    cleaned = FEAT_SPLIT_RE.split(title or "")[0]
    cleaned = re.sub(
        r"\s*[-–—]\s*(?:remaster(?:ed)?|radio edit|single version|album version|explicit|clean|bonus track|live).*$",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned.strip() or (title or "").strip()


def _primary_artist(artist: str) -> str:
    parts = [p.strip() for p in PRIMARY_ARTIST_SPLIT_RE.split(artist or "") if p.strip()]
    return parts[0] if parts else (artist or "").strip()


def _artist_matches(wanted: str, candidate: str) -> bool:
    w = _norm(wanted)
    c = _norm(candidate)
    if not w:
        return True
    if not c:
        return False
    if w in c or c in w:
        return True
    primary = _norm(_primary_artist(wanted))
    return bool(primary) and (primary in c or c in primary)


def _title_matches(wanted: str, candidate: str) -> bool:
    w = _norm(_clean_title(wanted))
    c = _norm(_clean_title(candidate))
    if not w or not c:
        return False
    if w == c or w in c or c in w:
        return True
    w_tokens = set(w.split())
    c_tokens = set(c.split())
    if not w_tokens or not c_tokens:
        return False
    overlap = len(w_tokens & c_tokens) / max(len(w_tokens), len(c_tokens))
    return overlap >= 0.7


def _timed(lrc: Optional[str]) -> Optional[str]:
    return lrc if lrc and HAS_TIMESTAMPS.search(lrc) else None


def _maybe_decode_base64_lyrics(raw: str) -> str:
    """Decode base64-wrapped TTML or LRC responses (used by some Better Lyrics endpoints)."""
    stripped = (raw or "").strip()
    if not stripped or stripped.startswith(("<", "[")):
        return raw
    if len(stripped) < 24 or not re.fullmatch(r"[A-Za-z0-9+/=\s_-]+", stripped):
        return raw
    try:
        decoded = base64.b64decode(stripped).decode("utf-8-sig")
    except (ValueError, UnicodeDecodeError):
        return raw
    if decoded.lstrip().startswith(("<?xml", "<tt")) or HAS_TIMESTAMPS.search(decoded):
        return decoded
    return raw


def _pick_num(obj: dict[str, Any], keys: tuple[str, ...]) -> Optional[float]:
    """Return the first present, numeric value (preserving 0.0 accurately)."""
    for key in keys:
        if key in obj and obj[key] is not None:
            try:
                val = float(obj[key])
                if val >= 0:
                    return val
            except (TypeError, ValueError):
                continue
    return None


def _ttml_time(milliseconds: float) -> str:
    return f"{max(0.0, milliseconds) / 1000:.3f}s"


def _word_ttml(lines: list[dict[str, Any]]) -> Optional[str]:
    """Build word-timed TTML from [{"begin", "end", "words": [(begin, end, text)], "agent"?: str}] in ms."""
    if not lines:
        return None
    root = ET.Element(
        "tt",
        {
            "xmlns": "http://www.w3.org/ns/ttml",
            "xmlns:itunes": "http://music.apple.com/lyric-ttml-internal",
            "xmlns:ttm": "http://www.w3.org/ns/ttml#metadata",
            "itunes:timing": "Word",
        },
    )
    div = ET.SubElement(ET.SubElement(root, "body"), "div")
    for line in lines:
        words: list[tuple[float, float, str]] = line["words"]
        if not words:
            continue
        # If tokens don't carry explicit whitespace and aren't CJK syllables, join words with spaces.
        has_explicit_spaces = any(
            txt[:1].isspace() or txt[-1:].isspace() for _, _, txt in words
        )
        line_joined = "".join(txt for _, _, txt in words)
        auto_space = not has_explicit_spaces and not CJK_RE.search(line_joined)

        attrs: dict[str, str] = {
            "begin": _ttml_time(line["begin"]),
            "end": _ttml_time(line["end"]),
        }
        if line.get("agent"):
            attrs["ttm:agent"] = str(line["agent"])
        paragraph = ET.SubElement(div, "p", attrs)

        previous: Optional[ET.Element] = None
        for idx, (begin, end, text) in enumerate(words):
            if text[:1].isspace() and previous is not None:
                previous.tail = (previous.tail or "") + " "
            span = ET.SubElement(
                paragraph, "span", {"begin": _ttml_time(begin), "end": _ttml_time(end)}
            )
            span.text = text.strip()
            if text[-1:].isspace():
                span.tail = " "
            elif auto_space and idx + 1 < len(words):
                next_txt = words[idx + 1][2].strip()
                if next_txt and not LEADING_PUNCT_RE.match(next_txt):
                    span.tail = " "
            previous = span
    return '<?xml version="1.0" encoding="UTF-8"?>' + ET.tostring(root, encoding="unicode")


def _lrc_from_lines(lines: list[tuple[float, str]]) -> Optional[str]:
    rows = []
    for begin, text in lines:
        text = text.strip()
        if not text:
            continue
        seconds = max(0.0, begin) / 1000.0
        rows.append(f"[{int(seconds // 60):02d}:{seconds % 60:05.2f}]{text}")
    return "\n".join(rows) if rows else None


def _elrc_to_word_ttml(content: str) -> Optional[str]:
    if not ENHANCED_WORD_TAG.search(content):
        return None
    parsed_lines: list[dict[str, Any]] = []
    line_re = re.compile(r"^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.+)$")

    def _to_ms(m: str, s: str, frac: Optional[str]) -> float:
        ms = int(m) * 60_000 + int(s) * 1000
        if frac:
            ms += int(frac.ljust(3, "0")[:3])
        return float(ms)

    for raw in content.splitlines():
        match = line_re.match(raw)
        if not match:
            continue
        line_start = _to_ms(match.group(1), match.group(2), match.group(3))
        body = match.group(4)
        tags = list(ENHANCED_WORD_TAG.finditer(body))
        if not tags:
            continue
        words: list[tuple[float, float, str]] = []
        for idx, tag in enumerate(tags):
            w_start = _to_ms(tag.group(1), tag.group(2), tag.group(3))
            text_start = tag.end()
            text_end = tags[idx + 1].start() if idx + 1 < len(tags) else len(body)
            word_text = body[text_start:text_end]
            w_end = (
                _to_ms(tags[idx + 1].group(1), tags[idx + 1].group(2), tags[idx + 1].group(3))
                if idx + 1 < len(tags)
                else w_start + 350.0
            )
            if word_text.strip():
                words.append((w_start, max(w_start + 40.0, w_end), word_text))
        if words:
            parsed_lines.append({
                "begin": min(line_start, words[0][0]),
                "end": words[-1][1],
                "words": words,
            })
    return _word_ttml(parsed_lines)


def _yrc_to_word_ttml(content: str) -> Optional[str]:
    built: list[dict[str, Any]] = []
    for raw in content.splitlines():
        m = YRC_LINE_RE.match(raw.strip())
        if not m:
            continue
        line_start = float(m.group(1))
        line_dur = float(m.group(2))
        words: list[tuple[float, float, str]] = []
        for wm in YRC_WORD_RE.finditer(m.group(3)):
            w_start = float(wm.group(1))
            w_dur = float(wm.group(2))
            w_text = wm.group(3)
            if w_text.strip():
                words.append((w_start, w_start + max(40.0, w_dur), w_text))
        if words:
            built.append({
                "begin": line_start,
                "end": max(line_start + line_dur, words[-1][1]),
                "words": words,
            })
    return _word_ttml(built)


def _qrc_to_word_ttml(content: str) -> Optional[str]:
    built: list[dict[str, Any]] = []
    for raw in content.splitlines():
        m = QRC_LINE_RE.match(raw.strip())
        if not m:
            continue
        line_start = float(m.group(1))
        line_dur = float(m.group(2))
        words: list[tuple[float, float, str]] = []
        for wm in QRC_WORD_RE.finditer(m.group(3)):
            w_text = wm.group(1)
            w_start = float(wm.group(2))
            w_dur = float(wm.group(3))
            if w_text.strip():
                words.append((w_start, w_start + max(40.0, w_dur), w_text))
        if words:
            built.append({
                "begin": line_start,
                "end": max(line_start + line_dur, words[-1][1]),
                "words": words,
            })
    return _word_ttml(built)


def _normalize_text_payload(raw_text: str) -> Optional[LyricsPayload]:
    if not raw_text or not raw_text.strip():
        return None
    decoded = _maybe_decode_base64_lyrics(raw_text)
    stripped = decoded.lstrip()
    if stripped.startswith(("<?xml", "<tt")):
        return {"ttml": decoded, "lrc": None}
    elrc_ttml = _elrc_to_word_ttml(decoded)
    if elrc_ttml:
        return {"ttml": elrc_ttml, "lrc": None}
    yrc_ttml = _yrc_to_word_ttml(decoded)
    if yrc_ttml:
        return {"ttml": yrc_ttml, "lrc": None}
    qrc_ttml = _qrc_to_word_ttml(decoded)
    if qrc_ttml:
        return {"ttml": qrc_ttml, "lrc": None}
    if _timed(decoded):
        return {"ttml": None, "lrc": decoded}
    return None


def _blyrics(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers: dict[str, str] = {"User-Agent": USER_AGENT}
    if keys.get("api_key"):
        headers["X-API-Key"] = keys["api_key"]

    clean_t = _clean_title(title)
    primary_a = _primary_artist(artist)
    queries: list[dict[str, Any]] = []
    if album:
        queries.append({"s": clean_t, "a": artist, "al": album, "d": duration})
    queries.append({"s": clean_t, "a": artist, "d": duration})
    if primary_a.casefold() != artist.casefold():
        queries.append({"s": clean_t, "a": primary_a, "d": duration})

    for host in BETTERLYRICS_HOSTS:
        host_unreachable = False
        for params in queries:
            response = _request("blyrics", "GET", f"{host}/getLyrics", params=params, headers=headers)
            if response is None:
                host_unreachable = True
                break
            if response.status_code in (401, 403):
                return None
            if response.status_code != 200:
                continue
            try:
                data = response.json()
            except ValueError:
                parsed = _normalize_text_payload(response.text)
                if parsed:
                    return parsed
                continue
            if not isinstance(data, dict):
                continue
            for field in ("ttml", "lyrics", "lrc"):
                val = data.get(field)
                if isinstance(val, str) and val.strip():
                    parsed = _normalize_text_payload(val)
                    if parsed:
                        return parsed
        if not host_unreachable:
            break
    return None


def _blyrics_qq(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers: dict[str, str] = {"User-Agent": USER_AGENT}
    if keys.get("api_key"):
        headers["X-API-Key"] = keys["api_key"]

    clean_t = _clean_title(title)
    queries: list[dict[str, Any]] = []
    if album:
        queries.append({"s": clean_t, "a": artist, "al": album, "d": duration})
    queries.append({"s": clean_t, "a": artist, "d": duration})

    for host in BETTERLYRICS_HOSTS:
        host_unreachable = False
        for params in queries:
            response = _request("blyrics_qq", "GET", f"{host}/qq/getLyrics", params=params, headers=headers)
            if response is None:
                host_unreachable = True
                break
            if response.status_code in (401, 403):
                return None
            if response.status_code != 200:
                continue
            try:
                data = response.json()
            except ValueError:
                parsed = _normalize_text_payload(response.text)
                if parsed:
                    return parsed
                continue
            if not isinstance(data, dict):
                continue
            for field in ("ttml", "qrc", "lyrics", "lrc"):
                val = data.get(field)
                if isinstance(val, str) and val.strip():
                    parsed = _normalize_text_payload(val)
                    if parsed:
                        return parsed
        if not host_unreachable:
            break
    return None


def _lookup_deezer_isrc(artist: str, title: str, duration: int) -> Optional[str]:
    clean_t = _clean_title(title)
    resp = _request(
        "binilyrics",
        "GET",
        "https://api.deezer.com/search",
        params={"q": f'artist:"{_primary_artist(artist)}" track:"{clean_t}"', "limit": 6},
    )
    if resp is None or resp.status_code != 200:
        return None
    try:
        items = resp.json().get("data") or []
    except ValueError:
        return None
    for item in items:
        item_dur = float(item.get("duration") or 0)
        if duration > 1 and item_dur > 0 and abs(item_dur - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        cand_artist = (item.get("artist") or {}).get("name", "")
        cand_title = item.get("title", "")
        if _artist_matches(artist, cand_artist) and _title_matches(title, cand_title):
            track_id = item.get("id")
            if track_id:
                detail = _request("binilyrics", "GET", f"https://api.deezer.com/track/{track_id}")
                if detail is not None and detail.status_code == 200:
                    try:
                        isrc = detail.json().get("isrc")
                        if isinstance(isrc, str) and isrc.strip():
                            return isrc.strip()
                    except ValueError:
                        pass
    return None


def _binilyrics(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    clean_t = _clean_title(title)
    attempts: list[tuple[str, dict[str, Any]]] = [
        (
            "https://lyrics-api.binimum.org/getLyrics",
            {"title": clean_t, "artist": artist, "duration": duration, **({"album": album} if album else {})},
        ),
        (
            "https://lyrics-api.binimum.org/getLyrics",
            {"title": clean_t, "artist": _primary_artist(artist), "duration": duration},
        ),
    ]

    for url, params in attempts:
        resp = _request("binilyrics", "GET", url, params=params)
        if resp is None or resp.status_code != 200:
            continue
        parsed = _parse_binilyrics_response(resp)
        if parsed:
            return parsed

    isrc = _lookup_deezer_isrc(artist, title, duration)
    if isrc:
        resp = _request("binilyrics", "GET", "https://lyrics-api.binimum.org/", params={"isrc": isrc})
        if resp is not None and resp.status_code == 200:
            return _parse_binilyrics_response(resp)
    return None


def _parse_binilyrics_response(response: httpx.Response) -> Optional[LyricsPayload]:
    text = response.text or ""
    if text.lstrip().startswith(("<?xml", "<tt")):
        return {"ttml": text, "lrc": None}
    try:
        data = response.json()
    except ValueError:
        return _normalize_text_payload(text)

    if isinstance(data, list):
        candidates = data
    elif isinstance(data, dict):
        ttml_val = data.get("ttml")
        if isinstance(ttml_val, str) and ttml_val.strip():
            return _normalize_text_payload(ttml_val)
        lyrics_val = data.get("lyrics")
        if isinstance(lyrics_val, str) and lyrics_val.strip():
            return _normalize_text_payload(lyrics_val)
        candidates = (
            data.get("results")
            or data.get("hits")
            or ([data] if data.get("lyricsUrl") or data.get("url") else [])
        )
    else:
        return None

    for item in candidates:
        if not isinstance(item, dict):
            continue
        lyrics_url = item.get("lyricsUrl") or item.get("ttmlUrl") or item.get("url")
        if isinstance(lyrics_url, str) and lyrics_url.startswith(("http://", "https://")):
            fetched = _request("binilyrics", "GET", lyrics_url)
            if fetched is not None and fetched.status_code == 200:
                parsed = _normalize_text_payload(fetched.text)
                if parsed:
                    return parsed
    return None

def _lyricsplus(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    clean_t = _clean_title(title)
    base = {"title": clean_t, "artist": artist, "duration": duration}
    param_variants = [{**base, "album": album}, base] if album else [base]

    for mirror in LYRICSPLUS_MIRRORS:
        mirror_failed = False
        for params in param_variants:
            response = _request("lyricsplus", "GET", f"{mirror}/v2/lyrics/get", params=params)
            if response is None or response.status_code >= 500:
                mirror_failed = True
                break
            if response.status_code != 200:
                continue
            try:
                data = response.json()
            except ValueError:
                continue
            lines = data.get("lyrics") or []
            if str(data.get("type", "")).lower() == "word" and any(line.get("syllabus") for line in lines):
                built = []
                for line in lines:
                    words = [
                        (w["time"], w["time"] + w.get("duration", 0), w["text"])
                        for w in line.get("syllabus") or []
                        if w.get("text", "").strip() and w.get("time") is not None
                    ]
                    if words:
                        l_time = float(line.get("time") if line.get("time") is not None else words[0][0])
                        l_dur = float(line.get("duration") or 0)
                        built.append({
                            "begin": l_time,
                            "end": max(l_time + l_dur, words[-1][1]),
                            "words": words,
                            "agent": line.get("element", {}).get("singer")
                            if isinstance(line.get("element"), dict)
                            else None,
                        })
                ttml = _word_ttml(built)
                if ttml:
                    return {"ttml": ttml, "lrc": None}
            times = [line.get("time") or 0 for line in lines]
            if len(set(times)) > 1:
                lrc = _lrc_from_lines([(line["time"], line.get("text", "")) for line in lines if "time" in line])
                if _timed(lrc):
                    return {"ttml": None, "lrc": lrc}
        if not mirror_failed:
            break
    return None


def _lrcred(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    clean_t = _clean_title(title)
    search = _request(
        "lrcred",
        "GET",
        "https://lrc.red/search.json",
        params={"q": f"{clean_t} {_primary_artist(artist)}"},
    )
    if search is None or search.status_code != 200:
        return None
    try:
        hits = search.json().get("hits", [])[:8]
    except ValueError:
        return None
    for hit in hits:
        hit_dur = float(hit.get("duration") or 0)
        if duration > 1 and hit_dur > 0 and abs(hit_dur - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        if not _artist_matches(artist, hit.get("artist", "")):
            continue
        if not _title_matches(title, hit.get("title", "") or hit.get("name", "") or clean_t):
            continue
        isrc = hit.get("isrc")
        if not isrc:
            continue
        lyric = _request("lrcred", "GET", f"https://lrc.red/s/{isrc}.ttml")
        if lyric is not None and lyric.status_code == 200 and lyric.text.lstrip().startswith(("<?xml", "<tt")):
            return {"ttml": lyric.text, "lrc": None}
    return None


def _unison(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    clean_t = _clean_title(title)
    base = {"song": clean_t, "artist": artist, "duration": duration}
    variants = [{**base, "album": album}, base] if album else [base]

    for host in UNISON_HOSTS:
        host_failed = False
        for params in variants:
            response = _request("unison", "GET", f"{host}/lyrics", params=params)
            if response is None or response.status_code >= 500:
                host_failed = True
                break
            if response.status_code != 200:
                continue
            try:
                body = ((response.json().get("data")) or {}).get("lyrics") or ""
            except ValueError:
                continue
            parsed = _normalize_text_payload(body)
            if parsed:
                return parsed
        if not host_failed:
            break
    return None


def _amll(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    """AMLL TTML DB (api.amll.dev): Community Apple-style word/line TTML database."""
    clean_t = _clean_title(title)
    search = _request(
        "amll",
        "GET",
        "https://api.amll.dev/v1/lyrics/search",
        params={"q": f"{_primary_artist(artist)} {clean_t}", "limit": 8},
    )
    if search is None or search.status_code != 200:
        return None
    try:
        payload = search.json()
    except ValueError:
        return None

    hits = (
        payload
        if isinstance(payload, list)
        else (payload.get("data") or payload.get("results") or payload.get("items") or [])
    )
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        hit_title = hit.get("title") or hit.get("name") or ""
        hit_artist = hit.get("artist") or hit.get("artists") or ""
        if isinstance(hit_artist, list):
            hit_artist = " ".join(str(a) for a in hit_artist)
        if hit_title and not _title_matches(title, str(hit_title)):
            continue
        if hit_artist and not _artist_matches(artist, str(hit_artist)):
            continue
        hit_dur = float(hit.get("duration") or 0)
        if hit_dur > 1000:
            hit_dur /= 1000.0
        if duration > 1 and hit_dur > 0 and abs(hit_dur - duration) > DURATION_TOLERANCE_SECONDS:
            continue

        lyric_id = hit.get("id") or hit.get("lyricId")
        if not lyric_id:
            continue
        detail = _request("amll", "GET", "https://api.amll.dev/v1/lyrics/get", params={"id": lyric_id})
        if detail is None or detail.status_code != 200:
            continue
        if detail.text.lstrip().startswith(("<?xml", "<tt")):
            return {"ttml": detail.text, "lrc": None}
        try:
            data = detail.json()
            raw = data.get("ttml") or data.get("lyrics") or (data.get("data") or {}).get("ttml")
            if isinstance(raw, str):
                parsed = _normalize_text_payload(raw)
                if parsed:
                    return parsed
        except ValueError:
            continue
    return None


_START_KEYS = ("start", "start_time", "startTimeMs", "startTime", "time", "timestamp", "begin", "t")
_END_KEYS = ("end", "end_time", "endTimeMs", "endTime", "endtime")
_DUR_KEYS = ("duration", "dur", "durationMs", "d")


def _lrcmux(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    """Lrcmux (api.lrcmux.dev): Word-level & line-level aggregator (60 req/min rate limit)."""
    clean_t = _clean_title(title)
    params: dict[str, Any] = {
        "title": clean_t,
        "artist": _primary_artist(artist),
        "duration": duration,
        "level": "word",
        "format": "json",
    }
    if album:
        params["album"] = album

    resp = _request("lrcmux", "GET", "https://api.lrcmux.dev/get", params=params)
    if resp is None or resp.status_code != 200:
        return None
    try:
        payload = resp.json()
    except ValueError:
        return _normalize_text_payload(resp.text)

    if not isinstance(payload, dict):
        return None
    raw_data = payload.get("data")
    data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else payload

    ret_artist = data.get("artist") or ""
    ret_title = data.get("title") or ""
    ret_dur = float(data.get("duration") or 0)
    if ret_dur > 1000:
        ret_dur /= 1000.0
    if duration > 1 and ret_dur > 0 and abs(ret_dur - duration) > DURATION_TOLERANCE_SECONDS:
        return None
    if ret_artist and not _artist_matches(artist, str(ret_artist)):
        return None
    if ret_title and not _title_matches(title, str(ret_title)):
        return None

    for key in ("ttml", "richSyncedLyrics", "enhancedLyrics", "syncedLyrics", "lrc", "lyrics"):
        val = data.get(key)
        if isinstance(val, str):
            parsed = _normalize_text_payload(val)
            if parsed:
                return parsed

    timed_lines = data.get("lines") or data.get("timed_lyrics") or []
    if not isinstance(timed_lines, list) or not timed_lines:
        return None

    # Detect whether timestamps are in seconds or milliseconds.
    sample_times: list[float] = []
    for ln in timed_lines:
        if not isinstance(ln, dict):
            continue
        ls = _pick_num(ln, _START_KEYS)
        if ls is not None:
            sample_times.append(ls)
        for w in ln.get("words") or ln.get("syllables") or []:
            if isinstance(w, dict):
                ws = _pick_num(w, _START_KEYS)
                if ws is not None:
                    sample_times.append(ws)

    if not sample_times:
        return None
    max_raw = max(sample_times)
    # Last lyric line of any real song is <= 1800 in seconds (30 min), vs >= 5000 in ms.
    scale = 1000.0 if (0 < max_raw <= 1800) else 1.0

    built_word: list[dict[str, Any]] = []
    built_line: list[tuple[float, str]] = []

    for idx, ln in enumerate(timed_lines):
        if not isinstance(ln, dict):
            continue
        raw_ls = _pick_num(ln, _START_KEYS)
        raw_le = _pick_num(ln, _END_KEYS)
        raw_ld = _pick_num(ln, _DUR_KEYS)

        l_start = raw_ls * scale if raw_ls is not None else None
        l_end = (
            raw_le * scale
            if raw_le is not None
            else (l_start + raw_ld * scale if l_start is not None and raw_ld is not None else None)
        )

        words_raw = ln.get("words") or ln.get("syllables") or []
        if isinstance(words_raw, list) and words_raw:
            parsed_words: list[tuple[float, Optional[float], str]] = []
            for w in words_raw:
                if not isinstance(w, dict):
                    continue
                w_txt = str(w.get("word") if w.get("word") is not None else (w.get("text") or ""))
                if not w_txt.strip():
                    continue
                raw_ws = _pick_num(w, _START_KEYS)
                if raw_ws is None:
                    continue
                raw_we = _pick_num(w, _END_KEYS)
                raw_wd = _pick_num(w, _DUR_KEYS)
                w_s = raw_ws * scale
                w_e = (
                    raw_we * scale
                    if raw_we is not None
                    else (w_s + raw_wd * scale if raw_wd is not None else None)
                )
                parsed_words.append((w_s, w_e, w_txt))

            if parsed_words:
                final_words: list[tuple[float, float, str]] = []
                for wi, (w_s, w_e, w_txt) in enumerate(parsed_words):
                    if w_e is None or w_e <= w_s:
                        next_s = parsed_words[wi + 1][0] if wi + 1 < len(parsed_words) else l_end
                        w_e = next_s if (next_s is not None and next_s > w_s) else w_s + 250.0
                    final_words.append((w_s, max(w_s + 40.0, w_e), w_txt))

                eff_start = l_start if l_start is not None else final_words[0][0]
                eff_end = max(l_end or 0.0, final_words[-1][1])
                built_word.append({"begin": eff_start, "end": eff_end, "words": final_words})

        text_val = ln.get("text") or ln.get("words_text")
        if l_start is not None and isinstance(text_val, str) and text_val.strip():
            built_line.append((l_start, text_val))
        elif l_start is not None and isinstance(words_raw, list) and words_raw:
            joined = " ".join(
                str(w.get("word") if w.get("word") is not None else (w.get("text") or "")).strip()
                for w in words_raw
                if isinstance(w, dict)
            ).strip()
            if joined:
                built_line.append((l_start, joined))

    if built_word:
        distinct_line_starts = {round(line["begin"] / 100.0) for line in built_word}
        span_ms = max(line["begin"] for line in built_word) - min(line["begin"] for line in built_word)
        multi_word_lines = [line for line in built_word if len(line["words"]) > 1]
        varied_word_lines = sum(
            1 for line in multi_word_lines if len({round(w[0] / 50.0) for w in line["words"]}) > 1
        )
        if (
            len(distinct_line_starts) >= 4
            and span_ms >= 5000.0
            and (not multi_word_lines or varied_word_lines >= len(multi_word_lines) * 0.5)
        ):
            return {"ttml": _word_ttml(built_word), "lrc": None}

    if built_line:
        distinct_starts = {round(ts / 100.0) for ts, _ in built_line}
        span_ms = max(ts for ts, _ in built_line) - min(ts for ts, _ in built_line)
        if len(distinct_starts) >= 4 and span_ms >= 5000.0:
            lrc = _lrc_from_lines(built_line)
            if _timed(lrc):
                return {"ttml": None, "lrc": lrc}
    return None


def _paxsenix(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    clean_t = _clean_title(title)
    itunes = _request(
        "paxsenix",
        "GET",
        "https://itunes.apple.com/search",
        params={"term": f"{_primary_artist(artist)} {clean_t}", "entity": "song", "limit": 6},
    )
    if itunes is None or itunes.status_code != 200:
        return None
    try:
        results = itunes.json().get("results") or []
    except ValueError:
        return None

    track_id: Optional[int] = None
    for entry in results:
        dur_s = float(entry.get("trackTimeMillis") or 0) / 1000.0
        if duration > 1 and dur_s > 0 and abs(dur_s - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        if not _artist_matches(artist, entry.get("artistName", "")):
            continue
        if not _title_matches(title, entry.get("trackName", "")):
            continue
        tid = entry.get("trackId")
        if tid:
            track_id = int(tid)
            break

    if not track_id:
        return None

    resp = _request(
        "paxsenix",
        "GET",
        "https://lyrics.paxsenix.org/apple-music/lyrics",
        params={"id": track_id, "ttml": "true", "v": "2"},
    )
    if resp is None or resp.status_code != 200:
        return None
    if resp.text.lstrip().startswith(("<?xml", "<tt")):
        return {"ttml": resp.text, "lrc": None}
    try:
        data = resp.json()
    except ValueError:
        return _normalize_text_payload(resp.text)

    if isinstance(data, dict):
        for field in ("ttmlContent", "ttml", "elrc", "lrc"):
            val = data.get(field)
            if isinstance(val, str) and val.strip():
                parsed = _normalize_text_payload(val)
                if parsed:
                    return parsed
        content = data.get("content")
        if isinstance(content, list) and content:
            built: list[dict[str, Any]] = []
            for line in content:
                if not isinstance(line, dict):
                    continue
                syllables = line.get("text")
                if isinstance(syllables, list):
                    words: list[tuple[float, float, str]] = []
                    for w in syllables:
                        if not isinstance(w, dict):
                            continue
                        w_text = str(w.get("text") or "")
                        w_ts = w.get("timestamp")
                        if not w_text.strip() or w_ts is None:
                            continue
                        w_start = float(w_ts)
                        w_end_raw = w.get("endtime")
                        w_end = float(w_end_raw) if w_end_raw is not None else w_start + 250.0
                        words.append((w_start, max(w_start + 40.0, w_end), w_text))
                    if words:
                        line_ts = line.get("timestamp")
                        line_end_raw = line.get("endtime")
                        line_begin = float(line_ts) if line_ts is not None else words[0][0]
                        line_end = float(line_end_raw) if line_end_raw is not None else words[-1][1]
                        built.append({
                            "begin": line_begin,
                            "end": max(line_end, words[-1][1]),
                            "words": words,
                        })
            if built:
                return {"ttml": _word_ttml(built), "lrc": None}
    return None


def _lrclib(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    clean_t = _clean_title(title)
    response = _request(
        "lrclib",
        "GET",
        "https://lrclib.net/api/get",
        params={"artist_name": artist, "track_name": clean_t, "album_name": album, "duration": duration},
    )
    if response is not None and response.status_code == 200:
        try:
            synced = response.json().get("syncedLyrics")
            if synced:
                parsed = _normalize_text_payload(synced)
                if parsed:
                    return parsed
        except ValueError:
            pass

    for search_artist in dict.fromkeys((artist, _primary_artist(artist))):
        response = _request(
            "lrclib",
            "GET",
            "https://lrclib.net/api/search",
            params={"track_name": clean_t, "artist_name": search_artist},
        )
        if response is None or response.status_code != 200:
            continue
        try:
            entries = response.json()
        except ValueError:
            continue
        for entry in entries:
            entry_dur = float(entry.get("duration") or 0)
            if duration > 1 and entry_dur > 0 and abs(entry_dur - duration) > DURATION_TOLERANCE_SECONDS:
                continue
            synced = entry.get("syncedLyrics")
            if synced:
                parsed = _normalize_text_payload(synced)
                if parsed:
                    return parsed
    return None


def _kugou(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    clean_t = _clean_title(title)
    search = _request(
        "kugou",
        "GET",
        "https://lyrics.kugou.com/search",
        params={
            "ver": 1,
            "man": "yes",
            "client": "pc",
            "keyword": f"{_primary_artist(artist)} - {clean_t}",
            "duration": duration * 1000,
        },
    )
    if search is None or search.status_code != 200:
        return None
    try:
        candidates = search.json().get("candidates") or []
    except ValueError:
        return None

    for cand in candidates[:6]:
        cand_dur = float(cand.get("duration") or 0) / 1000.0
        if duration > 1 and cand_dur > 0 and abs(cand_dur - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        if cand.get("singer") and not _artist_matches(artist, str(cand["singer"])):
            continue
        cid = cand.get("id")
        accesskey = cand.get("accesskey")
        if not cid or not accesskey:
            continue
        dl = _request(
            "kugou",
            "GET",
            "https://lyrics.kugou.com/download",
            params={"ver": 1, "client": "pc", "id": cid, "accesskey": accesskey, "fmt": "lrc", "charset": "utf8"},
        )
        if dl is None or dl.status_code != 200:
            continue
        try:
            encoded = dl.json().get("content")
            if not encoded:
                continue
            decoded = base64.b64decode(encoded).decode("utf-8-sig", errors="replace")
            parsed = _normalize_text_payload(decoded)
            if parsed:
                return parsed
        except (ValueError, OSError):
            continue
    return None


def _get_musixmatch_token(keys: Keys) -> Optional[str]:
    if keys.get("user_token"):
        return keys["user_token"].strip()
    now = time.monotonic()
    with _mxm_lock:
        if _mxm_token["token"] and now < _mxm_token["expires_at"]:
            return str(_mxm_token["token"])

    resp = _request(
        "musixmatch",
        "GET",
        "https://apic-desktop.musixmatch.com/ws/1.1/token.get",
        params={"app_id": "web-desktop-app-v1.0", "t": int(time.time() * 1000)},
        headers={"Cookie": "x-mxm-token-guid=", "User-Agent": "Mozilla/5.0"},
    )
    if resp is None or resp.status_code != 200:
        return None
    try:
        body = (resp.json().get("message") or {}).get("body") or {}
        token = body.get("user_token")
        if isinstance(token, str) and token and "UpgradeOnly" not in token:
            with _mxm_lock:
                _mxm_token["token"] = token
                _mxm_token["expires_at"] = time.monotonic() + 540.0
            return token
    except ValueError:
        pass
    return None


def _musixmatch(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    token = _get_musixmatch_token(keys)
    if not token:
        return None

    clean_t = _clean_title(title)
    resp = _request(
        "musixmatch",
        "GET",
        "https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get",
        params={
            "format": "json",
            "namespace": "lyrics_richsynched",
            "subtitle_format": "lrc",
            "app_id": "web-desktop-app-v1.0",
            "usertoken": token,
            "q_track": clean_t,
            "q_artist": _primary_artist(artist),
            "q_album": album or "",
            "f_subtitle_length": duration,
            "f_subtitle_length_max_deviation": DURATION_TOLERANCE_SECONDS,
        },
        headers={"User-Agent": "Mozilla/5.0"},
    )
    if resp is None or resp.status_code != 200:
        return None
    try:
        header = (resp.json().get("message") or {}).get("header") or {}
        if header.get("status_code") == 401:
            with _mxm_lock:
                _mxm_token["token"] = None
                _mxm_token["expires_at"] = 0.0
            _record_cooldown("musixmatch", 90.0, "captcha/token throttle")
            return None
        calls = ((resp.json().get("message") or {}).get("body") or {}).get("macro_calls") or {}
        sub_body = (
            ((calls.get("track.subtitles.get") or {}).get("message") or {}).get("body") or {}
        )
        sub_list = sub_body.get("subtitle_list") or []
        if sub_list:
            subtitle_body = (sub_list[0].get("subtitle") or {}).get("subtitle_body")
            if isinstance(subtitle_body, str):
                parsed = _normalize_text_payload(subtitle_body)
                if parsed:
                    return parsed
    except ValueError:
        pass
    return None


def _netease(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com"}
    clean_t = _clean_title(title)
    search = _request(
        "netease",
        "POST",
        "https://music.163.com/api/search/get",
        data={"s": f"{_primary_artist(artist)} {clean_t}", "type": 1, "limit": 8, "offset": 0},
        headers=headers,
    )
    if search is None or search.status_code != 200:
        return None
    try:
        songs = (search.json().get("result") or {}).get("songs") or []
    except ValueError:
        return None

    for song in songs:
        names = " ".join(a.get("name", "") for a in song.get("artists", []))
        seconds = float(song.get("duration") or 0) / 1000.0
        if duration > 1 and seconds > 0 and abs(seconds - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        if not _artist_matches(artist, names):
            continue
        lyric = _request(
            "netease",
            "GET",
            "https://music.163.com/api/song/lyric",
            params={"id": song["id"], "lv": 1, "kv": 1, "yv": 1, "tv": -1},
            headers=headers,
        )
        if lyric is None or lyric.status_code != 200:
            continue
        try:
            body = lyric.json()
        except ValueError:
            continue
        yrc_raw = (body.get("yrc") or {}).get("lyric")
        if isinstance(yrc_raw, str):
            yrc_ttml = _yrc_to_word_ttml(yrc_raw)
            if yrc_ttml:
                return {"ttml": yrc_ttml, "lrc": None}
        lrc = _timed((body.get("lrc") or {}).get("lyric"))
        if lrc:
            return {"ttml": None, "lrc": lrc}
    return None


def _megalobiz(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers = {"User-Agent": USER_AGENT}
    if keys.get("api_key"):
        headers["X-API-Key"] = keys["api_key"]
    base = "https://api.megalobiz.com/api/public/v1"
    clean_t = _clean_title(title)
    search = _request(
        "megalobiz",
        "GET",
        f"{base}/search",
        params={"title": clean_t, "artist": _primary_artist(artist), "duration": duration, "limit": 5},
        headers=headers,
    )
    if search is None or search.status_code != 200:
        return None
    try:
        results = search.json().get("results", [])
    except ValueError:
        return None
    for result in results:
        if float(result.get("duration_diff") or 0) > DURATION_TOLERANCE_SECONDS:
            continue
        lrc = _request("megalobiz", "GET", f"{base}/lrc/{result['id']}", params={"format": "lrc"}, headers=headers)
        if lrc is not None and lrc.status_code == 200:
            parsed = _normalize_text_payload(lrc.text)
            if parsed:
                return parsed
    return None


def _qq(artist: str, album: str, title: str, duration: int, keys: Keys) -> Optional[LyricsPayload]:
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://y.qq.com/portal/player.html",
        "Origin": "https://y.qq.com",
    }
    clean_t = _clean_title(title)
    search = _request(
        "qq",
        "GET",
        "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg",
        params={"key": f"{_primary_artist(artist)} {clean_t}", "format": "json"},
        headers=headers,
    )
    if search is None or search.status_code != 200:
        return None
    try:
        songs = (((search.json().get("data") or {}).get("song")) or {}).get("itemlist") or []
    except ValueError:
        return None
    for song in songs:
        if not _title_matches(title, song.get("name", "")):
            continue
        if not _artist_matches(artist, song.get("singer", "")):
            continue
        lyric = _request(
            "qq",
            "GET",
            "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
            params={
                "songmid": song["mid"],
                "g_tk": 5381,
                "format": "json",
                "inCharset": "utf8",
                "outCharset": "utf-8",
                "nobase64": 1,
            },
            headers=headers,
        )
        if lyric is None or lyric.status_code != 200:
            continue
        try:
            raw = lyric.json().get("lyric")
        except ValueError:
            continue
        if isinstance(raw, str):
            parsed = _normalize_text_payload(raw)
            if parsed:
                return parsed
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
    clean_t = _clean_title(title)
    search = _request(
        "apple",
        "GET",
        f"{base}/search",
        params={"term": f"{_primary_artist(artist)} {clean_t}", "types": "songs", "limit": 5},
        headers=headers,
    )
    if search is None or search.status_code != 200:
        return None
    try:
        songs = (((search.json().get("results") or {}).get("songs")) or {}).get("data", [])
    except ValueError:
        return None
    for song in songs:
        attributes = song.get("attributes") or {}
        seconds = float(attributes.get("durationInMillis") or 0) / 1000.0
        if duration > 1 and seconds > 0 and abs(seconds - duration) > DURATION_TOLERANCE_SECONDS:
            continue
        if not _artist_matches(artist, attributes.get("artistName", "")):
            continue
        for endpoint in ("syllable-lyrics", "lyrics"):
            lyric = _request("apple", "GET", f"{base}/songs/{song['id']}/{endpoint}", headers=headers)
            if lyric is None or lyric.status_code != 200:
                continue
            try:
                ttml = (((lyric.json().get("data") or [{}])[0]).get("attributes") or {}).get("ttml")
            except ValueError:
                continue
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


PROVIDERS: tuple[LyricsProvider, ...] = (
    LyricsProvider("lrcred", "lrc.red", "Word-synced TTML lyrics with a large catalog", True, _lrcred),
    LyricsProvider(
        "blyrics",
        "Better Lyrics",
        "Word-synced TTML lyrics (Apple Music based; optional API key)",
        True,
        _blyrics,
        key_fields=(KeyField("api_key", "API key (optional)"),),
    ),
    LyricsProvider("lyricsplus", "LyricsPlus", "Word-synced lyrics aggregated across multiple mirrors", True, _lyricsplus),
    LyricsProvider("binilyrics", "BiniLyrics", "Word-synced Apple-style TTML via Binimum API & ISRC", True, _binilyrics),
    LyricsProvider("blyrics_qq", "Better Lyrics Portato", "QQ Music word-synced lyrics via Better Lyrics API", True, _blyrics_qq),
    LyricsProvider("paxsenix", "PaxSenix", "Word-synced Apple Music TTML proxy via PaxSenix", True, _paxsenix),
    LyricsProvider("unison", "Unison", "Crowdsourced word-synced lyrics from Better Lyrics users", True, _unison),
    LyricsProvider("amll", "AMLL TTML DB", "Community Apple-style word/line TTML database", True, _amll),
    LyricsProvider("lrcmux", "Lrcmux", "Aggregated word- and line-synced lyrics (60 req/min)", True, _lrcmux),
    LyricsProvider(
        "apple",
        "Apple Music",
        "Official syllable-synced lyrics. Requires your own Apple Music tokens.",
        True,
        _apple,
        key_fields=(
            KeyField("developer_token", "Developer token"),
            KeyField("media_user_token", "Media user token"),
            KeyField("storefront", "Storefront (e.g. us)", False),
        ),
        key_url="https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens",
        key_required=True,
    ),
    LyricsProvider("netease", "NetEase Cloud Music", "Word-synced (YRC) and line-synced lyrics", True, _netease),
    LyricsProvider("lrclib", "LRCLIB", "Community line-synced lyrics", False, _lrclib),
    LyricsProvider("kugou", "KuGou", "Line-synced LRC lyrics with wide Asian & global catalog", False, _kugou),
    LyricsProvider(
        "musixmatch",
        "Musixmatch",
        "Synced LRC via Musixmatch (optional user token raises limits)",
        False,
        _musixmatch,
        key_fields=(KeyField("user_token", "User token (optional)"),),
    ),
    LyricsProvider(
        "megalobiz",
        "Megalobiz",
        "Line-synced LRC sheets. An API key is optional and raises the rate limit.",
        False,
        _megalobiz,
        key_fields=(KeyField("api_key", "API key"),),
        key_url="https://megalobiz.com/developers",
    ),
    LyricsProvider("qq", "QQ Music", "Line-synced lyrics from QQ Music", False, _qq),
)
PROVIDER_IDS = tuple(provider.id for provider in PROVIDERS)
PROVIDERS_BY_ID = {provider.id: provider for provider in PROVIDERS}


def run_provider(
    provider: LyricsProvider,
    artist: str,
    album: str,
    title: str,
    duration: int,
    keys: Optional[Keys] = None,
    *,
    bypass_miss_cache: bool = False,
) -> Optional[LyricsPayload]:
    if is_in_cooldown(provider.id):
        return None

    miss_key = (provider.id, _norm(artist), _norm(title), round(duration / 5))
    now = time.monotonic()
    if not bypass_miss_cache:
        with _rate_lock:
            expires = _miss_cache.get(miss_key)
            if expires and now < expires:
                return None

    try:
        result = provider.fetch(artist, album, title, duration, keys or {})
    except Exception as exc:
        logger.warning("[Lyrics] %s failed for '%s': %s", provider.label, title, exc)
        return None

    if result is None and not is_in_cooldown(provider.id):
        with _rate_lock:
            if len(_miss_cache) >= MAX_MISS_CACHE_ENTRIES:
                cutoff = time.monotonic()
                stale = [k for k, exp in _miss_cache.items() if exp <= cutoff]
                for k in stale[:500]:
                    _miss_cache.pop(k, None)
                if len(_miss_cache) >= MAX_MISS_CACHE_ENTRIES:
                    _miss_cache.clear()
            _miss_cache[miss_key] = time.monotonic() + MISS_CACHE_TTL_SECONDS

    return result