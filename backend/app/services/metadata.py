import re
import subprocess
from pathlib import Path
import mutagen
from mutagen.easyid3 import EasyID3
from mutagen.id3 import APIC, ID3


def sanitize_filename(name: str) -> str:
    """Replaces illegal OS path characters (< > : " / \\ | ? *) with safe alternatives."""
    if not name:
        return "Unknown"
    # Replace forbidden OS characters with an underscore
    sanitized = re.sub(r'[\\/*?:"<>|]', "_", str(name))
    # Strip leading/trailing spaces and periods (Windows restriction)
    return sanitized.strip(". ")


def extract_raw_metadata(input_file: Path):
    """Read display/API metadata before a file enters the processing queue."""
    audio_info = mutagen.File(input_file)
    if audio_info is None:
        raise ValueError("The uploaded file is not a supported audio file.")
    raw_artist = "Unknown Artist"
    raw_album = "Unknown Album"
    raw_title = input_file.stem

    if audio_info and audio_info.tags:
        tags = audio_info.tags

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
    raw_artist, raw_album, raw_title = (
        "Unknown Artist",
        "Unknown Album",
        input_file.stem,
    )

    if audio_info and audio_info.tags:
        tags = audio_info.tags
        raw_artist = (
            tags.get("artist", [raw_artist])[0]
            if isinstance(tags.get("artist"), list)
            else tags.get("ARTIST", raw_artist)
        )
        raw_album = (
            tags.get("album", [raw_album])[0]
            if isinstance(tags.get("album"), list)
            else tags.get("ALBUM", raw_album)
        )
        raw_title = (
            tags.get("title", [raw_title])[0]
            if isinstance(tags.get("title"), list)
            else tags.get("TITLE", raw_title)
        )

    artist = sanitize_filename(raw_artist)
    album = sanitize_filename(raw_album)
    title = sanitize_filename(raw_title)

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
):
    """Converts a WAV stem to 320k MP3 via FFmpeg and applies metadata."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(wav_path),
        "-b:a",
        "320k",
        "-map_metadata",
        "-1",
        str(output_mp3_path),
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        tags = EasyID3(output_mp3_path)
    except Exception:
        tags = mutagen.File(output_mp3_path, easy=True)
        tags.add_tags()

    tags["artist"] = artist
    tags["album"] = album
    tags["title"] = title
    tags.save()

    if wav_path.exists():
        wav_path.unlink()


def create_compressed_original_with_cover(
    input_file: Path,
    output_mp3_path: Path,
    cover_path: Path,
    artist: str,
    album: str,
    title: str,
):
    """Creates a 320k MP3 copy of the original input file with tags and embedded album art."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_file),
        "-b:a",
        "320k",
        "-map_metadata",
        "-1",
        str(output_mp3_path),
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        tags = EasyID3(output_mp3_path)
    except Exception:
        tags = mutagen.File(output_mp3_path, easy=True)
        tags.add_tags()

    tags["artist"], tags["album"], tags["title"] = artist, album, title
    tags.save()

    if cover_path.exists():
        audio = ID3(output_mp3_path)
        with open(cover_path, "rb") as img:
            audio.add(
                APIC(
                    encoding=3,
                    mime="image/jpeg",
                    type=3,
                    desc="Cover",
                    data=img.read(),
                )
            )
        audio.save()