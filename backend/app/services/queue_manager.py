import asyncio
import logging
import json
import threading
import time
from enum import IntEnum
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.services.separator import run_basic_pipeline, run_karaoke_pipeline
from app.tasks import (
    TaskCancelledException,
    clear_task_control,
    pause_events,
    set_task_paused,
    tasks_db,
)

logger = logging.getLogger(__name__)
BACKEND_DIR = Path(__file__).resolve().parents[2]
QUEUE_STATE_FILE = BACKEND_DIR / "queue_state.json"


class QueuePriority(IntEnum):
    KARAOKE = 1
    PROCESSING_ONLY = 2


class QueueItem(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    task_id: str
    file_path: str
    raw_title: str
    raw_artist: str
    raw_album: str
    title: str
    artist: str
    album: str
    priority: QueuePriority
    status: str = "pending"
    progress: int = Field(default=0, ge=0, le=100)
    step: str = "Queued"
    output_dir: Optional[str] = None
    error: Optional[str] = None
    source_type: str = "uploaded"
    created_at: float = Field(default_factory=time.time)
    position: int = 0


class QueueManager:
    """Single-consumer priority queue for GPU-bound separation jobs."""

    def __init__(self) -> None:
        self.queue: List[QueueItem] = []
        self.karaoke_queue: List[QueueItem] = []
        self.current_task: Optional[QueueItem] = None
        self.processing_paused = False
        self._lock = asyncio.Lock()
        self._wake_event = asyncio.Event()
        self._pipeline_lock = asyncio.Lock()
        self._worker_task: Optional[asyncio.Task[None]] = None
        self._stopping = False

    async def start(self) -> None:
        async with self._lock:
            if self._worker_task and not self._worker_task.done():
                return
            self._restore_state()
            self._stopping = False
            self._worker_task = asyncio.create_task(
                self._worker_loop(), name="kanta-separation-worker"
            )

    async def stop(self) -> None:
        async with self._lock:
            self._stopping = True
            worker_task = self._worker_task
            self._wake_event.set()

        if worker_task:
            await worker_task
        self._worker_task = None

    async def add_item(self, item: QueueItem) -> None:
        async with self._lock:
            existing = self._find_item(item.task_id)
            if existing is not None:
                return
            item.position = self._next_position(item.priority)
            self.queue.append(item)
            if item.priority == QueuePriority.KARAOKE:
                self._append_karaoke_item(item)
            self._sort_pending_items()
            tasks_db[item.task_id] = self._task_record(item)
            pause_events.setdefault(item.task_id, threading.Event())
            self._save_state()
            self._wake_event.set()

    async def add_karaoke_item(
        self,
        item: QueueItem,
        at_front: bool = False,
        after_task_id: Optional[str] = None,
    ) -> QueueItem:
        async with self._lock:
            existing = next(
                (
                    queued
                    for queued in self.karaoke_queue
                    if self._same_song(queued, item)
                ),
                None,
            )
            if existing is not None:
                if at_front or after_task_id:
                    self._place_karaoke_item(existing, at_front, after_task_id)
                    self._save_state()
                return existing
            if not at_front and not after_task_id:
                self._append_karaoke_item(item)
            else:
                self._place_karaoke_item(item, at_front, after_task_id)
            tasks_db[item.task_id] = self._task_record(item)
            self._save_state()
            return item

    def _place_karaoke_item(
        self,
        item: QueueItem,
        at_front: bool,
        after_task_id: Optional[str],
    ) -> None:
        if item in self.karaoke_queue:
            self.karaoke_queue.remove(item)
        if after_task_id:
            index = next(
                (
                    index
                    for index, queued in enumerate(self.karaoke_queue)
                    if queued.task_id == after_task_id
                ),
                None,
            )
            if index is not None:
                self.karaoke_queue.insert(index + 1, item)
                return
        self.karaoke_queue.insert(0 if at_front or after_task_id else len(self.karaoke_queue), item)

    async def update_processed_song_metadata(
        self,
        old_artist: str,
        old_album: str,
        old_title: str,
        new_artist: str,
        new_album: str,
        new_title: str,
        old_song_dir: Path,
        new_song_dir: Path,
    ) -> None:
        async with self._lock:
            for item in self.karaoke_queue:
                if (
                    item.source_type != "processed"
                    or (item.artist, item.album, item.title)
                    != (old_artist, old_album, old_title)
                ):
                    continue
                try:
                    relative_file = Path(item.file_path).relative_to(old_song_dir)
                    item.file_path = str((new_song_dir / relative_file).resolve())
                except ValueError:
                    pass
                item.artist = new_artist
                item.album = new_album
                item.title = new_title
                item.raw_artist = new_artist
                item.raw_album = new_album
                item.raw_title = new_title
                item.output_dir = str(new_song_dir.resolve())
                tasks_db[item.task_id] = self._task_record(item)
            self._save_state()

    async def promote_to_karaoke(self, task_id: str) -> QueueItem:
        async with self._lock:
            item = self._find_item(task_id)
            if item is None:
                raise KeyError(task_id)
            if item.status != "pending":
                raise ValueError("Only pending tasks can be promoted.")
            item.priority = QueuePriority.KARAOKE
            item.position = self._next_position(QueuePriority.KARAOKE)
            self._append_karaoke_item(item)
            tasks_db[task_id]["priority"] = QueuePriority.KARAOKE.value
            tasks_db[task_id]["position"] = item.position
            self._sort_pending_items()
            self._save_state()
            self._wake_event.set()
            return item

    async def remove_item(self, task_id: str) -> QueueItem:
        async with self._lock:
            item = self._find_item(task_id)
            if item is None:
                raise KeyError(task_id)

            if item.status == "processing":
                tasks_db[task_id]["cancel_requested"] = True
                tasks_db[task_id]["status"] = "cancelling"
                tasks_db[task_id]["step"] = "Cancellation requested..."
                return item

            item.status = "cancelled"
            item.step = "Cancelled by user."
            tasks_db[task_id].update({"status": item.status, "step": item.step})
            clear_task_control(task_id)
            if item.source_type != "processed":
                self._delete_input(item)
            self._save_state()
            return item

    async def clear(self, priority: Optional[QueuePriority] = None) -> None:
        async with self._lock:
            if priority == QueuePriority.KARAOKE:
                self.karaoke_queue.clear()
                self._save_state()
                return

            retained: List[QueueItem] = []
            for item in self.queue:
                if priority is not None and item.priority != priority:
                    retained.append(item)
                    continue
                if item.status not in {"pending", "processing", "paused", "cancelling"}:
                    retained.append(item)
                    continue
                if item.status == "processing":
                    tasks_db[item.task_id]["cancel_requested"] = True
                    tasks_db[item.task_id]["status"] = "cancelling"
                    retained.append(item)
                    continue
                item.status = "cancelled"
                item.step = "Cancelled by user."
                tasks_db[item.task_id].update(
                    {"status": item.status, "step": item.step}
                )
                clear_task_control(item.task_id)
                if item.source_type != "processed":
                    self._delete_input(item)
            self.queue = retained
            self._save_state()
            self._wake_event.set()

    async def remove_karaoke_item(self, task_id: str) -> None:
        async with self._lock:
            self.karaoke_queue = [
                item for item in self.karaoke_queue if item.task_id != task_id
            ]
            self._save_state()

    async def pause_item(self, task_id: str) -> QueueItem:
        async with self._lock:
            item = self._find_item(task_id)
            if item is None:
                raise KeyError(task_id)
            if item.status not in {"pending", "processing"}:
                raise ValueError("Only pending or processing tasks can be paused.")
            set_task_paused(task_id, True)
            if item.status == "pending":
                item.status = "paused"
            tasks_db[task_id].update(
                {"status": "paused", "pause_requested": True, "step": "Paused."}
            )
            self._save_state()
            return item

    async def resume_item(self, task_id: str) -> QueueItem:
        async with self._lock:
            item = self._find_item(task_id)
            if item is None:
                raise KeyError(task_id)
            if item.status != "paused" and tasks_db.get(task_id, {}).get("status") != "paused":
                raise ValueError("Only paused tasks can be resumed.")
            if self.processing_paused and self.current_task is item:
                set_task_paused(task_id, True)
                tasks_db[task_id].update(
                    {"status": "paused", "pause_requested": True, "step": "Queue paused."}
                )
                self._save_state()
                return item
            set_task_paused(task_id, False)
            if self.current_task is item:
                item.status = "processing"
                next_status = "processing"
            else:
                item.status = "pending"
                next_status = "pending"
            tasks_db[task_id].update(
                {"status": next_status, "pause_requested": False, "step": "Resuming..."}
            )
            self._sort_pending_items()
            self._save_state()
            self._wake_event.set()
            return item

    async def pause_all(self) -> None:
        async with self._lock:
            self.processing_paused = True
            if self.current_task is not None:
                task_id = self.current_task.task_id
                set_task_paused(task_id, True)
                tasks_db[task_id].update(
                    {"status": "paused", "pause_requested": True, "step": "Paused."}
                )
            self._save_state()

    async def resume_all(self) -> None:
        async with self._lock:
            self.processing_paused = False
            if self.current_task is not None:
                task_id = self.current_task.task_id
                set_task_paused(task_id, False)
                tasks_db[task_id].update(
                    {"status": "processing", "pause_requested": False, "step": "Resuming..."}
                )
            self._save_state()
            self._wake_event.set()

    async def reorder_karaoke(self, karaoke_ids: List[str]) -> None:
        async with self._lock:
            current = {item.task_id: item for item in self.karaoke_queue}
            if len(karaoke_ids) != len(set(karaoke_ids)) or set(karaoke_ids) != set(current):
                raise ValueError("Reorder must include every Karaoke Queue item exactly once.")
            self.karaoke_queue = [current[task_id] for task_id in karaoke_ids]
            self._save_state()

    async def get_queue_snapshot(self) -> Dict[str, Any]:
        async with self._lock:
            karaoke = [self._live_item_dict(item) for item in self.karaoke_queue]
            processing = [
                self._live_item_dict(item)
                for item in self.queue
                if item.status in {"pending", "processing", "paused", "cancelling"}
            ]
            current = self._live_item_dict(self.current_task) if self.current_task else None
            return {
                "karaoke_queue": karaoke,
                "processing_queue": processing,
                "current_task": current,
                "processing_paused": self.processing_paused,
            }

    async def run_exclusive(self, pipeline: Any, input_path: Path, task_id: str) -> Path:
        """Run any separation pipeline while holding the single GPU-job lock."""
        async with self._pipeline_lock:
            return await asyncio.to_thread(pipeline, input_path, task_id)

    async def _worker_loop(self) -> None:
        while True:
            await self._wake_event.wait()
            self._wake_event.clear()

            while True:
                async with self._lock:
                    if self._stopping:
                        return
                    if self.processing_paused:
                        break
                    item = self._next_pending_item()
                    if item is None:
                        break
                    item.status = "processing"
                    self.current_task = item
                    tasks_db[item.task_id].update(
                        {"status": "processing", "step": "Starting..."}
                    )

                await self._run_item(item)

                async with self._lock:
                    self.current_task = None

    async def _run_item(self, item: QueueItem) -> None:
        try:
            if item.source_type == "processed":
                return
            pipeline = (
                run_karaoke_pipeline
                if item.priority == QueuePriority.KARAOKE
                else run_basic_pipeline
            )
            self._save_state()
            output_dir = await self.run_exclusive(
                pipeline, Path(item.file_path), item.task_id
            )
            item.output_dir = str(output_dir.resolve())
            item.status = "completed"
            item.progress = 100
            item.step = "Completed."
            tasks_db[item.task_id].update(
                {
                    "status": item.status,
                    "progress": item.progress,
                    "step": item.step,
                    "output_dir": item.output_dir,
                }
            )
        except TaskCancelledException as exc:
            item.status = "cancelled"
            item.step = "Cancelled by user."
            item.error = str(exc)
            tasks_db[item.task_id].update(
                {"status": item.status, "step": item.step, "error": item.error}
            )
        except Exception as exc:
            logger.exception("Queue task %s failed", item.task_id)
            item.status = "failed"
            item.step = "Error."
            item.error = str(exc)
            tasks_db[item.task_id].update(
                {"status": item.status, "step": item.step, "error": item.error}
            )
        finally:
            clear_task_control(item.task_id)
            if item.source_type != "processed":
                self._delete_input(item)
            self._save_state()

    def _next_pending_item(self) -> Optional[QueueItem]:
        self._sort_pending_items()
        return next((item for item in self.queue if item.status == "pending"), None)

    def _sort_pending_items(self) -> None:
        self.queue.sort(key=lambda item: (item.priority, item.position, item.created_at))

    def _next_position(self, priority: QueuePriority) -> int:
        positions = [
            item.position
            for item in self.queue
            if item.status == "pending" and item.priority == priority
        ]
        return max(positions, default=-1) + 1

    def _find_item(self, task_id: str) -> Optional[QueueItem]:
        return next((item for item in self.queue if item.task_id == task_id), None)

    def _append_karaoke_item(self, item: QueueItem) -> None:
        if not any(queued.task_id == item.task_id for queued in self.karaoke_queue):
            self.karaoke_queue.append(item)

    @staticmethod
    def _same_song(left: QueueItem, right: QueueItem) -> bool:
        return all(
            getattr(left, field).strip().casefold()
            == getattr(right, field).strip().casefold()
            for field in ("artist", "album", "title")
        )

    def _task_record(self, item: QueueItem) -> Dict[str, Any]:
        record = item.model_dump()
        record["cancel_requested"] = False
        record["pause_requested"] = False
        return record

    def _live_item_dict(self, item: Optional[QueueItem]) -> Optional[Dict[str, Any]]:
        if item is None:
            return None
        record = dict(item.model_dump())
        record.update(
            {
                key: value
                for key, value in tasks_db.get(item.task_id, {}).items()
                if key in {"status", "progress", "step", "error", "output_dir"}
            }
        )
        if record.get("status") == "completed":
            record["progress"] = 100
        return record

    @staticmethod
    def _delete_input(item: QueueItem) -> None:
        input_path = Path(item.file_path)
        if input_path.exists():
            input_path.unlink()

    def _restore_state(self) -> None:
        if self.queue or self.karaoke_queue or not QUEUE_STATE_FILE.exists():
            return
        try:
            state = json.loads(QUEUE_STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return

        if isinstance(state, list):
            self._restore_legacy_state(state)
            return
        if not isinstance(state, dict):
            return
        self.processing_paused = bool(state.get("processing_paused", False))

        processing_items: Dict[str, QueueItem] = {}
        for record in state.get("processing_queue", []):
            item = self._validated_item(record)
            if (
                item is None
                or item.source_type == "processed"
                or item.status not in {"pending", "processing", "paused"}
                or not Path(item.file_path).exists()
            ):
                continue
            processing_items[item.task_id] = self._restore_processing_item(item)

        seen_karaoke_ids = set()
        for record in state.get("karaoke_queue", []):
            item = self._validated_item(record)
            if item is None or item.task_id in seen_karaoke_ids:
                continue
            item = processing_items.get(item.task_id, item)
            if (
                item.task_id not in processing_items
                and item.status in {"pending", "processing", "paused", "cancelling"}
            ):
                continue
            self._append_karaoke_item(item)
            seen_karaoke_ids.add(item.task_id)
            tasks_db[item.task_id] = self._task_record(item)
        self._sort_pending_items()

    def _restore_legacy_state(self, records: List[Dict[str, Any]]) -> None:
        seen_karaoke_ids = set()
        for record in records:
            item = self._validated_item(record)
            if item is None:
                continue
            if item.source_type == "processed":
                self._append_karaoke_item(item)
                tasks_db[item.task_id] = self._task_record(item)
                continue

            if item.status in {"pending", "processing", "paused"}:
                if not Path(item.file_path).exists():
                    continue
                item = self._restore_processing_item(item)
                if item.priority == QueuePriority.KARAOKE:
                    self._append_karaoke_item(item)
                    seen_karaoke_ids.add(item.task_id)
            elif (
                item.priority == QueuePriority.KARAOKE
                and item.status == "completed"
                and item.output_dir
                and Path(item.output_dir).is_dir()
                and item.task_id not in seen_karaoke_ids
            ):
                self._append_karaoke_item(item)
                seen_karaoke_ids.add(item.task_id)
                tasks_db[item.task_id] = self._task_record(item)
        self._sort_pending_items()

    @staticmethod
    def _validated_item(record: Any) -> Optional[QueueItem]:
        if not isinstance(record, dict):
            return None
        try:
            return QueueItem.model_validate(record)
        except Exception:
            return None

    def _restore_processing_item(self, item: QueueItem) -> QueueItem:
        existing = self._find_item(item.task_id)
        if existing is not None:
            return existing
        if item.status == "processing":
            item.status = "pending"
            item.step = "Recovered after restart."
        self.queue.append(item)
        tasks_db[item.task_id] = self._task_record(item)
        pause_events.setdefault(item.task_id, threading.Event())
        if item.status == "paused":
            set_task_paused(item.task_id, True)
        return item

    def _save_state(self) -> None:
        try:
            QUEUE_STATE_FILE.write_text(
                json.dumps(
                    {
                        "processing_paused": self.processing_paused,
                        "processing_queue": [
                            item.model_dump(mode="json")
                            for item in self.queue
                            if item.status in {"pending", "processing", "paused", "cancelling"}
                        ],
                        "karaoke_queue": [
                            item.model_dump(mode="json") for item in self.karaoke_queue
                        ],
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError:
            logger.exception("Could not persist queue state")


queue_manager = QueueManager()
