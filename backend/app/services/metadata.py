import copy
import logging
import re
from pathlib import Path
import mutagen
from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TXXX

from app.services.paths import run_ffmpeg
from app.services.settings import get_output_quality
from app.services.tagging import embed_cover


_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
MAX_NAME_LENGTH = 120
logger = logging.getLogger(__name__)


def sanitize_filename(name: str) -> str:
    """Makes a name safe as a single path component on Windows, macOS and Linux."""
    if not name:
        return "Unknown"
    # Illegal characters and control characters become underscores
    sanitized = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "_", str(name))
    # Windows disallows trailing spaces/periods; strip leading ones too
    sanitized = sanitized.strip(". ")
    if len(sanitized) > MAX_NAME_LENGTH:
        sanitized = sanitized[:MAX_NAME_LENGTH].rstrip(". ")
    # Reserved device names (CON, NUL, COM1...) are invalid even with an extension
    if sanitized.split(".")[0].strip().upper() in _WINDOWS_RESERVED:
        sanitized = f"_{sanitized}"
    return sanitized


def extract_raw_metadata(input_file: Path):
    """Read display/API metadata before a file enters the processing queue."""
    audio_info = mutagen.File(input_file)
    if audio_info is None:
        raise ValueError("The uploaded file is not a supported audio file.")
    raw_artist = "Unknown Artist"
    raw_album = "Unknown Album"
    raw_title = input_file.stem

    easy_audio = mutagen.File(input_file, easy=True)
    if easy_audio and easy_audio.tags:
        tags = easy_audio.tags

        def get_tag(name: str, fallback: str) -> str:
            value = tags.get(name) or tags.get(name.upper())
            if isinstance(value, list):
                value = value[0] if value else fallback
            return str(value).strip() if value else fallback

        raw_artist = get_tag("artist", raw_artist)
        raw_album = get_tag("album", raw_album)
        raw_title = get_tag("title", raw_title)

    return {
        "raw_artist": raw_artist,
        "raw_album": raw_album,
        "raw_title": raw_title,
        "artist": sanitize_filename(raw_artist),
        "album": sanitize_filename(raw_album),
        "title": sanitize_filename(raw_title),
    }


def remove_title_annotations(title: str) -> str:
    """Removes matched parentheses and brackets from title string for cleaner queries."""
    opening_to_closing = {"(": ")", "[": "]"}
    closing_characters = set(opening_to_closing.values())
    open_groups = []
    removable_ranges = []

    for index, character in enumerate(title):
        if character in opening_to_closing:
            open_groups.append((character, index))
        elif character in closing_characters and open_groups:
            opening, opening_index = open_groups[-1]
            if opening_to_closing[opening] == character:
                open_groups.pop()
                removable_ranges.append((opening_index, index))

    removable_indexes = {
        idx for start, end in removable_ranges for idx in range(start, end + 1)
    }
    cleaned = "".join(
        char for idx, char in enumerate(title) if idx not in removable_indexes
    )
    return re.sub(r"\s+", " ", cleaned).strip()


def extract_metadata_and_setup_dirs(input_file: Path, song_dir: Path):
    """Parses metadata, sanitizes path names, creates folder tree, and extracts cover art."""
    audio_info = mutagen.File(input_file)
    metadata = extract_raw_metadata(input_file)
    raw_artist, raw_album, raw_title = metadata["raw_artist"], metadata["raw_album"], metadata["raw_title"]
    artist, album, title = metadata["artist"], metadata["album"], metadata["title"]

    covers_dir, lyrics_dir, stems_dir = (
        song_dir / "covers",
        song_dir / "lyrics",
        song_dir / "stems",
    )
    for d in [covers_dir, lyrics_dir, stems_dir]:
        d.mkdir(parents=True, exist_ok=True)

    cover_path = covers_dir / "cover.jpg"
    if not cover_path.exists() and audio_info and audio_info.tags:
        # 1. FLAC / OGG (native pictures attribute)
        if hasattr(audio_info, "pictures") and audio_info.pictures:
            with open(cover_path, "wb") as f:
                f.write(audio_info.pictures[0].data)
        # 2. MP3 ID3 Tags
        elif hasattr(audio_info.tags, "getall"):
            apic_frames = audio_info.tags.getall("APIC")
            if apic_frames:
                with open(cover_path, "wb") as f:
                    f.write(apic_frames[0].data)
        # 3. M4A / MP4 Containers
        elif "covr" in audio_info.tags and audio_info.tags["covr"]:
            with open(cover_path, "wb") as f:
                f.write(bytes(audio_info.tags["covr"][0]))

    return raw_artist, raw_album, raw_title, artist, album, title, stems_dir, cover_path


def convert_and_tag_stem(
    wav_path: Path,
    output_mp3_path: Path,
    artist: str,
    album: str,
    title: str,
    metadata_source: Path,
    cover_path: Path,
):
    """Converts a WAV stem to MP3, preserving source metadata and cover art."""
    cmd = [
        "-v",
        "error",
        "-y",
        "-i",
        str(wav_path),
        "-i",
        str(metadata_source),
        "-map",
        "0:a:0",
        "-map_metadata",
        "1",
        "-map_chapters",
        "1",
        *_encoding_args(output_mp3_path),
        str(output_mp3_path),
    ]
    run_ffmpeg(cmd)
    _preserve_compatible_metadata(metadata_source, output_mp3_path)
    _set_basic_tags(output_mp3_path, artist, album, title, stem=True)

    _embed_cover_art(output_mp3_path, cover_path)

    if wav_path.exists():
        wav_path.unlink()


