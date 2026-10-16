"""Read/write extended tags for MP3 (ID3) and FLAC (Vorbis) files, preserving other tags."""
import re
from pathlib import Path
from typing import Any, Optional

import mutagen
from mutagen.flac import FLAC, Picture
from mutagen.id3 import (
    APIC,
    COMM,
    ID3,
    ID3NoHeaderError,
    TALB,
    TBPM,
    TCOM,
    TCON,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TPOS,
    TRCK,
    TXXX,
)

AUDIO_SUFFIXES = {".mp3", ".flac"}

EXTENDED_FIELDS = (
    "album_artist",
    "year",
    "genre",
    "track_number",
    "disc_number",
    "comment",
    "composer",
    "bpm",
    "replaygain_track_gain",
    "replaygain_track_peak",
    "replaygain_album_gain",
    "replaygain_album_peak",
)

_SIMPLE_FRAMES = {"artist": TPE1, "album": TALB, "title": TIT2}
_ID3_FRAMES = {
    "album_artist": TPE2,
    "year": TDRC,
    "genre": TCON,
    "track_number": TRCK,
    "disc_number": TPOS,
    "composer": TCOM,
    "bpm": TBPM,
}
_VORBIS_KEYS = {
    "album_artist": "albumartist",
    "year": "date",
    "genre": "genre",
    "track_number": "tracknumber",
    "disc_number": "discnumber",
    "comment": "comment",
    "composer": "composer",
    "bpm": "bpm",
    "replaygain_track_gain": "replaygain_track_gain",
    "replaygain_track_peak": "replaygain_track_peak",
    "replaygain_album_gain": "replaygain_album_gain",
    "replaygain_album_peak": "replaygain_album_peak",
}
_TXXX_DESCS = {
    "replaygain_track_gain": "REPLAYGAIN_TRACK_GAIN",
    "replaygain_track_peak": "REPLAYGAIN_TRACK_PEAK",
    "replaygain_album_gain": "REPLAYGAIN_ALBUM_GAIN",
    "replaygain_album_peak": "REPLAYGAIN_ALBUM_PEAK",
}


def _first_number(value: Any) -> Optional[float]:
    match = re.search(r"-?\d+(?:\.\d+)?", str(value)) if value is not None else None
    return float(match.group()) if match else None


def _normalize(field: str, raw: Any) -> Any:
    if raw is None or str(raw).strip() == "":
        return None
    if field == "year":
        match = re.search(r"\d{4}", str(raw))
        return int(match.group()) if match else None
    if field in {"track_number", "disc_number"}:
        number = _first_number(raw)
        return int(number) if number is not None else None
    if field == "bpm":
        number = _first_number(raw)
        if number is None:
            return None
        return int(number) if number == int(number) else round(number, 2)
    if field.startswith("replaygain_"):
        return _first_number(raw)
    return str(raw).strip()


def read_tags(path: Path) -> dict[str, Any]:
    """Return the extended tag fields (None when absent) for a single audio file."""
    result: dict[str, Any] = {field: None for field in EXTENDED_FIELDS}
    try:
        if path.suffix.lower() == ".flac":
            audio = FLAC(path)
            for field, key in _VORBIS_KEYS.items():
                values = audio.get(key)
                if values:
                    result[field] = _normalize(field, values[0])
        else:
            tags = ID3(path)
            for field, frame_cls in _ID3_FRAMES.items():
                frame = tags.get(frame_cls.__name__)
                if frame is not None and frame.text:
                    result[field] = _normalize(field, str(frame.text[0]))
            comments = tags.getall("COMM")
            if comments and comments[0].text:
                result["comment"] = _normalize("comment", comments[0].text[0])
            for field, desc in _TXXX_DESCS.items():
                for frame in tags.getall("TXXX"):
                    if frame.desc.upper() == desc and frame.text:
                        result[field] = _normalize(field, frame.text[0])
                        break
    except Exception:
        pass
    return result


