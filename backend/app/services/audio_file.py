from pathlib import Path
from types import SimpleNamespace
from typing import Any

import mutagen
from mutagen.id3 import ID3
from mutagen.mp4 import MP4


_ID3_EASY_KEYS = {
    "album": "TALB",
    "albumartist": "TPE2",
    "artist": "TPE1",
    "bpm": "TBPM",
    "comment": "COMM",
    "composer": "TCOM",
    "date": "TDRC",
    "discnumber": "TPOS",
    "genre": "TCON",
    "title": "TIT2",
    "tracknumber": "TRCK",
}
_MP4_EASY_KEYS = {
    "album": "\xa9alb",
    "albumartist": "aART",
    "artist": "\xa9ART",
    "bpm": "tmpo",
    "comment": "\xa9cmt",
    "composer": "\xa9wrt",
    "date": "\xa9day",
    "discnumber": "disk",
    "genre": "\xa9gen",
    "title": "\xa9nam",
    "tracknumber": "trkn",
}


def _easy_view(audio: Any) -> Any:
    if not audio or not audio.tags:
        return audio
    if isinstance(audio, MP4):
        tags = {}
        for key, atom in _MP4_EASY_KEYS.items():
            values = audio.tags.get(atom)
            if not values:
                continue
            if key in {"tracknumber", "discnumber"}:
                tags[key] = [
                    f"{track}/{total}" if total else str(track)
                    for track, total in values
                ]
            else:
                tags[key] = [str(value) for value in values]
        return SimpleNamespace(info=audio.info, tags=tags)
    if isinstance(audio.tags, ID3):
        tags = {}
        for key, frame_id in _ID3_EASY_KEYS.items():
            values = [
                str(value)
                for frame in audio.tags.getall(frame_id)
                for value in getattr(frame, "text", [])
            ]
            if values:
                tags[key] = values
        return SimpleNamespace(info=audio.info, tags=tags)
    return audio


def read_audio_file(path: Path, *, easy: bool = False) -> Any:
    """Read tags and stream info, retrying by file signature when the extension lies."""
    try:
        audio = mutagen.File(path, easy=easy)
        if audio is not None:
            return audio
    except mutagen.MutagenError:
        pass

    with open(path, "rb") as fileobj:
        audio = mutagen.File(fileobj=fileobj, filename="audio")
    return _easy_view(audio) if easy else audio
