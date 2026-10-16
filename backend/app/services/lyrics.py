import logging
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional
import httpx
from app.services.metadata import remove_title_annotations

logger = logging.getLogger("uvicorn")
MAX_LYRICS_OFFSET_MS = 10_000


def get_lyrics_offset_ms(lyrics_dir: Path) -> int:
    timing_file = lyrics_dir / "timing.json"
    try:
        timing = json.loads(timing_file.read_text(encoding="utf-8"))
        offset_ms = int(timing.get("offset_ms", 0))
    except (OSError, json.JSONDecodeError, AttributeError, TypeError, ValueError):
        return 0
    return max(-MAX_LYRICS_OFFSET_MS, min(MAX_LYRICS_OFFSET_MS, offset_ms))


def save_lyrics_offset_ms(lyrics_dir: Path, offset_ms: int) -> int:
    bounded_offset = max(-MAX_LYRICS_OFFSET_MS, min(MAX_LYRICS_OFFSET_MS, offset_ms))
    lyrics_dir.mkdir(parents=True, exist_ok=True)
    (lyrics_dir / "timing.json").write_text(
        json.dumps({"offset_ms": bounded_offset}, indent=2) + "\n",
        encoding="utf-8",
    )
    return bounded_offset


def classify_ttml_content(content: str) -> str:
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return "none"

    timing = next(
        (
            value.lower()
            for key, value in root.attrib.items()
            if key.rsplit("}", 1)[-1].lower() == "timing"
        ),
        None,
    )
    if timing == "word":
        return "word"
    if timing in {"line", "lines"}:
        return "line"

    timed_spans = any(
        element.tag.rsplit("}", 1)[-1].lower() == "span"
        and any(
            key.rsplit("}", 1)[-1].lower() in {"begin", "end"}
            for key in element.attrib
        )
        for element in root.iter()
    )
    if timed_spans:
        return "word"

    timed_paragraphs = any(
        element.tag.rsplit("}", 1)[-1].lower() == "p"
        and any(
            key.rsplit("}", 1)[-1].lower() in {"begin", "end"}
            for key in element.attrib
        )
        and "".join(element.itertext()).strip()
        for element in root.iter()
    )
    return "line" if timed_paragraphs else "none"


def classify_lyrics_file(path: Path) -> str:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return "none"
    if path.suffix.lower() == ".ttml":
        return classify_ttml_content(content)
    if path.suffix.lower() == ".lrc" and re.search(r"(?m)^\s*\[\d{1,3}:\d{2}(?:\.\d+)?\]", content):
        return "line"
    return "none"


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


def _ttml_time_seconds(value: str) -> Optional[float]:
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


def save_lyrics_result(
    lyrics_dir: Path,
    save_filename: str,
    ttml: Optional[str],
    lrc: Optional[str],
) -> Optional[dict[str, Optional[str]]]:
    if ttml and classify_ttml_content(ttml) == "word":
        (lyrics_dir / f"{save_filename}.ttml").write_text(ttml, encoding="utf-8")
        return {"ttml": ttml, "lrc": None}

    line_lyrics = lrc or (_ttml_lines_to_lrc(ttml) if ttml else None)
    if line_lyrics:
        (lyrics_dir / f"{save_filename}.lrc").write_text(line_lyrics, encoding="utf-8")
        return {"ttml": None, "lrc": line_lyrics}
    return None

def fetch_and_save_lyrics(
    song_dir: Path,
    raw_artist: str,
    raw_album: str,
    raw_title: str,
    save_filename: str,
    duration: Optional[float],
):
    """Fetches TTML/LRC lyrics using raw metadata and saves to lyrics directory."""
    duration_seconds = max(1, round(duration or 1))
    query_title = remove_title_annotations(raw_title)
    lyrics_dir = song_dir / "lyrics"
    lyrics_dir.mkdir(parents=True, exist_ok=True)

    existing_files = saved_lyrics_files(lyrics_dir)
    word_ttml = next(
        (
            path
            for path in existing_files
            if path.suffix.lower() == ".ttml"
            and classify_lyrics_file(path) == "word"
        ),
        None,
    )
    if word_ttml:
        return "ttml"

    existing_line_file = next(
        (path for path in existing_files if classify_lyrics_file(path) == "line"),
        None,
    )

    # Attempt 1: Full Query (Title + Artist + Album + Duration)
    # Attempt 2: Fallback Query without Album constraint
    attempts = [
        {"s": query_title, "a": raw_artist, "d": duration_seconds, "al": raw_album},
        {"s": query_title, "a": raw_artist, "d": duration_seconds},
    ]
    line_lyrics_found = False

    for idx, params in enumerate(attempts, 1):
        try:
            response = httpx.get(
                "https://lyrics-api.boidu.dev/getLyrics",
                params=params,
                timeout=10.0,
            )
            if response.status_code != 200:
                continue

            data = response.json()

            saved_result = save_lyrics_result(
                lyrics_dir,
                save_filename,
                data.get("ttml"),
                data.get("lrc"),
            )
            if saved_result and saved_result["ttml"]:
                print(f"[Lyrics] Successfully saved TTML for: {raw_title}")
                return "ttml"
            if saved_result and saved_result["lrc"]:
                print(f"[Lyrics] Successfully saved LRC for: {raw_title}")
                line_lyrics_found = True

        except Exception as e:
            print(f"[Lyrics] Attempt {idx} error for '{raw_title}': {e}")

    if existing_line_file or line_lyrics_found:
        return "lrc"

    print(f"[Lyrics] No lyrics found on API for: {raw_title}")
    return False