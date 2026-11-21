import json
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
        tags_value = {field: None for field in library.EXTENDED_FIELDS}
        tags_value["genre"] = "test"
        with (
            patch.object(library, "read_tags", return_value=tags_value) as tags,
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

    def test_cache_missing_new_metadata_field_is_rebuilt(self):
        old_tags = {field: None for field in library.EXTENDED_FIELDS if field != "musical_key"}
        new_tags = {**old_tags, "musical_key": "F"}
        with (
            patch.object(library, "read_tags", side_effect=[old_tags, new_tags]) as tags,
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
        ):
            original = self.scan()
            self.assertNotIn("musical_key", original[0])
            library._song_cache.clear()
            library._loaded_roots.clear()

            refreshed = self.scan()

        self.assertEqual(tags.call_count, 2)
        self.assertEqual(refreshed[0]["musical_key"], "F")

    def test_vocal_fields_survive_root_cache_reload(self):
        vocal_range = {
            "min_hz": 110.0,
            "max_hz": 440.0,
            "min_note": "A2",
            "max_note": "A4",
            "tessitura_min_hz": 160.0,
            "tessitura_max_hz": 300.0,
            "tessitura_min_note": "E3",
            "tessitura_max_note": "D4",
            "voice_type": "Baritone",
        }
        (self.song / library.SIDECAR_NAME).write_text(
            json.dumps({"vocal_range": vocal_range}),
            encoding="utf-8",
        )
        tags_value = {field: None for field in library.EXTENDED_FIELDS}
        with (
            patch.object(library, "read_tags", return_value=tags_value) as tags,
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
        ):
            original = self.scan()
            self.assertEqual(original[0]["vocal_min_hz"], 110.0)
            self.assertEqual(original[0]["vocal_voice_type"], "Baritone")
            library._song_cache.clear()
            library._loaded_roots.clear()
            reloaded = self.scan()

        self.assertEqual(tags.call_count, 1)
        self.assertEqual(reloaded, original)
        saved_sidecar = json.loads(
            (self.song / library.SIDECAR_NAME).read_text(encoding="utf-8")
        )
        self.assertIn("date_added", saved_sidecar)
        self.assertEqual(saved_sidecar["vocal_range"], vocal_range)

    def test_key_and_bpm_sidecar_survive_root_cache_reload(self):
        (self.song / library.SIDECAR_NAME).write_text(
            json.dumps({
                "musical_key": "Am",
                "musical_key_mode": "Minor",
                "camelot_key": "8A",
                "bpm": 96,
            }),
            encoding="utf-8",
        )
        tags_value = {field: None for field in library.EXTENDED_FIELDS}
        with (
            patch.object(library, "read_tags", return_value=tags_value) as tags,
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
        ):
            original = self.scan()[0]
            self.assertEqual(original["musical_key"], "Am")
            self.assertEqual(original["musical_key_mode"], "Minor")
            self.assertEqual(original["camelot_key"], "8A")
            self.assertEqual(original["bpm"], 96)
            library._song_cache.clear()
            library._loaded_roots.clear()
            reloaded = self.scan()[0]

        self.assertEqual(tags.call_count, 1)
        self.assertEqual(reloaded, original)

    def test_sidecar_mtime_invalidates_song_record(self):
        sidecar = self.song / library.SIDECAR_NAME
        sidecar.write_text(
            json.dumps({"date_added": 123.0, "vocal_range": {"min_hz": 100.0}}),
            encoding="utf-8",
        )
        tags_value = {field: None for field in library.EXTENDED_FIELDS}
        with (
            patch.object(library, "read_tags", return_value=tags_value) as tags,
            patch.object(library, "read_display_names", return_value={}),
            patch.object(library, "read_duration", return_value=10),
        ):
            original = self.scan()[0]
            stat = sidecar.stat()
            sidecar.write_text(
                json.dumps({"date_added": 123.0, "vocal_range": {"min_hz": 125.0}}),
                encoding="utf-8",
            )
            os.utime(sidecar, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
            updated = self.scan()[0]

        self.assertEqual(tags.call_count, 2)
        self.assertEqual(original["vocal_min_hz"], 100.0)
        self.assertEqual(updated["vocal_min_hz"], 125.0)

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