def _encoding_args(output_path: Path) -> list[str]:
    """ffmpeg codec arguments for the output file type and configured quality."""
    if output_path.suffix.lower() == ".flac":
        return ["-vn", "-c:a", "flac", "-sample_fmt", "s16", "-ar", "44100"]
    return ["-b:a", "128k" if get_output_quality() == "low" else "320k"]


def _set_basic_tags(path: Path, artist: str, album: str, title: str, *, stem: bool = False) -> None:
    if path.suffix.lower() == ".flac":
        flac = FLAC(path)
        for key, value in (("artist", artist), ("album", album), ("title", title)):
            if not flac.get(key) or (key == "title" and stem):
                flac[key] = [value]
        flac.save()
        return
    try:
        tags = EasyID3(path)
    except mutagen.MutagenError:
        tags = mutagen.File(path, easy=True)
        if tags is None:
            raise ValueError(f"Could not read converted audio file: {path}")
        tags.add_tags()
    for key, value in (("artist", artist), ("album", album), ("title", title)):
        if not tags.get(key) or (key == "title" and stem):
            tags[key] = value
    tags.save()


def _embed_cover_art(output_mp3_path: Path, cover_path: Path) -> None:
    if not cover_path.exists():
        return

    if output_mp3_path.suffix.lower() == ".flac":
        flac = FLAC(output_mp3_path)
        if not flac.pictures:
            embed_cover(output_mp3_path, cover_path.read_bytes())
        return

    audio = ID3(output_mp3_path)
    if any(isinstance(frame, APIC) for frame in audio.values()):
        return

    image_data = cover_path.read_bytes()
    mime = "image/jpeg"
    if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif image_data.startswith((b"GIF87a", b"GIF89a")):
        mime = "image/gif"
    elif image_data.startswith(b"RIFF") and image_data[8:12] == b"WEBP":
        mime = "image/webp"

    audio.add(
        APIC(
            encoding=3,
            mime=mime,
            type=3,
            desc="Cover",
            data=image_data,
        )
    )
    audio.save()


def _preserve_compatible_metadata(metadata_source: Path, output_mp3_path: Path) -> None:
    source = mutagen.File(metadata_source)
    if source is None:
        return
    if isinstance(source, FLAC) and output_mp3_path.suffix.lower() == ".flac":
        output = FLAC(output_mp3_path)
        if source.tags:
            for key, values in source.tags.items():
                output[key] = list(values)
        output.clear_pictures()
        for picture in source.pictures:
            output.add_picture(copy.deepcopy(picture))
        output.save()
    elif isinstance(source.tags, ID3) and output_mp3_path.suffix.lower() == ".mp3":
        output_tags = ID3(output_mp3_path)
        for frame in source.tags.values():
            output_tags.add(copy.deepcopy(frame))
        output_tags.save()
    elif isinstance(source, FLAC) and output_mp3_path.suffix.lower() == ".mp3":
        easy = EasyID3(output_mp3_path)
        custom = []
        if source.tags:
            for key, values in source.tags.items():
                try:
                    easy[key] = values
                except mutagen.easyid3.EasyID3KeyError:
                    custom.append((key, values))
        easy.save()
        tags = ID3(output_mp3_path)
        for key, values in custom:
            tags.add(TXXX(encoding=3, desc=key, text=values))
        for picture in source.pictures:
            tags.add(APIC(encoding=3, mime=picture.mime, type=picture.type,
                          desc=picture.desc, data=picture.data))
        tags.save()
    elif isinstance(source.tags, ID3) and output_mp3_path.suffix.lower() == ".flac":
        output = FLAC(output_mp3_path)
        easy_source = mutagen.File(metadata_source, easy=True)
        if easy_source and easy_source.tags:
            for key, values in easy_source.tags.items():
                output[key] = list(values)
        for frame in source.tags.getall("TXXX"):
            if re.fullmatch(r"[ -<>-~]+", frame.desc):
                output[frame.desc] = list(frame.text)
        output.clear_pictures()
        for frame in source.tags.getall("APIC"):
            picture = Picture()
            picture.type = frame.type
            picture.mime = frame.mime
            picture.desc = frame.desc
            picture.data = frame.data
            output.add_picture(picture)
        output.save()
    else:
        easy_source = mutagen.File(metadata_source, easy=True)
        if easy_source and easy_source.tags:
            if output_mp3_path.suffix.lower() == ".flac":
                output = FLAC(output_mp3_path)
                for key, values in easy_source.tags.items():
                    if re.fullmatch(r"[ -<>-~]+", key):
                        output[key] = list(values)
                    else:
                        logger.warning("Cannot preserve tag %r as a FLAC field in %s", key, output_mp3_path)
                output.save()
            elif output_mp3_path.suffix.lower() == ".mp3":
                easy = EasyID3(output_mp3_path)
                for key, values in easy_source.tags.items():
                    try:
                        easy[key] = list(values)
                    except mutagen.easyid3.EasyID3KeyError:
                        logger.debug("Tag %r is not a standard ID3 field; retaining FFmpeg's mapping", key)
                        continue
                easy.save()


def create_compressed_original_with_cover(
    input_file: Path,
    output_mp3_path: Path,
    cover_path: Path,
    artist: str,
    album: str,
    title: str,
):
    """Create a compressed master with compatible source metadata and cover art."""
    cmd = [
        "-v",
        "error",
        "-y",
        "-i",
        str(input_file),
        "-map",
        "0:a:0",
        *_encoding_args(output_mp3_path),
        "-map_metadata",
        "0",
        "-map_chapters",
        "0",
        str(output_mp3_path),
    ]
    run_ffmpeg(cmd)
    _preserve_compatible_metadata(input_file, output_mp3_path)
    _set_basic_tags(output_mp3_path, artist, album, title)

    _embed_cover_art(output_mp3_path, cover_path)