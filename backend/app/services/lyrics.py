from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import logging
from pathlib import Path
import re
from typing import Optional
import xml.etree.ElementTree as ET

from app.services.lyrics_providers import (
    PROVIDERS_BY_ID,
    LyricsProvider,
    run_provider,
)
from app.services.metadata import remove_title_annotations
from app.services.settings import (
    get_lyrics_provider_keys,
    get_lyrics_provider_order,
    get_lyrics_providers,
)

logger = logging.getLogger("uvicorn")
MAX_LYRICS_OFFSET_MS = 10_000
MAX_PARALLEL_PROVIDERS = 3
MIN_TIMED_LINES = 4
MIN_TIMELINE_SPAN_SECONDS = 5.0
LOCK_FILE = ".custom"

_LRC_LINE_RE = re.compile(r"(?m)^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$")
_INSTRUMENTAL_STUB_RE = re.compile(
    r"^\s*(?:[\[(]?\s*instrumental\s*[\])]?|♪|♫|🎵|\.+|-+)\s*$", re.IGNORECASE
)


def get_lyrics_offset_ms(lyrics_dir: Path) -> int:
    timing_file = lyrics_dir / "timing.json"
    try:
        timing = json.loads(timing_file.read_text(encoding="utf-8"))
        return int(timing.get("offset_ms", 0))
    except (OSError, json.JSONDecodeError, AttributeError, TypeError, ValueError):
        return 0


def max_offset_ms_for_duration(duration_seconds: Optional[float]) -> int:
    """Largest allowed lyrics offset (either direction): half the song duration."""
    if not duration_seconds or duration_seconds <= 0:
        return MAX_LYRICS_OFFSET_MS
    return round(duration_seconds * 1000 / 2)


def save_lyrics_offset_ms(lyrics_dir: Path, offset_ms: int) -> int:
    lyrics_dir.mkdir(parents=True, exist_ok=True)
    (lyrics_dir / "timing.json").write_text(
        json.dumps({"offset_ms": offset_ms}, indent=2) + "\n",
        encoding="utf-8",
    )
    return offset_ms


def lyrics_locked(lyrics_dir: Path) -> bool:
    """True when the user manually uploaded/removed lyrics; remote fetches must not override."""
    return (lyrics_dir / LOCK_FILE).exists()


def _srt_time_to_seconds(value: str) -> float:
    hours, minutes, rest = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(rest)


def convert_subtitles_to_lrc(content: str) -> Optional[str]:
    """Convert SRT/WebVTT cue text to line-timed LRC."""
    lines = []
    for block in re.split(r"\r?\n\s*\r?\n", content.replace("\ufeff", "")):
        rows = [row for row in block.splitlines() if row.strip()]
        for index, row in enumerate(rows):
            match = re.match(r"\s*(?:(\d+):)?(\d{1,2}:\d{2}[.,]\d{1,3})\s*-->", row)
            if not match:
                continue
            stamp = row.split("-->")[0].strip()
            if stamp.count(":") == 1:
                stamp = "00:" + stamp
            try:
                seconds = _srt_time_to_seconds(stamp)
            except ValueError:
                break
            text = " ".join(re.sub(r"<[^>]+>", "", r).strip() for r in rows[index + 1 :])
            if text.strip():
                minutes = int(seconds // 60)
                lines.append(f"[{minutes:02d}:{seconds - minutes * 60:05.2f}]{text.strip()}")
            break
    return "\n".join(lines) if lines else None


def _ttml_time_seconds(value: str) -> Optional[float]:
    value = value.strip()
    if value.endswith("ms"):
        try:
            return float(value[:-2]) / 1000.0
        except ValueError:
            return None
    if value.endswith("s"):
        try:
            return float(value[:-1])
        except ValueError:
            return None
    try:
        parts = [float(part) for part in value.split(":")]
    except ValueError:
        return None
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0] if parts else None
    value = value.strip()
    if value.endswith("s"):
        try:
            return float(value[:-1])
        except ValueError:
            return None
    try:
        parts = [float(part) for part in value.split(":")]
    except ValueError:
        return None
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0] if parts else None


