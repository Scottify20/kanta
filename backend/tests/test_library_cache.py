import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import library


class LibraryCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.song = self.root / "Artist" / "Album" / "Song"
        self.song.mkdir(parents=True)
        self.audio = self.song / "master.mp3"
        self.audio.write_bytes(b"audio")
        library._song_cache.clear()
        library._loaded_roots.clear()

    def tearDown(self):
        library._song_cache.clear()
        library._loaded_roots.clear()
        self.tmp.cleanup()

    def scan(self):
        with patch.object(library, "get_output_dirs", return_value=[self.root]):
            return library._scan()

    def test_cache_survives_restart_and_changed_audio_is_reindexed(self):
        with (
            patch.object(library, "read_tags", return_value={"genre": "test"}) as tags,
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
        ):
            original = self.scan()
            self.assertEqual(tags.call_count, 1)
            self.assertTrue((self.root / ".kanta" / "library.sqlite3").is_file())
            library._song_cache.clear()
            library._loaded_roots.clear()
            self.assertEqual(self.scan(), original)
            self.assertEqual(tags.call_count, 1)
            stat = self.audio.stat()
            os.utime(self.audio, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
            self.scan()
            self.assertEqual(tags.call_count, 2)

    def test_deleted_song_is_removed_from_cache(self):
        with (
            patch.object(library, "read_tags", return_value={}),
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
        ):
            self.scan()
            self.audio.unlink()
            (self.song / library.SIDECAR_NAME).unlink()
            self.song.rmdir()
            self.assertEqual(self.scan(), [])
            library._song_cache.clear()
            library._loaded_roots.clear()
            self.assertEqual(self.scan(), [])

    def test_unwritable_cache_does_not_prevent_scanning(self):
        with (
            patch.object(library, "read_tags", return_value={}),
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
            patch.object(library, "_cache_path", return_value=self.root / "missing" / "nested" / "cache"),
        ):
            self.assertEqual(len(self.scan()), 1)

    def test_root_order_change_rebuilds_media_urls(self):
        other = self.root / "other-root"
        other.mkdir()
        with (
            patch.object(library, "read_tags", return_value={}) as tags,
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
        ):
            self.scan()
            library._song_cache.clear()
            library._loaded_roots.clear()
            with patch.object(library, "get_output_dirs", return_value=[other, self.root]):
                records = library._scan()
            self.assertEqual(records[0]["root_index"], 1)
            self.assertTrue(records[0]["master"].startswith("/media-roots/1/"))
            self.assertEqual(tags.call_count, 2)


if __name__ == "__main__":
    unittest.main()
