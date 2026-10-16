import asyncio
import io
import json
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services import library, playlists
from app.services.lyrics import (
    LOCK_FILE,
    classify_lyrics_file,
    convert_subtitles_to_lrc,
    max_offset_ms_for_duration,
    save_lyrics_offset_ms,
    saved_lyrics_level,
)
from app.services.metadata import extract_raw_metadata, sanitize_filename
from app.services.queue_manager import QueueItem, QueuePriority, queue_manager
from app.services.settings import find_song_directory
from app.services.tagging import (
    EXTENDED_FIELDS,
    audio_files,
    embed_cover,
    get_basic_tag,
    read_duration,
    remove_cover,
    write_tags,
)

router = APIRouter(prefix="/api/queue", tags=["Queue"])
songs_router = APIRouter(prefix="/api", tags=["Songs"])
search_router = APIRouter(prefix="/api", tags=["Search"])
UPLOADS_DIR = Path("uploads")
UPLOADS_DIR.mkdir(exist_ok=True)

UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_LYRICS_BYTES = 5 * 1024 * 1024
HEARTBEAT_SECONDS = 15.0
STREAM_POLL_SECONDS = 0.5
REFERENCE_LUFS = -18.0


class QueueReorderRequest(BaseModel):
    karaoke_queue: list[str]


class ProcessedSongRequest(BaseModel):
    artist: str
    album: str
    title: str
    play_next: bool = False
    after_task_id: str | None = None


class SongMetadataRequest(BaseModel):
    artist: Optional[str] = None
    album: Optional[str] = None
    title: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[int] = Field(default=None, ge=0, le=9999)
    genre: Optional[str] = None
    track_number: Optional[int] = Field(default=None, ge=0)
    disc_number: Optional[int] = Field(default=None, ge=0)
    comment: Optional[str] = None
    composer: Optional[str] = None
    bpm: Optional[float] = Field(default=None, ge=0)
    replaygain_track_gain: Optional[float] = None
    replaygain_track_peak: Optional[float] = Field(default=None, ge=0)
    replaygain_album_gain: Optional[float] = None
    replaygain_album_peak: Optional[float] = Field(default=None, ge=0)


class LyricsTimingRequest(BaseModel):
    offset_ms: int


@router.post("/add", status_code=202)
async def add_to_queue(
    file: UploadFile = File(...),
    priority: int = Form(QueuePriority.PROCESSING_ONLY.value),
) -> Dict[str, Any]:
    if priority not in (QueuePriority.KARAOKE.value, QueuePriority.PROCESSING_ONLY.value):
        raise HTTPException(status_code=400, detail="priority must be 1 or 2")

    task_id = str(uuid.uuid4())
    safe_name = Path(file.filename or "track.audio").name
    input_path = UPLOADS_DIR / f"{task_id}_{safe_name}"

    try:
        with input_path.open("wb") as buffer:
            while chunk := await file.read(UPLOAD_CHUNK_BYTES):
                await asyncio.to_thread(buffer.write, chunk)
        metadata = await asyncio.to_thread(extract_raw_metadata, input_path)
    except Exception as exc:
        input_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Could not read audio metadata: {exc}") from exc

    item = QueueItem(
        task_id=task_id,
        file_path=str(input_path.resolve()),
        priority=QueuePriority(priority),
        status="pending",
        **metadata,
    )
    await queue_manager.add_item(item)
    return {"message": "Added to queue", "item": item.model_dump()}