def _inspect_ttml_timing(root: ET.Element) -> tuple[int, int, float, int, int, int]:
    """Return (real_lines, distinct_line_begins, span_s, word_spans, multi_word_lines, varied_word_lines)."""
    line_begins: list[float] = []
    word_spans = 0
    multi_word_lines = 0
    varied_word_lines = 0

    for p in root.iter():
        if p.tag.rsplit("}", 1)[-1].lower() != "p":
            continue
        text = "".join(p.itertext()).strip()
        if not text or _INSTRUMENTAL_STUB_RE.match(text):
            continue
        p_begin_raw = next(
            (v for k, v in p.attrib.items() if k.rsplit("}", 1)[-1].lower() == "begin"),
            None,
        )
        p_begin = _ttml_time_seconds(p_begin_raw) if p_begin_raw else None

        span_begins: list[float] = []
        for child in p.iter():
            if child.tag.rsplit("}", 1)[-1].lower() != "span":
                continue
            if not "".join(child.itertext()).strip():
                continue
            s_begin_raw = next(
                (v for k, v in child.attrib.items() if k.rsplit("}", 1)[-1].lower() == "begin"),
                None,
            )
            s_begin = _ttml_time_seconds(s_begin_raw) if s_begin_raw else None
            if s_begin is not None:
                word_spans += 1
                span_begins.append(s_begin)

        if p_begin is None and span_begins:
            p_begin = span_begins[0]
        if p_begin is not None:
            line_begins.append(p_begin)

        if len(span_begins) > 1:
            multi_word_lines += 1
            if len({round(t * 20) for t in span_begins}) > 1:
                varied_word_lines += 1

    distinct_lines = len({round(t * 10) for t in line_begins})
    span_s = (max(line_begins) - min(line_begins)) if len(line_begins) >= 2 else 0.0
    return (
        len(line_begins),
        distinct_lines,
        span_s,
        word_spans,
        multi_word_lines,
        varied_word_lines,
    )


def classify_ttml_content(content: str) -> str:
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return "none"

    real_lines, distinct_lines, span_s, word_spans, multi_word_lines, varied_word_lines = (
        _inspect_ttml_timing(root)
    )
    # Reject degenerate files where every timestamp is stuck at 0.000s.
    if distinct_lines < 2 or span_s < 2.0:
        return "none"

    if word_spans >= 2 and (multi_word_lines == 0 or varied_word_lines >= multi_word_lines * 0.4):
        return "word"

    return "line" if real_lines >= 2 else "none"


def _ttml_has_duet_agents(content: str) -> bool:
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return False

    agents: dict[str, str] = {}
    referenced: set[str] = set()
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1].lower()
        attrs = {key.rsplit("}", 1)[-1].lower(): value for key, value in element.attrib.items()}
        if tag == "agent" and attrs.get("id"):
            agents[attrs["id"]] = attrs.get("type", "").lower()
        elif tag == "p" and attrs.get("agent") and attrs.get("begin"):
            referenced.add(attrs["agent"])

    singers = [agent for agent, kind in agents.items() if kind in {"person", "character"}]
    return any(
        agents.get(agent) not in {None, "person", "character"}
        or agent == "v1000"
        or (agent in singers and singers.index(agent) > 0)
        or (agent not in agents and agent in {"v2", "v3"})
        for agent in referenced
    )


def classify_lyrics_content(content: str, suffix: str) -> str:
    if suffix.lower() == ".ttml":
        return classify_ttml_content(content)
    if suffix.lower() == ".lrc" and re.search(r"(?m)^\s*\[\d{1,3}:\d{2}(?:\.\d+)?\]", content):
        return "line"
    return "none"


def classify_lyrics_file(path: Path) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeError):
        return "none"
    return classify_lyrics_content(content, path.suffix)


def saved_lyrics_files(lyrics_dir: Path) -> list[Path]:
    if not lyrics_dir.is_dir():
        return []
    files = [
        path
        for pattern in ("*.ttml", "*.lrc")
        for path in sorted(lyrics_dir.glob(pattern), key=lambda entry: entry.name.casefold())
        if classify_lyrics_file(path) != "none"
    ]
    return sorted(
        files,
        key=lambda path: (
            0 if classify_lyrics_file(path) == "word" else 1,
            0 if path.suffix.lower() == ".lrc" else 1,
            path.name.casefold(),
        ),
    )


def saved_lyrics_level(lyrics_dir: Path) -> str:
    levels = [classify_lyrics_file(path) for path in saved_lyrics_files(lyrics_dir)]
    if "word" in levels:
        return "word"
    if "line" in levels:
        return "line"
    return "none"


def saved_lyrics_is_duet(lyrics_dir: Path) -> bool:
    if not lyrics_dir.is_dir():
        return False
    files = sorted(
        (
            path
            for path in lyrics_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {".ttml", ".lrc"}
        ),
        key=lambda path: path.name,
    )
    classified = [(path, classify_lyrics_file(path)) for path in files]
    selected = next((path for path, level in classified if level == "word"), None)
    if selected is None:
        selected = next(
            (path for path, level in classified if level == "line" or path.suffix.lower() == ".lrc"),
            None,
        )
    if selected is None or selected.suffix.lower() != ".ttml":
        return False
    try:
        return _ttml_has_duet_agents(selected.read_text(encoding="utf-8", errors="replace"))
    except (OSError, UnicodeError) as exc:
        logger.warning("Could not inspect duet lyrics %s: %s", selected, exc)
        return False


