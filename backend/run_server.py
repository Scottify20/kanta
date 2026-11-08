"""Entrypoint for running the Kanta backend as a desktop sidecar (PyInstaller / Tauri).

    python run_server.py                  # 127.0.0.1:8004
    python run_server.py --port 8123
    python run_server.py --reload         # development only, needs a source checkout

Environment: KANTA_HOST, KANTA_PORT, KANTA_DATA_DIR, KANTA_FFMPEG, KANTA_PARENT_PID
(exit automatically when that process disappears, so the sidecar never outlives the app).
"""
import argparse
import errno
import logging
import multiprocessing
import os
import socket
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


def _enable_file_logging() -> None:
    """Persist backend logs (including failed queue jobs) to <data dir>/logs/kanta.log."""
    import logging
    from logging.handlers import RotatingFileHandler

    from app.services.paths import get_data_dir

    log_dir = get_data_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_dir / "kanta.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    logging.getLogger("uvicorn.access").addHandler(handler)


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


def _bind_desktop_socket(host: str, port: int) -> socket.socket:
    def bind(candidate: int) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if sys.platform == "win32":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            sock.bind((host, candidate))
            return sock
        except OSError:
            sock.close()
            raise

    try:
        return bind(port)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        logging.warning("Backend port %s is in use; selecting an available port.", port)
        return bind(0)


def main() -> None:
    multiprocessing.freeze_support()  # must run before anything spawns workers when frozen

    parser = argparse.ArgumentParser(description="Kanta backend server")
    parser.add_argument("--host", default=os.environ.get("KANTA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("KANTA_PORT", "8004")))
    parser.add_argument("--reload", action="store_true", help="auto-reload (development only)")
    args = parser.parse_args()

    if not getattr(sys, "frozen", False):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
    os.environ.setdefault("PYTHONUTF8", "1")
    _ensure_streams()
    _enable_file_logging()
    parent_pid = os.environ.get("KANTA_PARENT_PID", "").strip()
    if parent_pid.isdigit():
        _watch_parent(int(parent_pid))

    import uvicorn

    if args.reload and not getattr(sys, "frozen", False):
        uvicorn.run("app.main:app", host=args.host, port=args.port, reload=True)
        return

    # Import the app object directly so PyInstaller's analysis bundles it.
    from app.main import app

    if os.environ.get("KANTA_DESKTOP_PORT_DISCOVERY") == "1":
        if args.host != "127.0.0.1":
            raise ValueError("Desktop port discovery requires host 127.0.0.1")
        with _bind_desktop_socket(args.host, args.port) as sock:
            print(f"KANTA_BACKEND_PORT={sock.getsockname()[1]}", flush=True)
            config = uvicorn.Config(app, host=args.host, port=sock.getsockname()[1], log_level="info")
            uvicorn.Server(config).run(sockets=[sock])
        return

    uvicorn.run(app, host=args.host, port=args.port, reload=False, log_level="info")


if __name__ == "__main__":
    main()