def read_display_names(path: Path) -> dict[str, Optional[str]]:
    """Return the real title/artist/album tags (not the sanitized folder names)."""
    names: dict[str, Optional[str]] = {"title": None, "artist": None, "album": None}
    try:
        audio = mutagen.File(path, easy=True)
        tags = audio.tags if audio else None
        if tags:
            for key in names:
                values = tags.get(key)
                if values and str(values[0]).strip():
                    names[key] = str(values[0]).strip()
    except Exception:
        pass
    return names


def read_duration(path: Path) -> Optional[float]:
    try:
        audio = mutagen.File(path)
        return float(audio.info.length) if audio and audio.info else None
    except Exception:
        return None


def format_field(field: str, value: Any) -> str:
    if field in {"replaygain_track_gain", "replaygain_album_gain"}:
        return f"{float(value):.2f} dB"
    if field.endswith("_peak"):
        return f"{float(value):.6f}"
    if field == "bpm":
        number = float(value)
        return str(int(number)) if number == int(number) else str(number)
    return str(value)


def write_tags(path: Path, updates: dict[str, Any]) -> None:
    """Apply updates. Keys: artist/album/title plus EXTENDED_FIELDS; None removes the tag."""
    if not updates:
        return
    if path.suffix.lower() == ".flac":
        _write_flac(path, updates)
    else:
        _write_id3(path, updates)


def _write_id3(path: Path, updates: dict[str, Any]) -> None:
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        tags = ID3()
    for field, value in updates.items():
        if field in _SIMPLE_FRAMES:
            if value is not None:
                frame_cls = _SIMPLE_FRAMES[field]
                tags.setall(frame_cls.__name__, [frame_cls(encoding=3, text=[str(value)])])
        elif field in _ID3_FRAMES:
            frame_cls = _ID3_FRAMES[field]
            tags.delall(frame_cls.__name__)
            if value is not None:
                tags.add(frame_cls(encoding=3, text=[format_field(field, value)]))
        elif field == "comment":
            tags.delall("COMM")
            if value is not None:
                tags.add(COMM(encoding=3, lang="eng", desc="", text=[str(value)]))
        elif field in _TXXX_DESCS:
            desc = _TXXX_DESCS[field]
            for frame in list(tags.getall("TXXX")):
                if frame.desc.upper() == desc:
                    tags.delall(frame.HashKey)
            if value is not None:
                tags.add(TXXX(encoding=3, desc=desc, text=[format_field(field, value)]))
    tags.save(path)


def _write_flac(path: Path, updates: dict[str, Any]) -> None:
    audio = FLAC(path)
    for field, value in updates.items():
        key = field if field in _SIMPLE_FRAMES else _VORBIS_KEYS.get(field)
        if key is None:
            continue
        if value is None:
            if key in audio:
                del audio[key]
        else:
            audio[key] = [format_field(field, value)]
    audio.save()


def get_basic_tag(path: Path, key: str) -> Optional[str]:
    try:
        if path.suffix.lower() == ".flac":
            values = FLAC(path).get(key)
            return str(values[0]) if values else None
        frame = ID3(path).get(_SIMPLE_FRAMES[key].__name__)
        return str(frame.text[0]) if frame is not None and frame.text else None
    except Exception:
        return None


def detect_mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def embed_cover(path: Path, image_data: bytes) -> None:
    """Replace any embedded pictures with the given image."""
    mime = detect_mime(image_data)
    if path.suffix.lower() == ".flac":
        audio = FLAC(path)
        audio.clear_pictures()
        picture = Picture()
        picture.type = 3
        picture.mime = mime
        picture.desc = "Cover"
        picture.data = image_data
        audio.add_picture(picture)
        audio.save()
        return
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        tags = ID3()
    tags.delall("APIC")
    tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=image_data))
    tags.save(path)


def remove_cover(path: Path) -> None:
    if path.suffix.lower() == ".flac":
        audio = FLAC(path)
        audio.clear_pictures()
        audio.save()
        return
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        return
    tags.delall("APIC")
    tags.save(path)


def audio_files(song_dir: Path) -> list[Path]:
    return sorted(
        file
        for file in song_dir.rglob("*")
        if file.is_file() and file.suffix.lower() in AUDIO_SUFFIXES
    )
