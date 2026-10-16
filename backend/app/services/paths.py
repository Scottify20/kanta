"""Cross-platform locations, external tool discovery and subprocess helpers."""
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

APP_NAME = "Kanta"
BACKEND_DIR = Path(__file__).resolve().parents[2]


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _platform_data_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "kanta"


def get_data_dir() -> Path:
    """Where settings, queue state, playlists, models, uploads and library live by default.

    KANTA_DATA_DIR overrides everything. A packaged (frozen) build uses the per-user
    platform data directory; a source checkout keeps using the backend folder.
    """
    override = os.environ.get("KANTA_DATA_DIR")
    if override and override.strip():
        data_dir = Path(override).expanduser()
    elif is_frozen() or os.environ.get("KANTA_USE_APPDATA") == "1":
        data_dir = _platform_data_dir()
    else:
        data_dir = BACKEND_DIR
    data_dir = data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


DATA_DIR = get_data_dir()
UPLOADS_DIR = DATA_DIR / "uploads"
TEMP_DIR = DATA_DIR / "temp_processing"


def _bundle_dirs() -> list[Path]:
    dirs = []
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        dirs.append(Path(bundle))
    if is_frozen():
        dirs.append(Path(sys.executable).resolve().parent)
    return dirs


_EXTRA_BIN_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
)


def find_tool(name: str, env_var: Optional[str] = None) -> str:
    """Locate an executable: env override, bundled copy, PATH, then well-known folders.

    Falls back to the bare name so subprocess raises a clear FileNotFoundError.
    """
    if env_var:
        configured = os.environ.get(env_var)
        if configured and configured.strip():
            candidate = Path(configured.strip()).expanduser()
            if candidate.is_dir():
                candidate = candidate / name
            resolved = shutil.which(str(candidate)) or (
                str(candidate) if candidate.is_file() else None
            )
            if resolved:
                return resolved
    exe_names = [name + ".exe", name] if sys.platform == "win32" else [name]
    for directory in _bundle_dirs():
        for exe in exe_names:
            for sub in ("", "bin"):
                candidate = directory / sub / exe
                if candidate.is_file():
                    return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    if sys.platform != "win32":
        for directory in _EXTRA_BIN_DIRS:
            candidate = Path(directory) / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return name


def ffmpeg_path() -> str:
    return find_tool("ffmpeg", "KANTA_FFMPEG")


def ffprobe_path() -> str:
    configured = os.environ.get("KANTA_FFPROBE")
    if configured:
        return find_tool("ffprobe", "KANTA_FFPROBE")
    sibling = Path(ffmpeg_path()).parent
    for exe in ("ffprobe.exe", "ffprobe"):
        if (sibling / exe).is_file():
            return str(sibling / exe)
    return find_tool("ffprobe")


def configure_environment() -> None:
    """Make the resolved ffmpeg visible to libraries that look it up on PATH themselves."""
    ffmpeg = ffmpeg_path()
    directory = str(Path(ffmpeg).parent) if Path(ffmpeg).is_absolute() else ""
    if directory:
        current = os.environ.get("PATH", "")
        if directory not in current.split(os.pathsep):
            os.environ["PATH"] = directory + os.pathsep + current
    os.environ.setdefault("PYTHONUTF8", "1")


def subprocess_kwargs() -> dict[str, Any]:
    """Keep child processes from flashing console windows on Windows."""
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {}


def run_ffmpeg(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    kwargs.setdefault("check", True)
    return subprocess.run([ffmpeg_path(), *args], **subprocess_kwargs(), **kwargs)


def seed_bundled_models(model_dir: Path) -> None:
    """Copy the shipped model *.yaml configs into the user's model folder when missing."""
    sources = [BACKEND_DIR / "models", *(d / "models" for d in _bundle_dirs())]
    for source in sources:
        if not source.is_dir() or source.resolve() == model_dir.resolve():
            continue
        model_dir.mkdir(parents=True, exist_ok=True)
        for config in source.glob("*.yaml"):
            target = model_dir / config.name
            if not target.exists():
                shutil.copy2(config, target)
