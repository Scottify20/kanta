import json
import sys
import threading
from pathlib import Path
from typing import Any

from app.services import storage
from app.services.fsutil import atomic_write_json
from app.services.paths import BACKEND_DIR, DATA_DIR

DEFAULT_OUTPUT_DIR = DATA_DIR / "separated"
DEFAULT_MODEL_DIR = DATA_DIR / "models"
SETTINGS_FILE = DATA_DIR / "settings.json"


OUTPUT_MODES = ("basic", "full")
OUTPUT_QUALITIES = ("high", "standard", "low")
INFERENCE_DEVICES = ("cuda", "mps", "directml", "vulkan", "cpu")

_cache_lock = threading.RLock()
_cache: dict[str, Any] = {"sig": None, "data": {}, "derived": {}}


def get_output_dir() -> Path:
    return get_default_output_dir()


def _derived(key: str, factory):
    """Memoize values derived from the current settings file contents."""
    settings = _read_settings()
    with _cache_lock:
        derived = _cache["derived"]
        if key not in derived:
            derived[key] = factory(settings)
        return derived[key]


def get_default_output_dir() -> Path:
    def build(settings: dict[str, Any]) -> Path:
        configured_path = settings.get("default_output_dir") or settings.get("output_dir")
        output_dir = Path(configured_path).expanduser() if configured_path else DEFAULT_OUTPUT_DIR
        return output_dir.resolve()

    output_dir = _derived("default_dir", build)
    # Only create the folder when its parent exists: a missing parent usually means an
    # unplugged drive, and creating the path would write onto the system disk instead.
    if not storage.is_available(output_dir) and storage.is_available(output_dir.parent):
        try:
            output_dir.mkdir(exist_ok=True)
        except OSError:
            pass
    return output_dir


def get_output_dirs() -> list[Path]:
    def build(settings: dict[str, Any]) -> list[Path]:
        configured_dirs = settings.get("output_dirs")
        paths = configured_dirs if isinstance(configured_dirs, list) else []
        if not paths and settings.get("output_dir"):
            paths = [settings["output_dir"]]
        normalized: list[Path] = []
        for path in paths:
            if isinstance(path, str) and path.strip():
                resolved = Path(path).expanduser().resolve()
                if resolved not in normalized:
                    normalized.append(resolved)
        return normalized

    normalized = _derived("extra_dirs", build)
    default_dir = get_default_output_dir()
    return [default_dir, *(path for path in normalized if path != default_dir)]


def get_model_dir() -> Path:
    def build(settings: dict[str, Any]) -> Path:
        configured_path = settings.get("model_dir")
        model_dir = Path(configured_path).expanduser() if configured_path else DEFAULT_MODEL_DIR
        return model_dir.resolve()

    return _derived("model_dir", build)


def get_settings_version() -> int:
    """Changes whenever settings.json content changes (used to invalidate caches)."""
    _read_settings()
    with _cache_lock:
        return _cache["version"] if "version" in _cache else 0


def get_output_mode() -> str:
    value = _read_settings().get("output_mode")
    return value if value in OUTPUT_MODES else "full"


def get_output_quality() -> str:
    value = _read_settings().get("output_quality")
    return value if value in OUTPUT_QUALITIES else "standard"


def audio_extension(quality: str | None = None) -> str:
    return ".flac" if (quality or get_output_quality()) == "high" else ".mp3"


def device_availability() -> dict[str, bool]:
    with _cache_lock:
        cached = _cache.get("devices")
        if cached is not None:
            return cached
    cuda = vulkan = mps = directml = False
    try:
        import torch

        cuda = bool(torch.cuda.is_available())
        vulkan_check = getattr(torch, "is_vulkan_available", None)
        vulkan = bool(vulkan_check()) if callable(vulkan_check) else False
        mps_backend = getattr(torch.backends, "mps", None)
        mps = bool(mps_backend and mps_backend.is_available())
    except Exception:
        pass
    try:
        import onnxruntime

        directml = "DmlExecutionProvider" in onnxruntime.get_available_providers()
    except Exception:
        pass
    result = {
        "cuda": cuda,
        "mps": mps and sys.platform == "darwin",
        "directml": directml and sys.platform == "win32",
        "vulkan": vulkan,
        "cpu": True,
    }
    with _cache_lock:
        _cache["devices"] = result
    return result