def _ttml_lines_to_lrc(content: str) -> Optional[str]:
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return None

    lines = []
    for paragraph in root.iter():
        if paragraph.tag.rsplit("}", 1)[-1].lower() != "p":
            continue
        begin = next(
            (
                value
                for key, value in paragraph.attrib.items()
                if key.rsplit("}", 1)[-1].lower() == "begin"
            ),
            None,
        )
        seconds = _ttml_time_seconds(begin) if begin else None
        text = re.sub(r"\s+", " ", "".join(paragraph.itertext())).strip()
        if seconds is None or not text:
            continue
        minutes = int(seconds // 60)
        whole_seconds = seconds - minutes * 60
        lines.append(f"[{minutes:02d}:{whole_seconds:05.2f}]{text}")
    return "\n".join(lines) if lines else None


def _score_candidate(
    ttml: Optional[str],
    lrc: Optional[str],
    provider_rank: int,
) -> Optional[tuple[tuple[int, int, int, int], str, str, str]]:
    """Validate real timestamp progression and score a fetched lyrics candidate."""
    if ttml:
        try:
            root = ET.fromstring(ttml)
        except ET.ParseError:
            root = None
        if root is not None:
            real_lines, distinct_lines, span_s, word_spans, multi_word_lines, varied_word_lines = (
                _inspect_ttml_timing(root)
            )
            if (
                real_lines >= MIN_TIMED_LINES
                and distinct_lines >= MIN_TIMED_LINES
                and span_s >= MIN_TIMELINE_SPAN_SECONDS
                and word_spans >= MIN_TIMED_LINES
                and (multi_word_lines == 0 or varied_word_lines >= multi_word_lines * 0.5)
            ):
                duet_bonus = 1 if _ttml_has_duet_agents(ttml) else 0
                return ((3, duet_bonus, -provider_rank, min(word_spans, 2000)), "word", "ttml", ttml)

    line_lyrics = lrc or (_ttml_lines_to_lrc(ttml) if ttml else None)
    if line_lyrics:
        times: list[float] = []
        for m in _LRC_LINE_RE.finditer(line_lyrics):
            txt = m.group(4).strip()
            if not txt or _INSTRUMENTAL_STUB_RE.match(txt):
                continue
            mins = int(m.group(1))
            secs = int(m.group(2))
            frac = int(m.group(3).ljust(3, "0")[:3]) / 1000.0 if m.group(3) else 0.0
            times.append(mins * 60.0 + secs + frac)
        distinct_times = len({round(t * 10) for t in times})
        span_s = (max(times) - min(times)) if len(times) >= 2 else 0.0
        if (
            len(times) >= MIN_TIMED_LINES
            and distinct_times >= MIN_TIMED_LINES
            and span_s >= MIN_TIMELINE_SPAN_SECONDS
        ):
            return ((1, 0, -provider_rank, min(len(times), 1000)), "line", "lrc", line_lyrics)
    return None


def save_lyrics_result(
    lyrics_dir: Path,
    save_filename: str,
    ttml: Optional[str],
    lrc: Optional[str],
) -> Optional[dict[str, Optional[str]]]:
    if ttml and classify_ttml_content(ttml) == "word":
        target = lyrics_dir / f"{save_filename}.ttml"
        target.write_text(ttml, encoding="utf-8")
        for old_lrc in lyrics_dir.glob("*.lrc"):
            old_lrc.unlink(missing_ok=True)
        return {"ttml": ttml, "lrc": None}

    line_lyrics = lrc or (_ttml_lines_to_lrc(ttml) if ttml else None)
    if line_lyrics:
        (lyrics_dir / f"{save_filename}.lrc").write_text(line_lyrics, encoding="utf-8")
        return {"ttml": None, "lrc": line_lyrics}
    return None


def provider_keys(provider: LyricsProvider) -> dict[str, str]:
    return get_lyrics_provider_keys().get(provider.id, {})


def enabled_providers() -> list[LyricsProvider]:
    enabled = get_lyrics_providers()
    result: list[LyricsProvider] = []
    for pid in get_lyrics_provider_order():
        provider = PROVIDERS_BY_ID.get(pid)
        if provider is None or not enabled.get(pid):
            continue
        keys = provider_keys(provider)
        if provider.key_required and not all(
            keys.get(f.id) for f in provider.key_fields if f.id != "storefront"
        ):
            continue
        result.append(provider)
    return result


def _search_tiered(
    raw_artist: str,
    raw_album: str,
    raw_title: str,
    duration_seconds: int,
    *,
    need_word_only: bool = False,
    bypass_miss_cache: bool = False,
) -> Optional[dict[str, str]]:
    query_title = remove_title_annotations(raw_title)
    providers = enabled_providers()
    if need_word_only:
        providers = [p for p in providers if p.word_level]
    if not providers:
        return None

    word_tier = [(idx, p) for idx, p in enumerate(providers) if p.word_level]
    line_tier = [(idx, p) for idx, p in enumerate(providers) if not p.word_level]

    best_score: Optional[tuple[int, int, int, int]] = None
    best_candidate: Optional[dict[str, str]] = None

    def _run_batch(batch: list[tuple[int, LyricsProvider]]) -> None:
        nonlocal best_score, best_candidate
        if not batch:
            return
        with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL_PROVIDERS, len(batch))) as pool:
            futures = {
                pool.submit(
                    run_provider,
                    provider,
                    raw_artist,
                    raw_album,
                    query_title,
                    duration_seconds,
                    provider_keys(provider),
                    bypass_miss_cache=bypass_miss_cache,
                ): (rank, provider)
                for rank, provider in batch
            }
            for future in as_completed(futures):
                rank, provider = futures[future]
                try:
                    payload = future.result()
                except Exception:
                    continue
                if not payload:
                    continue
                scored = _score_candidate(payload.get("ttml"), payload.get("lrc"), rank)
                if scored is None:
                    continue
                score, level, fmt, content = scored
                if best_score is None or score > best_score:
                    best_score = score
                    best_candidate = {
                        "provider": provider.label,
                        "level": level,
                        "format": fmt,
                        "content": content,
                    }

    for start in range(0, len(word_tier), MAX_PARALLEL_PROVIDERS):
        _run_batch(word_tier[start : start + MAX_PARALLEL_PROVIDERS])
        if best_candidate and best_candidate["level"] == "word":
            return best_candidate

    if need_word_only:
        return best_candidate if best_candidate and best_candidate["level"] == "word" else None

    if best_candidate:
        return best_candidate

    for start in range(0, len(line_tier), MAX_PARALLEL_PROVIDERS):
        _run_batch(line_tier[start : start + MAX_PARALLEL_PROVIDERS])
        if best_candidate:
            return best_candidate