@router.post("/add-processed", status_code=202)
async def add_processed_to_queue(song: ProcessedSongRequest) -> Dict[str, Any]:
    location = find_song_directory(song.artist, song.album, song.title)
    if location is None:
        raise HTTPException(status_code=404, detail="Processed song not found")
    song_dir, _, _ = location

    reference = await asyncio.to_thread(library.reference_audio, song_dir)
    if reference is None:
        raise HTTPException(status_code=409, detail="Processed song has no playable audio file")

    task_id = str(uuid.uuid4())
    item = QueueItem(
        task_id=task_id,
        file_path=str(reference.resolve()),
        raw_title=song.title,
        raw_artist=song.artist,
        raw_album=song.album,
        title=song.title,
        artist=song.artist,
        album=song.album,
        priority=QueuePriority.KARAOKE,
        status="completed",
        progress=100,
        step="Already processed.",
        output_dir=str(song_dir.resolve()),
        source_type="processed",
    )
    item = await queue_manager.add_karaoke_item(
        item,
        at_front=song.play_next,
        after_task_id=song.after_task_id,
    )
    return {"message": "Processed song added to Karaoke Queue", "item": item.model_dump()}


async def build_queue_snapshot(base_url: str) -> Dict[str, Any]:
    snapshot = await queue_manager.get_queue_snapshot()
    base = base_url.rstrip("/")

    def attach_assets(item: Dict[str, Any] | None) -> None:
        if item is None:
            return
        level, offset, cover = library.queue_assets(
            item["artist"], item["album"], item["title"], item.get("output_dir")
        )
        item["lyrics_level"] = level
        item["lyrics_offset_ms"] = offset
        item["cover_url"] = base + cover if cover else None

    for item in snapshot["karaoke_queue"] + snapshot["processing_queue"]:
        attach_assets(item)
    attach_assets(snapshot["current_task"])
    return snapshot


@router.get("")
async def get_queue(request: Request) -> Dict[str, Any]:
    return await build_queue_snapshot(str(request.base_url))


@router.get("/stream")
async def stream_queue(request: Request) -> StreamingResponse:
    base_url = str(request.base_url)

    async def events():
        changed = queue_manager.subscribe()
        last_payload: Optional[str] = None
        last_sent = time.monotonic()
        try:
            while not await request.is_disconnected():
                changed.clear()
                payload = json.dumps(await build_queue_snapshot(base_url))
                now = time.monotonic()
                if payload != last_payload:
                    last_payload = payload
                    last_sent = now
                    yield f"data: {payload}\n\n"
                elif now - last_sent >= HEARTBEAT_SECONDS:
                    last_sent = now
                    yield ": heartbeat\n\n"
                try:
                    await asyncio.wait_for(changed.wait(), STREAM_POLL_SECONDS)
                except asyncio.TimeoutError:
                    pass
        finally:
            queue_manager.unsubscribe(changed)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/promote/{task_id}")
async def promote_task(task_id: str) -> Dict[str, Any]:
    try:
        item = await queue_manager.promote_to_karaoke(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"message": "Task promoted", "item": item.model_dump()}


@router.patch("/reorder")
async def reorder_queue(request: QueueReorderRequest) -> Dict[str, str]:
    try:
        await queue_manager.reorder_karaoke(request.karaoke_queue)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"message": "Queue reordered"}


@router.delete("/karaoke/{task_id}")
async def remove_karaoke_item(task_id: str) -> Dict[str, str]:
    await queue_manager.remove_karaoke_item(task_id)
    return {"message": "Item removed from Karaoke Queue"}


@router.post("/pause/{task_id}")
async def pause_task(task_id: str) -> Dict[str, Any]:
    try:
        item = await queue_manager.pause_item(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"message": "Task paused", "item": item.model_dump()}


@router.post("/resume/{task_id}")
async def resume_task(task_id: str) -> Dict[str, Any]:
    try:
        item = await queue_manager.resume_item(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"message": "Task resumed", "item": item.model_dump()}


@router.post("/pause-all")
async def pause_all_tasks() -> Dict[str, str]:
    await queue_manager.pause_all()
    return {"message": "Processing queue paused"}


@router.post("/resume-all")
async def resume_all_tasks() -> Dict[str, str]:
    await queue_manager.resume_all()
    return {"message": "Processing queue resumed"}


@router.delete("/clear/{queue_name}")
async def clear_queue_section(queue_name: str) -> Dict[str, str]:
    priorities = {
        "karaoke": QueuePriority.KARAOKE,
        "processing": None,
    }
    if queue_name not in priorities:
        raise HTTPException(status_code=400, detail="queue_name must be karaoke or processing")
    await queue_manager.clear(priorities[queue_name])
    return {"message": f"{queue_name} queue cleared"}


