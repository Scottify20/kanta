import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import Request

from app import main
from app.routes import queue
from app.tasks import pause_events, tasks_db


class VocalReanalysisTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.song = self.root / "Artist" / "Album" / "Song"
        self.stems = self.song / "stems"
        self.stems.mkdir(parents=True)
        self.vocal = self.stems / "Song (Vocals).mp3"
        self.vocal.write_bytes(b"vocal stem")
        self.task_ids = set()

    def tearDown(self):
        for task_id in self.task_ids:
            tasks_db.pop(task_id, None)
            pause_events.pop(task_id, None)
        self.tmp.cleanup()

    @staticmethod
    def request() -> Request:
        return Request({
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [],
            "server": ("testserver", 80),
            "client": ("testclient", 1),
            "root_path": "",
        })

    def register_task(self, task_id: str) -> None:
        self.task_ids.add(task_id)
        tasks_db[task_id] = {
            "task_id": task_id,
            "status": "pending",
            "progress": 0,
            "cancel_requested": False,
        }
        pause_events[task_id] = threading.Event()

    async def test_batch_start_uses_existing_status_and_cancel_routes(self):
        scan_started = threading.Event()
        continue_scan = threading.Event()

        def delayed_library_scan(_base_url):
            scan_started.set()
            continue_scan.wait(timeout=2)
            return []

        with patch.object(queue.library, "list_songs", side_effect=delayed_library_scan):
            started = await queue.start_library_reanalysis(
                queue.BatchSongAnalysisOptions()
            )
            task_id = started["task_id"]
            self.task_ids.add(task_id)
            self.assertTrue(await asyncio.to_thread(scan_started.wait, 1))

            cancelled = main.cancel_task(task_id)
            self.assertEqual(cancelled["status"], "cancelling")
            continue_scan.set()
            await asyncio.gather(*list(queue._analysis_background_tasks))

        status = main.get_task_status(task_id)
        self.assertEqual(status["status"], "cancelled")
        self.assertEqual(status["step"], "Cancelled by user.")

    async def test_single_track_analysis_returns_updated_manifest(self):
        vocal_range = {"min_hz": 100.0, "max_hz": 300.0}
        manifest = {"title": "Song", "vocal_min_hz": 100.0}
        with (
            patch.object(
                queue, "find_song_directory", return_value=(self.song, self.root, 0)
            ) as locate,
            patch.object(
                queue, "analyze_and_save_vocal_range", return_value=vocal_range
            ) as analyze,
            patch.object(queue.library, "invalidate") as invalidate,
            patch.object(queue.library, "get_song", return_value=manifest),
        ):
            result = await queue.analyze_song_vocal_range(
                self.request(),
                "Artist",
                "Album",
                "Song",
                queue.SongAnalysisOptions(),
            )

        locate.assert_called_once_with("Artist", "Album", "Song")
        analyze.assert_called_once_with(self.song, self.vocal)
        invalidate.assert_called_once_with(self.song)
        self.assertEqual(result["vocal_range"], vocal_range)
        self.assertEqual(result["song"], manifest)

    async def test_single_track_key_and_bpm_analysis_returns_updated_manifest(self):
        master = self.song / "master.mp3"
        master.write_bytes(b"master")
        analysis = {
            "musical_key": "D",
            "musical_key_mode": "Major",
            "camelot_key": "10B",
            "bpm": 120,
        }
        manifest = {"title": "Song", "musical_key": "D", "bpm": 120}
        options = queue.SongAnalysisOptions(
            vocal_range=False, musical_key=True, bpm=True
        )
        with (
            patch.object(queue, "_locate", return_value=(self.song, self.root, 0)),
            patch.object(queue, "analyze_and_save_track_metadata", return_value=analysis) as analyze,
            patch.object(queue.library, "invalidate") as invalidate,
            patch.object(queue.library, "get_song", return_value=manifest),
        ):
            result = await queue.analyze_song_vocal_range(
                self.request(), "Artist", "Album", "Song", options
            )

        analyze.assert_called_once_with(self.song, self.vocal, True, True, master)
        invalidate.assert_called_once_with(self.song)
        self.assertEqual(result["analysis"], analysis)
        self.assertEqual(result["song"], manifest)

    def test_missing_only_skips_existing_sidecar_range(self):
        sidecar = self.song / ".kanta.json"
        sidecar.write_text(json.dumps({"vocal_range": None}), encoding="utf-8")
        self.register_task("missing-only")
        with (
            patch.object(queue.library, "list_songs", return_value=[
                {"path": str(self.song), "title": "Song"},
            ]),
            patch.object(queue, "analyze_and_save_vocal_range") as analyze,
        ):
            queue._run_library_reanalysis(
                "missing-only", queue.BatchSongAnalysisOptions()
            )

        analyze.assert_not_called()
        self.assertEqual(tasks_db["missing-only"]["status"], "completed")
        self.assertEqual(tasks_db["missing-only"]["result"]["skipped"], 1)

    def test_overwrite_mode_analyzes_existing_sidecar_range(self):
        (self.song / ".kanta.json").write_text(
            json.dumps({"vocal_range": {"min_hz": 90.0}}), encoding="utf-8"
        )
        self.register_task("overwrite")
        with (
            patch.object(queue.library, "list_songs", return_value=[
                {"path": str(self.song), "title": "Song"},
            ]),
            patch.object(queue, "analyze_and_save_vocal_range") as analyze,
            patch.object(queue.library, "invalidate"),
        ):
            queue._run_library_reanalysis(
                "overwrite",
                queue.BatchSongAnalysisOptions(missing_only=False),
            )

        analyze.assert_called_once_with(self.song, self.vocal)
        self.assertEqual(tasks_db["overwrite"]["status"], "completed")
        self.assertEqual(tasks_db["overwrite"]["result"]["analyzed"], 1)

    def test_batch_missing_only_skips_existing_key_and_bpm(self):
        (self.song / ".kanta.json").write_text(
            json.dumps({"musical_key": "C", "bpm": 100}),
            encoding="utf-8",
        )
        self.register_task("missing-audio-fields")
        with (
            patch.object(queue.library, "list_songs", return_value=[
                {"path": str(self.song), "title": "Song", "musical_key": "C", "bpm": 100},
            ]),
            patch.object(queue, "analyze_and_save_track_metadata") as analyze,
        ):
            queue._run_library_reanalysis(
                "missing-audio-fields",
                queue.BatchSongAnalysisOptions(
                    vocal_range=False, musical_key=True, bpm=True
                ),
            )

        analyze.assert_not_called()
        self.assertEqual(tasks_db["missing-audio-fields"]["status"], "completed")
        self.assertEqual(tasks_db["missing-audio-fields"]["result"]["skipped"], 1)

    def test_batch_overwrite_analyzes_key_from_vocals_and_bpm_from_master(self):
        master = self.song / "master.mp3"
        master.write_bytes(b"master")
        self.register_task("overwrite-audio-fields")
        with (
            patch.object(queue.library, "list_songs", return_value=[
                {"path": str(self.song), "title": "Song", "musical_key": "C", "bpm": 100},
            ]),
            patch.object(queue, "analyze_and_save_track_metadata") as analyze,
            patch.object(queue.library, "invalidate"),
        ):
            queue._run_library_reanalysis(
                "overwrite-audio-fields",
                queue.BatchSongAnalysisOptions(
                    vocal_range=False,
                    musical_key=True,
                    bpm=True,
                    missing_only=False,
                ),
            )

        analyze.assert_called_once_with(self.song, self.vocal, True, True, master)
        self.assertEqual(tasks_db["overwrite-audio-fields"]["status"], "completed")
        self.assertEqual(tasks_db["overwrite-audio-fields"]["result"]["analyzed"], 1)

    def test_lead_vocal_stem_is_preferred_over_combined_vocal_stem(self):
        lead = self.stems / "Song (Lead Vocals).mp3"
        lead.write_bytes(b"lead vocal stem")

        self.assertEqual(queue._vocal_stem_path(self.song), lead)
        self.assertEqual(queue._key_analysis_audio_path(self.song), lead)

    def test_batch_cancellation_stops_before_next_song(self):
        other_song = self.root / "Artist" / "Album" / "Other"
        other_stems = other_song / "stems"
        other_stems.mkdir(parents=True)
        (other_stems / "Other (Vocals).mp3").write_bytes(b"vocal stem")
        self.register_task("cancel-batch")

        def cancel_after_first(song_dir, _vocal_path):
            tasks_db["cancel-batch"]["cancel_requested"] = True
            return {"song": song_dir.name}

        with (
            patch.object(queue.library, "list_songs", return_value=[
                {"path": str(self.song), "title": "Song"},
                {"path": str(other_song), "title": "Other"},
            ]),
            patch.object(
                queue, "analyze_and_save_vocal_range", side_effect=cancel_after_first
            ) as analyze,
        ):
            queue._run_library_reanalysis(
                "cancel-batch", queue.BatchSongAnalysisOptions()
            )

        analyze.assert_called_once()
        self.assertEqual(tasks_db["cancel-batch"]["status"], "cancelled")
        self.assertNotIn("cancel-batch", pause_events)


if __name__ == "__main__":
    unittest.main()
