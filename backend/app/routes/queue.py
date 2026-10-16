import uuid
from pathlib import Path
from typing import Any, Dict
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from mutagen.easyid3 import EasyID3

from app.services.lyrics import (
    classify_lyrics_file,
    get_lyrics_offset_ms,
    saved_lyrics_level,
    save_lyrics_offset_ms,
)
from app.services.metadata import extract_raw_metadata, sanitize_filename
from app.services.queue_manager import QueueItem, QueuePriority, queue_manager
from app.services.settings import find_song_directory, get_output_dirs

router = APIRouter(prefix="/api/queue", tags=["Queue"])
songs_router = APIRouter(prefix="/api", tags=["Songs"])
UPLOADS_DIR = Path("uploads")
UPLOADS_DIR.mkdir(exist_ok=True)


class QueueReorderRequest(BaseModel):
    karaoke_queue: list[str]


class ProcessedSongRequest(BaseModel):
    artist: str
    album: str
    title: str
    play_next: bool = False
    after_task_id: str | None = None


class SongMetadataRequest(BaseModel):
    artist: str
    album: str
    title: str


class LyricsTimingRequest(BaseModel):
    offset_ms: int = Field(ge=-10_000, le=10_000)


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
    input_path.write_bytes(await file.read())

    try:
        metadata = extract_raw_metadata(input_path)
    except Exception as exc:
        input_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Could not read audio metadata: {exc}") from exc

    item = QueueItem(
        task_id=task_id,
        file_path=str(input_path.resolve()),
        priority=QueuePriority(priority),
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

    master_files = sorted(song_dir.glob("*.mp3"))
    reference_files = master_files or sorted((song_dir / "stems").glob("*.mp3"))
    if not reference_files:
        raise HTTPException(status_code=409, detail="Processed song has no playable audio file")

    task_id = str(uuid.uuid4())
    item = QueueItem(
        task_id=task_id,
        file_path=str(reference_files[0].resolve()),
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


@router.get("")
async def get_queue(request: Request) -> Dict[str, Any]:
    snapshot = await queue_manager.get_queue_snapshot()
    roots = get_output_dirs()

    def attach_cover_url(item: Dict[str, Any] | None) -> None:
        if item is None:
            return
        output_dir = item.get("output_dir")
        if output_dir:
            song_dir = Path(output_dir).resolve()
            root_index = next(
                (index for index, root in enumerate(roots) if song_dir.is_relative_to(root)),
                None,
            )
        else:
            location = find_song_directory(item["artist"], item["album"], item["title"])
            song_dir, _, root_index = location if location else (None, None, None)
        if song_dir is not None and root_index is not None:
            lyrics_dir = song_dir / "lyrics"
            item["lyrics_level"] = saved_lyrics_level(lyrics_dir)
            item["lyrics_offset_ms"] = get_lyrics_offset_ms(lyrics_dir)
        else:
            item["lyrics_level"] = "none"
            item["lyrics_offset_ms"] = 0
        cover_path = (song_dir / "covers" / "cover.jpg").resolve() if song_dir else None
        if (
            root_index is not None
            and cover_path is not None
            and cover_path.is_relative_to(roots[root_index])
            and cover_path.is_file()
        ):
            relative_path = cover_path.relative_to(roots[root_index]).as_posix()
            item["cover_url"] = (
                str(request.base_url).rstrip("/")
                + f"/media-roots/{root_index}/{quote(relative_path, safe='/')}"
            )
        else:
            item["cover_url"] = None

    for item in snapshot["karaoke_queue"] + snapshot["processing_queue"]:
        attach_cover_url(item)
    attach_cover_url(snapshot["current_task"])
    return snapshot


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




@songs_router.get("/songs")
async def list_songs(request: Request) -> list[Dict[str, Any]]:
    songs: list[Dict[str, Any]] = []
    seen_songs = set()
    for root_index, root in enumerate(get_output_dirs()):
        for artist_dir in sorted(root.iterdir() if root.is_dir() else [], key=lambda path: path.name.lower()):
            if not artist_dir.is_dir() or artist_dir.name == "temp":
                continue
            for album_dir in sorted(artist_dir.iterdir(), key=lambda path: path.name.lower()):
                if not album_dir.is_dir():
                    continue
                for song_dir in sorted(album_dir.iterdir(), key=lambda path: path.name.lower()):
                    if not song_dir.is_dir():
                        continue
                    key = (artist_dir.name, album_dir.name, song_dir.name)
                    if key in seen_songs:
                        continue
                    seen_songs.add(key)
                    media_url = lambda path: (
                        str(request.base_url).rstrip("/")
                        + f"/media-roots/{root_index}/{quote(path.relative_to(root).as_posix(), safe='/')}"
                    )
                    lyrics_dir = song_dir / "lyrics"
                    songs.append({
                        "artist": artist_dir.name,
                        "album": album_dir.name,
                        "title": song_dir.name,
                        "stems": [
                            {"name": file.name, "url": media_url(file)}
                            for file in sorted((song_dir / "stems").glob("*") if (song_dir / "stems").is_dir() else [])
                            if file.is_file()
                        ],
                        "lyrics": [
                            {
                                "name": file.name,
                                "url": media_url(file),
                                "level": classify_lyrics_file(file),
                            }
                            for file in sorted(lyrics_dir.glob("*") if lyrics_dir.is_dir() else [])
                            if file.is_file() and file.suffix.lower() in {".ttml", ".lrc"}
                        ],
                        "lyrics_level": saved_lyrics_level(lyrics_dir),
                        "lyrics_offset_ms": get_lyrics_offset_ms(lyrics_dir),
                        "covers": [
                            {"name": file.name, "url": media_url(file)}
                            for file in sorted((song_dir / "covers").glob("*") if (song_dir / "covers").is_dir() else [])
                            if file.is_file()
                        ],
                        "master": next(
                            (media_url(file) for file in sorted(song_dir.glob("*.mp3")) if file.is_file()),
                            None,
                        ),
                    })
    return songs


@songs_router.get("/songs/{artist}/{album}/{title}")
async def get_song_manifest(
    request: Request,
    artist: str,
    album: str,
    title: str,
) -> Dict[str, Any]:
    location = find_song_directory(artist, album, title)
    if location is None:
        raise HTTPException(status_code=404, detail="Song not found")
    song_dir, root, root_index = location

    def static_url(path: Path) -> str:
        relative_path = path.relative_to(root).as_posix()
        return (
            str(request.base_url).rstrip("/")
            + f"/media-roots/{root_index}/{quote(relative_path, safe='/')}"
        )

    def files_in(directory_name: str) -> list[Dict[str, str]]:
        directory = song_dir / directory_name
        if not directory.is_dir():
            return []
        files = []
        for file in sorted(directory.iterdir()):
            if not file.is_file():
                continue
            if directory_name == "lyrics":
                if file.suffix.lower() not in {".ttml", ".lrc"}:
                    continue
                files.append(
                    {
                        "name": file.name,
                        "url": static_url(file),
                        "level": classify_lyrics_file(file),
                    }
                )
            else:
                files.append({"name": file.name, "url": static_url(file)})
        return files

    master_files = [
        file for file in song_dir.iterdir()
        if file.is_file() and file.suffix.lower() == ".mp3"
    ]
    return {
        "artist": artist,
        "album": album,
        "title": title,
        "stems": files_in("stems"),
        "lyrics": files_in("lyrics"),
        "lyrics_level": saved_lyrics_level(song_dir / "lyrics"),
        "lyrics_offset_ms": get_lyrics_offset_ms(song_dir / "lyrics"),
        "covers": files_in("covers"),
        "master": static_url(master_files[0]) if master_files else None,
    }


@songs_router.patch("/songs/{artist}/{album}/{title}/metadata")
async def update_song_metadata(
    artist: str,
    album: str,
    title: str,
    metadata: SongMetadataRequest,
) -> Dict[str, str]:
    location = find_song_directory(artist, album, title)
    if location is None:
        raise HTTPException(status_code=404, detail="Song not found")
    old_song_dir, root, _ = location
    new_artist = sanitize_filename(metadata.artist)
    new_album = sanitize_filename(metadata.album)
    new_title = sanitize_filename(metadata.title)
    if not all((new_artist, new_album, new_title)):
        raise HTTPException(status_code=400, detail="Artist, album, and title are required")

    new_song_dir = (root / new_artist / new_album / new_title).resolve()
    if not new_song_dir.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Invalid song metadata path")
    if new_song_dir != old_song_dir and new_song_dir.exists():
        raise HTTPException(status_code=409, detail="A song with that metadata already exists")

    try:
        if new_song_dir != old_song_dir:
            new_song_dir.parent.mkdir(parents=True, exist_ok=True)
            old_song_dir.rename(new_song_dir)
        for audio_file in new_song_dir.rglob("*.mp3"):
            try:
                tags = EasyID3(audio_file)
                tags["artist"] = new_artist
                tags["album"] = new_album
                tags["title"] = new_title
                tags.save()
            except Exception:
                continue
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

    return {"artist": new_artist, "album": new_album, "title": new_title}


@songs_router.put("/songs/{artist}/{album}/{title}/lyrics-timing")
async def update_lyrics_timing(
    artist: str,
    album: str,
    title: str,
    timing: LyricsTimingRequest,
) -> Dict[str, int]:
    location = find_song_directory(artist, album, title)
    if location is None:
        raise HTTPException(status_code=404, detail="Song not found")
    song_dir, _, _ = location
    offset_ms = save_lyrics_offset_ms(song_dir / "lyrics", timing.offset_ms)
    return {"offset_ms": offset_ms}