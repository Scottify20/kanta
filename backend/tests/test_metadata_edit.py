import tempfile
import unittest
import shutil
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from mutagen.id3 import ID3, TIT2, TPE1, TALB

from app.routes import queue
from app.services.tagging import read_tags, get_basic_tag
from app.services.paths import run_ffmpeg


def make_song(root: Path, artist: str, album: str, title: str) -> Path:
    directory = root / artist / album / title
    (directory / "stems").mkdir(parents=True)
    for path, tag_title in [
        (directory / "master.mp3", title),
        (directory / "stems" / f"{title} (Vocals).mp3", f"{title} (Vocals)"),
    ]:
        tags = ID3()
        tags.add(TIT2(encoding=3, text=[tag_title]))
        tags.add(TPE1(encoding=3, text=[artist]))
        tags.add(TALB(encoding=3, text=[album]))
        tags.save(path)
    return directory


class MetadataEditTests(unittest.TestCase):
    def test_move_reuses_album_and_removes_only_empty_old_parents(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = make_song(root, "Artist", "Album", "Song")
            other = make_song(root, "New", "Album", "Existing")
            target = queue._apply_metadata(
                ("Artist", "Album", "Song"), old, root,
                ("New", "Album", "New_Song"), {"genre": "Pop", "replaygain_track_gain": -3.2},
                ("New", "Album", "New:Song"),
            )
            self.assertTrue(other.exists())
            self.assertFalse((root / "Artist").exists())
            self.assertEqual(get_basic_tag(target / "master.mp3", "title"), "New:Song")
            self.assertEqual(get_basic_tag(target / "stems" / "Song (Vocals).mp3", "title"), "New:Song (Vocals)")
            self.assertEqual(read_tags(target / "master.mp3")["genre"], "Pop")
            self.assertEqual(read_tags(target / "master.mp3")["replaygain_track_gain"], -3.2)

    def test_does_not_remove_nonempty_old_parent_or_overwrite_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = make_song(root, "Artist", "Album", "Song")
            sibling = make_song(root, "Artist", "Album", "Sibling")
            destination = make_song(root, "Other", "Album", "Song")
            with self.assertRaises(HTTPException) as error:
                queue._apply_metadata(("Artist", "Album", "Song"), old, root,
                                      ("Other", "Album", "Song"), {})
            self.assertEqual(error.exception.status_code, 409)
            self.assertTrue(old.exists())
            self.assertTrue(destination.exists())
            queue._apply_metadata(("Artist", "Album", "Song"), old, root,
                                  ("Other", "Album", "Moved"), {})
            self.assertTrue(sibling.exists())
            self.assertTrue((root / "Artist" / "Album").exists())

    def test_tag_failure_restores_every_file_and_does_not_move(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = make_song(root, "Artist", "Album", "Song")
            before = {path: path.read_bytes() for path in old.rglob("*.mp3")}
            original = queue.write_tags
            calls = 0

            def failing_write(path, updates):
                nonlocal calls
                calls += 1
                original(path, updates)
                if calls == 2:
                    raise OSError("disk error")

            with patch.object(queue, "write_tags", side_effect=failing_write):
                with self.assertRaisesRegex(OSError, "disk error"):
                    queue._apply_metadata(("Artist", "Album", "Song"), old, root,
                                          ("New", "Album", "Song"), {"genre": "Pop"})
            self.assertEqual({path: path.read_bytes() for path in before}, before)
            self.assertFalse((root / "New").exists())


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
class MetadataEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_metadata_is_returned_and_read_from_the_moved_song(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / "Artist" / "Album" / "Song"
            old.mkdir(parents=True)
            audio = old / "master.mp3"
            run_ffmpeg(["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.1",
                        "-y", str(audio)])
            queue.write_tags(audio, {"artist": "Artist", "album": "Album", "title": "Song"})
            def read_song(artist, album, title, base_url):
                path = root / artist / album / title
                return queue.library.absolutize(
                    queue.library.build_song_record(path, root, 0, artist, album, title), base_url,
                )
            with (
                patch.object(queue, "_locate", return_value=(old, root, 0)),
                patch.object(queue.queue_manager, "update_processed_song_metadata", new=AsyncMock()),
                patch.object(queue.playlists, "rename_song"),
                patch.object(queue.library, "get_song", side_effect=read_song),
            ):
                result = await queue.update_song_metadata(
                    SimpleNamespace(base_url="http://localhost/"), "Artist", "Album", "Song",
                    queue.SongMetadataRequest(artist="New Artist", album="New Album",
                                              title="New:Title", genre="Pop", replaygain_track_gain=-4.5),
                )
            self.assertEqual(result["title"], "New_Title")
            self.assertEqual(result["display_title"], "New:Title")
            self.assertEqual(result["genre"], "Pop")
            self.assertEqual(result["replaygain_track_gain"], -4.5)
            self.assertFalse(old.exists())
            self.assertFalse((root / "Artist").exists())
            self.assertTrue((root / "New Artist" / "New Album" / "New_Title" / "master.mp3").exists())
