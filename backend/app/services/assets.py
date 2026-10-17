"""Large runtime assets (ffmpeg, separation models) that are fetched after install."""
import io
import os
import platform
import shutil
import stat
import sys
import tarfile
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional

from app.services.paths import configure_environment, ffmpeg_path, get_data_dir, seed_bundled_models
from app.services.settings import get_model_dir

BASIC_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
FULL_MODELS = (
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    "htdemucs_6s.yaml",
)
# Files that prove a model is usable (htdemucs_6s downloads a .th weight next to its yaml).
BASIC_FILES = (BASIC_MODEL,)
FULL_FILES = ("mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt", "5c90dfd2-34c22ccb.th")

# Rough download sizes in bytes, only used to turn byte counts into a progress percentage.
SIZE_FFMPEG = 100_000_000
SIZE_BASIC = 640_000_000
SIZE_FULL = 970_000_000

FFMPEG_URLS = {
    "win32": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "linux": "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
}

_lock = threading.Lock()
_job: dict[str, Any] = {
    "running": False, "step": "", "detail": "", "progress": 0.0, "error": "", "finished": False,
}


def ffmpeg_downloadable() -> bool:
    return sys.platform in FFMPEG_URLS and platform.machine().lower() in ("amd64", "x86_64")


def ffmpeg_available() -> bool:
    path = ffmpeg_path()
    return Path(path).is_file() or shutil.which(path) is not None


def missing_files(full: bool) -> list[str]:
    model_dir = get_model_dir()
    wanted = BASIC_FILES + (FULL_FILES if full else ())
    return [name for name in wanted if not (model_dir / name).is_file()]


def status() -> dict[str, Any]:
    basic_missing = missing_files(False)
    full_missing = missing_files(True)
    with _lock:
        job = dict(_job)
    ffmpeg = ffmpeg_available()
    return {
        "ffmpeg": ffmpeg,
        "models": not basic_missing,
        "models_full": not full_missing,
        "missing_models": basic_missing,
        "ready": ffmpeg and not basic_missing,
        "ffmpeg_downloadable": ffmpeg_downloadable(),
        "job": job,
    }


class _Progress:
    """Turns byte counts from several downloads into one 0-100 value for the UI."""

    def __init__(self, total_bytes: int) -> None:
        self.total = max(total_bytes, 1)
        self.done = 0

    def advance(self, amount: int, step: str) -> None:
        self.done += amount
        with _lock:
            _job.update(
                step=step,
                detail=f"{self.done / 1_000_000:.0f} MB of about {self.total / 1_000_000:.0f} MB",
                progress=min(99.0, self.done / self.total * 100),
            )


def _stream(url: str, on_chunk: Callable[[int], None]) -> bytes:
    buffer = io.BytesIO()
    request = urllib.request.Request(url, headers={"User-Agent": "Kanta"})
    with urllib.request.urlopen(request, timeout=60) as response:
        while chunk := response.read(256 * 1024):
            buffer.write(chunk)
            on_chunk(len(chunk))
    return buffer.getvalue()


def fetch_ffmpeg(on_chunk: Optional[Callable[[int], None]] = None) -> None:
    url = FFMPEG_URLS.get(sys.platform)
    if not url or not ffmpeg_downloadable():
        raise RuntimeError("ffmpeg can't be downloaded automatically on this system; please install it.")
    target_dir = get_data_dir() / "bin"
    target_dir.mkdir(parents=True, exist_ok=True)
    data = _stream(url, on_chunk or (lambda _n: None))
    wanted = {"ffmpeg", "ffprobe"}
    found = 0
    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.namelist():
                if Path(member).stem in wanted and member.endswith(".exe"):
                    (target_dir / Path(member).name).write_bytes(archive.read(member))
                    found += 1
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
            for member in archive.getmembers():
                if member.isfile() and Path(member.name).name in wanted:
                    path = target_dir / Path(member.name).name
                    path.write_bytes(archive.extractfile(member).read())
                    path.chmod(path.stat().st_mode | stat.S_IEXEC)
                    found += 1
    if not found:
        raise RuntimeError("The ffmpeg download did not contain ffmpeg.")
    # audio-separator looks ffmpeg up on PATH, so make the fresh copy visible right away.
    configure_environment()


def fetch_models(full: bool, on_chunk: Optional[Callable[[int], None]] = None) -> None:
    """Download model files without loading them into memory."""
    from audio_separator.separator import Separator

    configure_environment()
    model_dir = get_model_dir()
    model_dir.mkdir(parents=True, exist_ok=True)
    seed_bundled_models(model_dir)
    separator = Separator(model_file_dir=str(model_dir))

    def download(url: str, output_path: str) -> None:
        if os.path.isfile(output_path):
            return
        part = output_path + ".part"
        request = urllib.request.Request(url, headers={"User-Agent": "Kanta"})
        with urllib.request.urlopen(request, timeout=60) as response, open(part, "wb") as out:
            while chunk := response.read(256 * 1024):
                out.write(chunk)
                if on_chunk:
                    on_chunk(len(chunk))
        os.replace(part, output_path)  # never leave a truncated file that looks complete

    separator.download_file_if_not_exists = download
    for name in (BASIC_MODEL, *(FULL_MODELS if full else ())):
        separator.download_model_files(name)


def _run(full: bool) -> None:
    state = status()
    want_ffmpeg = not state["ffmpeg"]
    want_basic = bool(missing_files(False))
    want_full = full and any(name in FULL_FILES for name in missing_files(True))
    total = (
        (SIZE_FFMPEG if want_ffmpeg else 0)
        + (SIZE_BASIC if want_basic else 0)
        + (SIZE_FULL if want_full else 0)
    )
    progress = _Progress(total)
    with _lock:
        _job.update(running=True, finished=False, step="Starting", detail="", progress=0.0, error="")
    try:
        if want_ffmpeg:
            with _lock:
                _job.update(step="Downloading ffmpeg")
            fetch_ffmpeg(lambda n: progress.advance(n, "Downloading ffmpeg"))
        if want_basic or want_full:
            with _lock:
                _job.update(step="Downloading separation models")
            fetch_models(full, lambda n: progress.advance(n, "Downloading separation models"))
        with _lock:
            _job.update(step="Done", detail="", progress=100.0, finished=True)
    except Exception as exc:  # surfaced to the UI
        with _lock:
            _job["error"] = str(exc) or exc.__class__.__name__
    finally:
        with _lock:
            _job["running"] = False


def start_install(full: bool = False) -> bool:
    """Start downloading whatever is missing. Returns False if a job is already running."""
    with _lock:
        if _job["running"]:
            return False
        _job.update(running=True, finished=False, error="", progress=0.0, step="Starting", detail="")
    threading.Thread(target=_run, args=(full,), daemon=True).start()
    return True
