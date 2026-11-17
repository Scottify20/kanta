import io
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi import UploadFile
import pytest

from app.routes import queue
from app.services.queue_manager import QueueItem, QueueManager, QueuePriority


def test_existing_song_needs_both_stem_files_to_count_as_playable(tmp_path):
    song_dir = tmp_path / "Artist" / "Album" / "Song"
    stems_dir = song_dir / "stems"
    song_dir.mkdir(parents=True)

    assert not queue._has_playable_stems(song_dir)

    stems_dir.mkdir()
    (stems_dir / "Song (Vocals).mp3").write_bytes(b"vocal stem")
    assert not queue._has_playable_stems(song_dir)

    (stems_dir / "Song (Instrumental).flac").write_bytes(b"instrumental stem")
    assert queue._has_playable_stems(song_dir)


@pytest.mark.asyncio
async def test_song_in_library_with_playable_stems_is_skipped(tmp_path, monkeypatch):
    song_dir = tmp_path / "Artist" / "Album" / "Song"
    stems_dir = song_dir / "stems"
    stems_dir.mkdir(parents=True)
    (stems_dir / "Song (Vocals).mp3").write_bytes(b"vocal stem")
    (stems_dir / "Song (Instrumental).mp3").write_bytes(b"instrumental stem")
    monkeypatch.setattr(queue, "get_output_dir", lambda: tmp_path)
    monkeypatch.setattr(queue, "ensure_output_root_available", lambda _root: None)
    monkeypatch.setattr(queue, "find_song_directory", lambda *_args: (song_dir, tmp_path, 0))
    monkeypatch.setattr(queue, "extract_raw_metadata", lambda _path: {
        "raw_title": "Song",
        "raw_artist": "Artist",
        "raw_album": "Album",
        "title": "Song",
        "artist": "Artist",
        "album": "Album",
    })
    monkeypatch.setattr(queue, "read_duration", lambda _path: 10)
    add_item = AsyncMock()
    monkeypatch.setattr(queue.queue_manager, "add_item", add_item)

    result = await queue.add_to_queue(
        UploadFile(filename="Song.mp3", file=io.BytesIO(b"audio")),
        QueuePriority.PROCESSING_ONLY.value,
        None,
    )

    assert result["skipped"] == "already_in_library"
    assert result["item"] is None
    add_item.assert_not_awaited()
    assert list((tmp_path / ".kanta" / "uploads").iterdir()) == []


@pytest.mark.asyncio
async def test_song_in_library_without_playable_stems_is_queued(tmp_path, monkeypatch):
    song_dir = tmp_path / "Artist" / "Album" / "Song"
    song_dir.mkdir(parents=True)
    monkeypatch.setattr(queue, "get_output_dir", lambda: tmp_path)
    monkeypatch.setattr(queue, "ensure_output_root_available", lambda _root: None)
    monkeypatch.setattr(queue, "find_song_directory", lambda *_args: (song_dir, tmp_path, 0))
    monkeypatch.setattr(queue, "extract_raw_metadata", lambda _path: {
        "raw_title": "Song",
        "raw_artist": "Artist",
        "raw_album": "Album",
        "title": "Song",
        "artist": "Artist",
        "album": "Album",
    })
    monkeypatch.setattr(queue, "read_duration", lambda _path: 10)
    add_item = AsyncMock(return_value=None)
    monkeypatch.setattr(queue.queue_manager, "add_item", add_item)

    result = await queue.add_to_queue(
        UploadFile(filename="Song.mp3", file=io.BytesIO(b"audio")),
        QueuePriority.PROCESSING_ONLY.value,
        None,
    )

    assert result["skipped"] is None
    assert result["item"] is not None
    add_item.assert_awaited_once()


@pytest.mark.asyncio
async def test_duplicate_active_song_is_skipped_and_upload_removed(tmp_path):
    manager = QueueManager()
    manager._save_state = lambda: None
    first_path = tmp_path / "first.mp3"
    duplicate_path = tmp_path / "duplicate.mp3"
    first_path.write_bytes(b"first")
    duplicate_path.write_bytes(b"duplicate")

    def item(task_id: str, file_path: Path) -> QueueItem:
        return QueueItem(
            task_id=task_id,
            file_path=str(file_path),
            raw_title="Song",
            raw_artist="Artist",
            raw_album="Album",
            title="Song",
            artist="Artist",
            album="Album",
            priority=QueuePriority.PROCESSING_ONLY,
        )

    original = item("first", first_path)
    assert await manager.add_item(original) is None

    duplicate = await manager.add_item(item("duplicate", duplicate_path))

    assert duplicate is original
    assert not duplicate_path.exists()
    assert first_path.is_file()