def fetch_and_save_lyrics(
    song_dir: Path,
    raw_artist: str,
    raw_album: str,
    raw_title: str,
    save_filename: str,
    duration: Optional[float],
):
    duration_seconds = max(1, round(duration or 1))
    lyrics_dir = song_dir / "lyrics"
    lyrics_dir.mkdir(parents=True, exist_ok=True)
    if lyrics_locked(lyrics_dir):
        existing = saved_lyrics_files(lyrics_dir)
        return ("ttml" if existing[0].suffix.lower() == ".ttml" else "lrc") if existing else False

    existing_files = saved_lyrics_files(lyrics_dir)
    word_ttml = next(
        (
            path
            for path in existing_files
            if path.suffix.lower() == ".ttml" and classify_lyrics_file(path) == "word"
        ),
        None,
    )
    if word_ttml:
        return "ttml"

    has_existing_line = any(classify_lyrics_file(path) == "line" for path in existing_files)
    candidate = _search_tiered(
        raw_artist,
        raw_album,
        raw_title,
        duration_seconds,
        need_word_only=has_existing_line,
    )

    if candidate:
        saved = save_lyrics_result(
            lyrics_dir,
            save_filename,
            candidate["content"] if candidate["format"] == "ttml" else None,
            candidate["content"] if candidate["format"] == "lrc" else None,
        )
        if saved and saved["ttml"]:
            logger.info("[Lyrics] Saved word-level lyrics from %s for: %s", candidate["provider"], raw_title)
            return "ttml"
        if saved and saved["lrc"]:
            logger.info("[Lyrics] Saved line lyrics from %s for: %s", candidate["provider"], raw_title)
            return "lrc"

    if has_existing_line:
        return "lrc"
    logger.info("[Lyrics] No lyrics found for: %s", raw_title)
    return False


def find_lyrics_candidate(
    raw_artist: str, raw_album: str, raw_title: str, duration: Optional[float]
) -> Optional[dict[str, str]]:
    duration_seconds = max(1, round(duration or 1))
    return _search_tiered(
        raw_artist,
        raw_album,
        raw_title,
        duration_seconds,
        bypass_miss_cache=True,
    )