def default_inference_device() -> str:
    availability = device_availability()
    for device in ("cuda", "mps", "directml", "vulkan", "cpu"):
        if availability.get(device):
            return device
    return "cpu"


def get_inference_device() -> str:
    value = _read_settings().get("inference_device")
    return value if value in INFERENCE_DEVICES else default_inference_device()


def find_song_directory(artist: str, album: str, title: str) -> tuple[Path, Path, int] | None:
    for index, output_root in enumerate(get_output_dirs()):
        song_dir = (output_root / artist / album / title).resolve()
        if song_dir.is_relative_to(output_root) and song_dir.is_dir():
            return song_dir, output_root, index
    return None


def set_output_dir(path_value: str) -> Path:
    output_dir = Path(path_value.strip()).expanduser().resolve()
    if not path_value.strip():
        raise ValueError("output_dir must not be empty")
    storage.prepare_output_dir(output_dir)
    update_settings([str(output_dir)], str(output_dir), str(get_model_dir()))
    return output_dir


def update_settings(
    output_dirs: list[str],
    default_output_dir: str,
    model_dir: str,
    output_mode: str | None = None,
    output_quality: str | None = None,
    inference_device: str | None = None,
) -> dict[str, Any]:
    if output_mode is not None and output_mode not in OUTPUT_MODES:
        raise ValueError(f"output_mode must be one of: {', '.join(OUTPUT_MODES)}")
    if output_quality is not None and output_quality not in OUTPUT_QUALITIES:
        raise ValueError(f"output_quality must be one of: {', '.join(OUTPUT_QUALITIES)}")
    if inference_device is not None and inference_device not in INFERENCE_DEVICES:
        raise ValueError(f"inference_device must be one of: {', '.join(INFERENCE_DEVICES)}")
    if inference_device is not None and not device_availability().get(inference_device):
        raise ValueError(f"Inference device '{inference_device}' is not available on this machine")

    known = {str(p) for p in get_output_dirs()}
    normalized_dirs = []
    for value in output_dirs:
        if not value.strip():
            continue
        path = Path(value).expanduser().resolve()
        # Folders already configured may be on an unplugged drive; keep them untouched.
        if str(path) not in known:
            storage.prepare_output_dir(path)
        if str(path) not in normalized_dirs:
            normalized_dirs.append(str(path))
    if not normalized_dirs:
        raise ValueError("At least one processed files folder is required")

    default_path = Path(default_output_dir).expanduser().resolve()
    if str(default_path) not in normalized_dirs:
        raise ValueError("The default folder must be included in processed files folders")

    model_path = Path(model_dir).expanduser().resolve()
    if not model_path.is_dir():
        raise ValueError("The models folder must be an existing directory")

    settings = dict(_read_settings())
    settings.update(
        {
            "output_dir": str(default_path),
            "output_dirs": normalized_dirs,
            "default_output_dir": str(default_path),
            "model_dir": str(model_path),
        }
    )
    for key, value in (
        ("output_mode", output_mode),
        ("output_quality", output_quality),
        ("inference_device", inference_device),
    ):
        if value is not None:
            settings[key] = value
    _write_settings(settings)
    return settings


def _read_settings() -> dict[str, Any]:
    try:
        stat = SETTINGS_FILE.stat()
        sig = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        sig = None
    with _cache_lock:
        if _cache["sig"] == sig and "version" in _cache:
            return _cache["data"]
    data: dict[str, Any] = {}
    if sig is not None:
        try:
            with SETTINGS_FILE.open(encoding="utf-8") as settings_file:
                loaded = json.load(settings_file)
            data = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError):
            data = {}
    with _cache_lock:
        _cache.update(
            sig=sig, data=data, derived={}, version=_cache.get("version", 0) + 1
        )
    return data


def _write_settings(settings: dict[str, Any]) -> None:
    atomic_write_json(SETTINGS_FILE, settings)
    with _cache_lock:
        _cache["sig"] = None  # force re-read (mtime granularity safe)
