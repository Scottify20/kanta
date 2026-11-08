import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, UploadFile

from app.routes import queue
from app.services.queue_manager import QueueManager
from app.services.separator import _copy_input_lyrics
from app.services import lyrics

TTML = b'<tt><body><div><p begin="00:00:01.000">Hello</p></div></body></tt>'
LRC = b"[00:01.00]Hello"
METADATA = {
    "raw_title": "Song", "raw_artist": "Artist", "raw_album": "Album",
    "title": "Song", "artist": "Artist", "album": "Album",
}


class QueueLocalLyricsTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_without_lyrics_creates_work_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with (
                patch.object(queue, "get_output_dir", return_value=root),
                patch.object(queue, "extract_raw_metadata", return_value=METADATA),
                patch.object(queue, "read_duration", return_value=10),
                patch.object(queue.queue_manager, "add_item", new=AsyncMock()),
            ):
                result = await queue.add_to_queue(
                    UploadFile(filename="Song.mp3", file=io.BytesIO(b"audio")), 2, None
                )
            audio = Path(result["item"]["file_path"])
            self.assertEqual(audio.parent, root / ".kanta" / "uploads")
            self.assertEqual(audio.read_bytes(), b"audio")

    async def test_uploaded_lyrics_are_preserved_and_cleaned_up(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            add = AsyncMock()
            with (
                patch.object(queue, "get_output_dir", return_value=root),
                patch.object(queue, "extract_raw_metadata", return_value=METADATA),
                patch.object(queue, "read_duration", return_value=10),
                patch.object(queue.queue_manager, "add_item", new=add),
            ):
                result = await queue.add_to_queue(
                    UploadFile(filename="Song.mp3", file=io.BytesIO(b"audio")),
                    2,
                    UploadFile(filename="Song.ttml", file=io.BytesIO(TTML)),
                )
            item = add.await_args.args[0]
            audio = Path(result["item"]["file_path"])
            self.assertEqual(audio.parent, root / ".kanta" / "uploads")
            self.assertEqual(audio.with_suffix(".ttml").read_bytes(), TTML)
            output = root / "song"
            _copy_input_lyrics(audio, output)
            self.assertEqual((output / "lyrics" / "uploaded.ttml").read_bytes(), TTML)
            QueueManager._delete_input(item)
            self.assertFalse(audio.exists())
            self.assertFalse(audio.with_suffix(".ttml").exists())

    async def test_uploaded_lrc_is_preserved_and_cleaned_up(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            add = AsyncMock()
            with (
                patch.object(queue, "get_output_dir", return_value=root),
                patch.object(queue, "extract_raw_metadata", return_value=METADATA),
                patch.object(queue, "read_duration", return_value=10),
                patch.object(queue.queue_manager, "add_item", new=add),
            ):
                result = await queue.add_to_queue(
                    UploadFile(filename="Song.mp3", file=io.BytesIO(b"audio")),
                    2,
                    UploadFile(filename="Song.LRC", file=io.BytesIO(LRC)),
                )
            item = add.await_args.args[0]
            audio = Path(result["item"]["file_path"])
            self.assertEqual(audio.with_suffix(".lrc").read_bytes(), LRC)
            output = root / "song"
            _copy_input_lyrics(audio, output)
            self.assertEqual((output / "lyrics" / "uploaded.lrc").read_bytes(), LRC)
            self.assertEqual(lyrics.saved_lyrics_level(output / "lyrics"), "line")
            QueueManager._delete_input(item)
            self.assertFalse(audio.exists())
            self.assertFalse(audio.with_suffix(".lrc").exists())

    async def test_rejects_mismatched_or_invalid_lyrics(self):
        for name, content in [
            ("Other.ttml", TTML), ("Song.ttml", b"invalid"),
            ("Other.lrc", LRC), ("Song.lrc", b"invalid"),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                with patch.object(queue, "get_output_dir", return_value=Path(temp)):
                    with self.assertRaises(HTTPException):
                        await queue.add_to_queue(
                            UploadFile(filename="Song.mp3", file=io.BytesIO(b"audio")),
                            2,
                            UploadFile(filename=name, file=io.BytesIO(content)),
                        )
                self.assertEqual(list(Path(temp).iterdir()), [])

    def test_line_ttml_can_be_improved_by_word_level_fetch(self):
        word_ttml = '<tt><body><div><p begin="1s"><span begin="1s">Hello</span></p></div></body></tt>'
        with tempfile.TemporaryDirectory() as temp:
            song_dir = Path(temp)
            lyrics_dir = song_dir / "lyrics"
            lyrics_dir.mkdir()
            (lyrics_dir / "uploaded.ttml").write_bytes(TTML)
            provider = SimpleNamespace(id="test", label="Test", word_level=True)
            with (
                patch.object(lyrics, "enabled_providers", return_value=[provider]),
                patch.object(lyrics, "provider_keys", return_value={}),
                patch.object(lyrics, "run_provider", return_value={"ttml": word_ttml}),
            ):
                lyrics.fetch_and_save_lyrics(song_dir, "Artist", "Album", "Song", "Song", 10)
            self.assertEqual(lyrics.saved_lyrics_level(lyrics_dir), "word")
            self.assertTrue((lyrics_dir / "uploaded.ttml").exists())

    def test_duet_detection_uses_selected_timed_singer_agents(self):
        declarations = (
            '<metadata xmlns:ttm="http://www.w3.org/ns/ttml#metadata">'
            '<ttm:agent xml:id="alice" type="person"/>'
            '<ttm:agent xml:id="bob" type="person"/>'
            '<ttm:agent xml:id="all" type="group"/></metadata>'
        )
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            path = directory / "song.ttml"
            for agent, expected in [("alice", False), ("bob", True), ("all", True)]:
                path.write_text(
                    '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata">'
                    + declarations + '<body><div><p begin="1s" ttm:agent="' + agent
                    + '"><span begin="1s">Hi</span></p></div></body></tt>',
                    encoding="utf-8",
                )
                self.assertEqual(lyrics.saved_lyrics_is_duet(directory), expected)
            path.write_text('<tt><body><p begin="1s" agent="v2">Hi</p></body></tt>', encoding="utf-8")
            self.assertTrue(lyrics.saved_lyrics_is_duet(directory))
            path.write_text('<tt><body><p begin="1s">Hi</p></body></tt>', encoding="utf-8")
            self.assertFalse(lyrics.saved_lyrics_is_duet(directory))
            path.unlink()
            (directory / "song.lrc").write_text("[00:01.00]Hi", encoding="utf-8")
            self.assertFalse(lyrics.saved_lyrics_is_duet(directory))

    def test_duet_detection_matches_playback_file_selection(self):
        duet_line = '<tt><body><p begin="1s" agent="v2">Hi</p></body></tt>'
        solo_word = '<tt><body><p begin="1s"><span begin="1s">Hi</span></p></body></tt>'
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.assertFalse(lyrics.saved_lyrics_is_duet(directory))
            (directory / "a.ttml").write_text(duet_line, encoding="utf-8")
            (directory / "z.lrc").write_text("[00:01.00]Hi", encoding="utf-8")
            self.assertTrue(lyrics.saved_lyrics_is_duet(directory))
            (directory / "z.ttml").write_text(solo_word, encoding="utf-8")
            self.assertFalse(lyrics.saved_lyrics_is_duet(directory))
            (directory / "z.ttml").write_text("invalid", encoding="utf-8")
            self.assertTrue(lyrics.saved_lyrics_is_duet(directory))