@router.delete("/{task_id}")
async def remove_task(task_id: str) -> Dict[str, Any]:
    try:
        item = await queue_manager.remove_item(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    message = "Cancellation requested" if item.status == "processing" else "Task removed"
    return {"message": message, "item": item.model_dump()}


def _locate(artist: str, album: str, title: str) -> tuple[Path, Path, int]:
    location = find_song_directory(artist, album, title)
    if location is None:
        raise HTTPException(status_code=404, detail="Song not found")
    return location


@songs_router.get("/songs")
async def list_songs(request: Request) -> list[Dict[str, Any]]:
    return await asyncio.to_thread(library.list_songs, str(request.base_url))


@songs_router.get("/songs/{artist}/{album}/{title}")
async def get_song_manifest(
    request: Request,
    artist: str,
    album: str,
    title: str,
) -> Dict[str, Any]:
    record = await asyncio.to_thread(
        library.get_song, artist, album, title, str(request.base_url)
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Song not found")
    return record


@search_router.get("/search")
async def search(
    request: Request,
    q: str = "",
    limit: int = Query(20, ge=1, le=200),
) -> Dict[str, Any]:
    base_url = str(request.base_url)
    result = await asyncio.to_thread(library.search_library, q, limit, base_url)
    needle = library.normalize_text(q)
    matches = []
    if needle:
        for playlist in await asyncio.to_thread(playlists.list_playlists):
            name = library.normalize_text(playlist["name"])
            if needle in name:
                matches.append((0 if name.startswith(needle) else 1, name, playlist))
    matches.sort(key=lambda m: (m[0], m[1]))
    result["playlists"] = []
    for _, _, playlist in matches[:limit]:
        rendered = playlists.render(playlist, base_url)
        result["playlists"].append(
            {
                "id": rendered["id"],
                "name": rendered["name"],
                "cover_urls": rendered["cover_urls"],
                "song_count": rendered["song_count"],
            }
        )
    return result


def _apply_metadata(
    old: tuple[str, str, str],
    old_song_dir: Path,
    root: Path,
    new: tuple[str, str, str],
    extended: Dict[str, Any],
) -> Path:
    new_song_dir = (root / new[0] / new[1] / new[2]).resolve()
    if not new_song_dir.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Invalid song metadata path")
    if new_song_dir != old_song_dir and new_song_dir.exists():
        raise HTTPException(status_code=409, detail="A song with that metadata already exists")

    if new_song_dir != old_song_dir:
        new_song_dir.parent.mkdir(parents=True, exist_ok=True)
        old_song_dir.rename(new_song_dir)
    for audio_file in audio_files(new_song_dir):
        updates: Dict[str, Any] = dict(extended)
        updates["artist"], updates["album"] = new[0], new[1]
        existing_title = get_basic_tag(audio_file, "title")
        if existing_title and existing_title.startswith(old[2]):
            updates["title"] = new[2] + existing_title[len(old[2]):]
        else:
            updates["title"] = new[2]
        try:
            write_tags(audio_file, updates)
        except Exception:
            continue
    return new_song_dir


@songs_router.patch("/songs/{artist}/{album}/{title}/metadata")
async def update_song_metadata(
    request: Request,
    artist: str,
    album: str,
    title: str,
    metadata: SongMetadataRequest,
) -> Dict[str, Any]:
    old_song_dir, root, _ = _locate(artist, album, title)
    new_artist = sanitize_filename(metadata.artist) if metadata.artist is not None else artist
    new_album = sanitize_filename(metadata.album) if metadata.album is not None else album
    new_title = sanitize_filename(metadata.title) if metadata.title is not None else title
    if not all((new_artist, new_album, new_title)):
        raise HTTPException(status_code=400, detail="Artist, album, and title are required")

    extended: Dict[str, Any] = {}
    for field in EXTENDED_FIELDS:
        if field not in metadata.model_fields_set:
            continue
        value = getattr(metadata, field)
        if isinstance(value, str):
            value = value.strip() or None
        extended[field] = value

    try:
        new_song_dir = await asyncio.to_thread(
            _apply_metadata,
            (artist, album, title),
            old_song_dir,
            root,
            (new_artist, new_album, new_title),
            extended,
        )
        await queue_manager.update_processed_song_metadata(
            artist,
            album,
            title,
            new_artist,
            new_album,
            new_title,
            old_song_dir,
            new_song_dir,
        )
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Could not update song metadata: {exc}") from exc

    if (new_artist, new_album, new_title) != (artist, album, title):
        await asyncio.to_thread(
            playlists.rename_song, (artist, album, title), (new_artist, new_album, new_title)
        )
    library.invalidate(old_song_dir)
    library.invalidate(new_song_dir)
    record = await asyncio.to_thread(
        library.get_song, new_artist, new_album, new_title, str(request.base_url)
    )
    return record or {"artist": new_artist, "album": new_album, "title": new_title}


@songs_router.put("/songs/{artist}/{album}/{title}/lyrics-timing")
async def update_lyrics_timing(
    artist: str,
    album: str,
    title: str,
    timing: LyricsTimingRequest,
) -> Dict[str, int]:
    song_dir, _, _ = _locate(artist, album, title)
    reference = await asyncio.to_thread(library.reference_audio, song_dir)
    duration = await asyncio.to_thread(read_duration, reference) if reference else None
    limit = max_offset_ms_for_duration(duration)
    if abs(timing.offset_ms) > limit:
        raise HTTPException(
            status_code=422,
            detail=f"offset_ms must be between -{limit} and {limit} (half the song duration)",
        )
    offset_ms = save_lyrics_offset_ms(song_dir / "lyrics", timing.offset_ms)
    library.invalidate(song_dir)
    return {"offset_ms": offset_ms}


def _image_to_cover_bytes(data: bytes) -> bytes:
    from PIL import Image, UnidentifiedImageError

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=422, detail="Uploaded file is not a valid image") from exc
    if image.format == "JPEG":
        return data
    out = io.BytesIO()
    image.convert("RGB").save(out, format="JPEG", quality=92)
    return out.getvalue()


def _set_cover(song_dir: Path, data: bytes) -> None:
    covers_dir = song_dir / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)
    for old in covers_dir.iterdir():
        if old.is_file():
            old.unlink()
    (covers_dir / "cover.jpg").write_bytes(data)
    for audio_file in audio_files(song_dir):
        try:
            embed_cover(audio_file, data)
        except Exception:
            continue


