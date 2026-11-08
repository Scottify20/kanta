import asyncio
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.routes import queue
from app.services.queue_manager import QueueItem, QueueManager, QueuePriority
from app.tasks import clear_task_control, tasks_db


class QueueResponsivenessTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_library_stream_closes_after_running_scan(self):
        started = threading.Event()
        release = threading.Event()
        closed = threading.Event()

        def scan():
            try:
                started.set()
                release.wait(timeout=2)
                yield [{"title": "Song"}]
            finally:
                closed.set()

        with patch.object(queue.library, "stream_songs", return_value=scan()):
            response = await queue.stream_songs(SimpleNamespace(base_url="http://localhost/"))
            task = asyncio.create_task(anext(response.body_iterator))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertFalse(closed.is_set())
            finally:
                release.set()
            self.assertTrue(await asyncio.to_thread(closed.wait, 1))

    async def test_pause_resume_preserves_karaoke_queue(self):
        manager = QueueManager()
        item = QueueItem(
            task_id="queue-isolation-test", file_path="/tmp/queue-isolation-test.mp3",
            raw_title="Title", raw_artist="Artist", raw_album="Album",
            title="Title", artist="Artist", album="Album",
            priority=QueuePriority.KARAOKE, status="processing",
        )
        manager.queue.append(item)
        manager.karaoke_queue.append(item)
        manager.current_task = item
        tasks_db[item.task_id] = manager._task_record(item)
        try:
            with patch.object(manager, "_save_state"):
                await manager.pause_all()
                paused = await manager.get_queue_snapshot()
                self.assertEqual([entry["task_id"] for entry in paused["karaoke_queue"]], [item.task_id])
                self.assertEqual(paused["processing_queue"][0]["status"], "paused")
                await manager.resume_all()
                resumed = await manager.get_queue_snapshot()
                self.assertEqual([entry["task_id"] for entry in resumed["karaoke_queue"]], [item.task_id])
                self.assertEqual(resumed["processing_queue"][0]["status"], "processing")
        finally:
            clear_task_control(item.task_id)
            tasks_db.pop(item.task_id, None)

    async def test_slow_asset_lookup_does_not_block_event_loop(self):
        started = threading.Event()
        release = threading.Event()
        item = {"artist": "Artist", "album": "Album", "title": "Title", "output_dir": None}
        snapshot = {"karaoke_queue": [item], "processing_queue": [], "current_task": None}

        def slow_lookup(*args):
            started.set()
            release.wait(timeout=1)
            return "word", 0, None, True

        with (
            patch.object(queue.queue_manager, "get_queue_snapshot", new=AsyncMock(return_value=snapshot)),
            patch.object(queue.library, "queue_assets", side_effect=slow_lookup),
        ):
            task = asyncio.create_task(queue.build_queue_snapshot("http://localhost"))
            try:
                await asyncio.sleep(0.05)
                self.assertTrue(started.is_set())
                self.assertFalse(task.done(), "asset lookup blocked the event loop")
            finally:
                release.set()
                result = await task
            self.assertTrue(result["karaoke_queue"][0]["is_duet"])
            self.assertEqual(result["karaoke_queue"][0]["lyrics_level"], "word")
