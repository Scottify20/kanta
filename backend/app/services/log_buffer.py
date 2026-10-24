"""In-memory ring buffer of backend log lines, served to the developer-mode log window."""
import itertools
import logging
import sys
import threading
import time
from collections import deque
from typing import Any

MAX_ENTRIES = 3000
MAX_MESSAGE_CHARS = 8000
LOGGER_NAMES = ("uvicorn", "uvicorn.error", "uvicorn.access")

_entries: deque[dict[str, Any]] = deque(maxlen=MAX_ENTRIES)
_lock = threading.Lock()
_ids = itertools.count(1)
_installed = False


def add(level: str, source: str, message: str) -> None:
    entry = {
        "id": next(_ids),
        "ts": time.time(),
        "level": level,
        "source": source,
        "message": message[:MAX_MESSAGE_CHARS],
    }
    with _lock:
        _entries.append(entry)


def read(after: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
    with _lock:
        newer = [entry for entry in _entries if entry["id"] > after]
    return newer[-limit:]


def clear() -> None:
    with _lock:
        _entries.clear()


class _BufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
            if record.name == "uvicorn.access" and "/api/logs" in message:
                return  # the log window itself would flood the buffer
            if record.exc_info:
                message = f"{message}\n{logging.Formatter().formatException(record.exc_info)}"
            add(record.levelname, record.name, message)
        except Exception:
            self.handleError(record)


class _StreamTee:
    """Mirrors lines written to stdout/stderr (tqdm bars, print) into the buffer."""

    def __init__(self, stream: Any, source: str, level: str) -> None:
        self._stream = stream
        self._source = source
        self._level = level
        self._pending = ""

    def write(self, text: str) -> int:
        written = self._stream.write(text)
        self._pending += text
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            line = line.rsplit("\r", 1)[-1].rstrip()
            if line:
                add(self._level, self._source, line)
        if len(self._pending) > 4096:
            self._pending = self._pending[-1024:]
        return written if written is not None else len(text)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def install() -> None:
    """Attach the buffer to the logging tree and the standard streams; safe to call repeatedly."""
    global _installed
    handler = _BufferHandler(level=logging.INFO)
    root = logging.getLogger()
    # uvicorn resets its own loggers when it configures logging, so (re)attach every call.
    for logger in (root, *(logging.getLogger(name) for name in LOGGER_NAMES)):
        if not any(isinstance(existing, _BufferHandler) for existing in logger.handlers):
            logger.addHandler(handler)
    if root.level == logging.NOTSET or root.level > logging.INFO:
        root.setLevel(logging.INFO)
    if _installed:
        return
    _installed = True
    if sys.stdout is not None:
        sys.stdout = _StreamTee(sys.stdout, "stdout", "INFO")
    if sys.stderr is not None:
        sys.stderr = _StreamTee(sys.stderr, "stderr", "WARNING")
    add("INFO", "kanta", "Log capture started")
