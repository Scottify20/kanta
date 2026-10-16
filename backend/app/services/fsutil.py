import json
import os
import threading
import time
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Optional

_write_lock = threading.Lock()
_REPLACE_ATTEMPTS = 8


def replace_with_retry(source: Path, target: Path) -> None:
    """os.replace that tolerates the brief sharing violations Windows raises (AV, indexers)."""
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == _REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(0.05 * (attempt + 1))


def atomic_write_json(path: Path, data: Any, indent: int | None = 2) -> None:
    """Write JSON to a temp file in the same directory and atomically replace the target."""
    payload = json.dumps(data, indent=indent, ensure_ascii=False)
    if indent is not None:
        payload += "\n"
    with _write_lock:
        tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            tmp_path.write_text(payload, encoding="utf-8")
            replace_with_retry(tmp_path, path)
        finally:
            tmp_path.unlink(missing_ok=True)


def safe_join(root: Path, relative: str) -> Optional[Path]:
    """Resolve a client-supplied relative URL path under root; None if it escapes root.

    Accepts '/' or '\\' separators and rejects drive letters, UNC and absolute paths so the
    same URL behaves identically on every OS.
    """
    if not relative or "\x00" in relative:
        return None
    normalized = relative.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if PurePosixPath(normalized).is_absolute() or PureWindowsPath(normalized).drive:
        return None
    if any(part == ".." for part in parts):
        return None
    try:
        candidate = root.joinpath(*parts).resolve()
        return candidate if candidate.is_relative_to(root.resolve()) else None
    except (OSError, ValueError):
        return None


def safe_upload_name(filename: Optional[str], fallback: str = "upload") -> str:
    """Final path component of an uploaded filename, regardless of client OS separators."""
    name = PureWindowsPath(filename or "").name
    name = "".join(ch for ch in name if ch >= " " and ch not in '<>:"|?*').strip(". ")
    return name or fallback
