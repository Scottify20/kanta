"""Entrypoint for running the Kanta backend as a desktop sidecar (PyInstaller / Tauri).

    python run_server.py                  # 127.0.0.1:8000
    python run_server.py --port 8123
    python run_server.py --reload         # development only, needs a source checkout

Environment: KANTA_HOST, KANTA_PORT, KANTA_DATA_DIR, KANTA_FFMPEG, KANTA_PARENT_PID
(exit automatically when that process disappears, so the sidecar never outlives the app).
"""
import argparse
import multiprocessing
import os
import sys
import threading
import time
from pathlib import Path


def _ensure_streams() -> None:
    """Windowed/frozen builds can start with stdout/stderr unset, which breaks logging."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    from app.services.paths import get_data_dir

    log_dir = get_data_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stream = open(log_dir / "backend.log", "a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def _pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _watch_parent(pid: int) -> None:
    def watch() -> None:
        while _pid_alive(pid):
            time.sleep(2)
        os._exit(0)

    threading.Thread(target=watch, name="parent-watchdog", daemon=True).start()


def main() -> None:
    multiprocessing.freeze_support()  # must run before anything spawns workers when frozen

    parser = argparse.ArgumentParser(description="Kanta backend server")
    parser.add_argument("--host", default=os.environ.get("KANTA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("KANTA_PORT", "8000")))
    parser.add_argument("--reload", action="store_true", help="auto-reload (development only)")
    args = parser.parse_args()

    if not getattr(sys, "frozen", False):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
    os.environ.setdefault("PYTHONUTF8", "1")
    _ensure_streams()

    parent_pid = os.environ.get("KANTA_PARENT_PID", "").strip()
    if parent_pid.isdigit():
        _watch_parent(int(parent_pid))

    import uvicorn

    if args.reload and not getattr(sys, "frozen", False):
        uvicorn.run("app.main:app", host=args.host, port=args.port, reload=True)
        return

    # Import the app object directly so PyInstaller's analysis bundles it.
    from app.main import app

    uvicorn.run(app, host=args.host, port=args.port, reload=False, log_level="info")


if __name__ == "__main__":
    main()
