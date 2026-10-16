import time
import threading
from typing import Any, Dict, Optional

tasks_db: Dict[str, Dict[str, Any]] = {}
pause_events: Dict[str, threading.Event] = {}

class TaskCancelledException(Exception):
    """Exception raised when task abortion is requested."""
    pass

def check_cancellation_and_update(task_id: Optional[str], step: str, progress: int):
    if not task_id or task_id not in tasks_db:
        return

    task = tasks_db[task_id]
    if task.get("cancel_requested"):
        task["status"] = "cancelled"
        task["step"] = "Task aborted by user."
        raise TaskCancelledException(f"Task {task_id} was cancelled.")

    task["step"] = step
    task["progress"] = progress
    task["status"] = "processing"
    task["updated_at"] = time.time()

    pause_event = pause_events.get(task_id)
    while pause_event and pause_event.is_set():
        task["status"] = "paused"
        task["step"] = "Paused."
        task["updated_at"] = time.time()
        time.sleep(0.1)
        if task.get("cancel_requested"):
            task["status"] = "cancelled"
            task["step"] = "Task aborted by user."
            raise TaskCancelledException(f"Task {task_id} was cancelled.")

    task["status"] = "processing"


def set_task_paused(task_id: str, paused: bool) -> None:
    event = pause_events.setdefault(task_id, threading.Event())
    if paused:
        event.set()
    else:
        event.clear()


def clear_task_control(task_id: str) -> None:
    pause_events.pop(task_id, None)