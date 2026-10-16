import json
import os
import threading
from pathlib import Path
from typing import Any

_write_lock = threading.Lock()


def atomic_write_json(path: Path, data: Any, indent: int | None = 2) -> None:
    """Write JSON to a temp file in the same directory and atomically replace the target."""
    payload = json.dumps(data, indent=indent, ensure_ascii=False)
    if indent is not None:
        payload += "\n"
    with _write_lock:
        tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            tmp_path.write_text(payload, encoding="utf-8")
            os.replace(tmp_path, path)
        finally:
            tmp_path.unlink(missing_ok=True)