def _clear_cover(song_dir: Path) -> None:
    covers_dir = song_dir / "covers"
    if covers_dir.is_dir():
        for old in covers_dir.iterdir():
            if old.is_file():
                old.unlink()
    for audio_file in audio_files(song_dir):
        try:
            remove_cover(audio_file)
        except Exception:
            continue


@songs_router.put("/songs/{artist}/{album}/{title}/cover")
async def upload_song_cover(
    request: Request, artist: str, album: str, title: str, file: UploadFile = File(...)
) -> Dict[str, Any]:
    song_dir, _, _ = _locate(artist, album, title)
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")
    cover = await asyncio.to_thread(_image_to_cover_bytes, data)
    await asyncio.to_thread(_set_cover, song_dir, cover)
    library.invalidate(song_dir)
    record = await asyncio.to_thread(library.get_song, artist, album, title, str(request.base_url))
    return {"cover_url": record["cover_url"] if record else None}


@songs_router.delete("/songs/{artist}/{album}/{title}/cover")
async def delete_song_cover(artist: str, album: str, title: str) -> Dict[str, Any]:
    song_dir, _, _ = _locate(artist, album, title)
    await asyncio.to_thread(_clear_cover, song_dir)
    library.invalidate(song_dir)
    return {"cover_url": None}


