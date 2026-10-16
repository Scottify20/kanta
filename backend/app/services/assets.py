"""Large runtime assets (ffmpeg, separation models) that are fetched after install."""
import io
import platform
import shutil
import stat
import sys
import tarfile
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from app.services.paths import ffmpeg_path, get_data_dir, seed_bundled_models
from app.services.settings import get_model_dir

MODELS = (
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    "htdemucs_6s.yaml",
)
# Files that must exist for each model to be usable (htdemucs_6s downloads a .th weight).
REQUIRED_FILES = (MODELS[0], MODELS[1], "5c90dfd2-34c22ccb.th")

FFMPEG_URLS = {
    "win32": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "linux": "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
}

_lock = threading.Lock()
_job: dict[str, Any] = {"running": False, "step": "", "done": 0, "total": 0, "error": ""}


def ffmpeg_available() -> bool:
    path = ffmpeg_path()
    return Path(path).is_file() or shutil.which(path) is not None


def missing_models() -> list[str]:
    model_dir = get_model_dir()
    return [name for name in REQUIRED_FILES if not (model_dir / name).is_file()]


def status() -> dict[str, Any]:
    missing = missing_models()
    ffmpeg = ffmpeg_available()
    with _lock:
        job = dict(_job)
    return {
        "ffmpeg": ffmpeg,
        "models": not missing,
        "missing_models": missing,
        "ready": ffmpeg and not missing,
        "ffmpeg_downloadable": sys.platform in FFMPEG_URLS
        and platform.machine().lower() in ("amd64", "x86_64"),
        "job": job,
    }


def fetch_ffmpeg() -> None:
    url = FFMPEG_URLS.get(sys.platform)
    if not url or platform.machine().lower() not in ("amd64", "x86_64"):
        raise RuntimeError("ffmpeg can't be downloaded automatically here; please install it.")
    target_dir = get_data_dir() / "bin"
    target_dir.mkdir(parents=True, exist_ok=True)
    data = urllib.request.urlopen(url, timeout=300).read()
    wanted = {"ffmpeg", "ffprobe"}
    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.namelist():
                if Path(member).stem in wanted and member.endswith(".exe"):
                    (target_dir / Path(member).name).write_bytes(archive.read(member))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
            for member in archive.getmembers():
                if member.isfile() and Path(member.name).name in wanted:
                    path = target_dir / Path(member.name).name
                    path.write_bytes(archive.extractfile(member).read())
                    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def fetch_models(progress=None) -> None:
    from audio_separator.separator import Separator

    model_dir = get_model_dir()
    seed_bundled_models(model_dir)
    separator = Separator(model_file_dir=str(model_dir))
    for index, name in enumerate(MODELS):
        if progress:
            progress(f"Downloading {name}", index)
        separator.load_model(name)


def _run(want_ffmpeg: bool, want_models: bool) -> None:
    total = int(want_ffmpeg) + (len(MODELS) if want_models else 0)
    with _lock:
        _job.update(running=True, step="Starting", done=0, total=total, error="")
    try:
        offset = 0
        if want_ffmpeg:
            with _lock:
                _job.update(step="Downloading ffmpeg", done=0)
            fetch_ffmpeg()
            offset = 1
        if want_models:
            def progress(step: str, index: int) -> None:
                with _lock:
                    _job.update(step=step, done=offset + index)

            fetch_models(progress)
        with _lock:
            _job.update(step="Done", done=total)
    except Exception as exc:  # surfaced to the UI
        with _lock:
            _job["error"] = str(exc) or exc.__class__.__name__
    finally:
        with _lock:
            _job["running"] = False


def start_install() -> bool:
    """Start downloading whatever is missing. Returns False if a job is already running."""
    with _lock:
        if _job["running"]:
            return False
        _job["running"] = True
    state = status()
    threading.Thread(
        target=_run, args=(not state["ffmpeg"], not state["models"]), daemon=True
    ).start()
    return True