def _clear_lyrics_files(lyrics_dir: Path, keep: Path | None = None) -> None:
    for pattern in ("*.ttml", "*.lrc"):
        for file in lyrics_dir.glob(pattern):
            if file != keep:
                file.unlink()


@songs_router.post("/songs/{artist}/{album}/{title}/lyrics")
async def upload_song_lyrics(
    artist: str, album: str, title: str, file: UploadFile = File(...)
) -> Dict[str, Any]:
    song_dir, _, _ = _locate(artist, album, title)
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".lrc", ".ttml", ".srt", ".vtt"}:
        raise HTTPException(
            status_code=415, detail="Lyrics must be a .lrc, .ttml, .srt or .vtt file"
        )
    raw = await file.read(MAX_LYRICS_BYTES + 1)
    if len(raw) > MAX_LYRICS_BYTES:
        raise HTTPException(status_code=413, detail="Lyrics file too large")
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="Lyrics file must be UTF-8 text") from exc

    if suffix in {".srt", ".vtt"}:
        content = convert_subtitles_to_lrc(content) or ""
        suffix = ".lrc"

    lyrics_dir = song_dir / "lyrics"
    lyrics_dir.mkdir(parents=True, exist_ok=True)
    target = lyrics_dir / f"{sanitize_filename(title)}{suffix}"
    staged = lyrics_dir / f".upload{suffix}"
    staged.write_text(content, encoding="utf-8")
    try:
        if classify_lyrics_file(staged) == "none":
            raise HTTPException(status_code=422, detail="No timed lyrics found in file")
        _clear_lyrics_files(lyrics_dir, keep=staged)
        staged.replace(target)
    finally:
        staged.unlink(missing_ok=True)
    (lyrics_dir / LOCK_FILE).write_text("", encoding="utf-8")
    library.invalidate(song_dir)
    return {"name": target.name, "lyrics_level": saved_lyrics_level(lyrics_dir)}


@songs_router.delete("/songs/{artist}/{album}/{title}/lyrics")
async def delete_song_lyrics(artist: str, album: str, title: str) -> Dict[str, Any]:
    song_dir, _, _ = _locate(artist, album, title)
    lyrics_dir = song_dir / "lyrics"
    lyrics_dir.mkdir(parents=True, exist_ok=True)
    _clear_lyrics_files(lyrics_dir)
    (lyrics_dir / LOCK_FILE).write_text("", encoding="utf-8")
    library.invalidate(song_dir)
    return {"lyrics_level": "none"}


def _analyze_replaygain(song_dir: Path) -> Dict[str, float]:
    reference = library.reference_audio(song_dir)
    if reference is None:
        raise HTTPException(status_code=409, detail="Song has no audio file to analyze")
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-nostats", "-i", str(reference),
                "-vn", "-af", "ebur128=peak=true", "-f", "null", "-",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise HTTPException(status_code=500, detail=f"Loudness analysis failed: {exc}") from exc

    summary = result.stderr.rsplit("Summary:", 1)[-1]
    loudness = re.search(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", summary)
    peak = re.search(r"Peak:\s*(-?\d+(?:\.\d+)?|-?inf)\s*dBFS", summary)
    if not loudness:
        raise HTTPException(status_code=500, detail="Could not measure loudness")
    peak_db = float(peak.group(1)) if peak and "inf" not in peak.group(1) else -120.0
    values = {
        "replaygain_track_gain": round(REFERENCE_LUFS - float(loudness.group(1)), 2),
        "replaygain_track_peak": round(10 ** (peak_db / 20), 6),
    }
    for audio_file in audio_files(song_dir):
        try:
            write_tags(audio_file, values)
        except Exception:
            continue
    return values


@songs_router.post("/songs/{artist}/{album}/{title}/replaygain/analyze")
async def analyze_song_replaygain(artist: str, album: str, title: str) -> Dict[str, float]:
    song_dir, _, _ = _locate(artist, album, title)
    values = await asyncio.to_thread(_analyze_replaygain, song_dir)
    library.invalidate(song_dir)
    return values
