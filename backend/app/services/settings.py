import json
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = BACKEND_DIR / "separated"
DEFAULT_MODEL_DIR = BACKEND_DIR / "models"
SETTINGS_FILE = BACKEND_DIR / "settings.json"


def get_output_dir() -> Path:
    return get_default_output_dir()


def get_default_output_dir() -> Path:
    settings = _read_settings()
    configured_path = settings.get("default_output_dir") or settings.get("output_dir")
    output_dir = Path(configured_path).expanduser() if configured_path else DEFAULT_OUTPUT_DIR
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def get_output_dirs() -> list[Path]:
    settings = _read_settings()
    configured_dirs = settings.get("output_dirs")
    paths = configured_dirs if isinstance(configured_dirs, list) else []
    if not paths and settings.get("output_dir"):
        paths = [settings["output_dir"]]
    normalized = []
    for path in paths:
        if isinstance(path, str) and path.strip():
            resolved = Path(path).expanduser().resolve()
            if resolved not in normalized:
                normalized.append(resolved)
    default_dir = get_default_output_dir()
    return [default_dir, *(path for path in normalized if path != default_dir)]


def get_model_dir() -> Path:
    settings = _read_settings()
    configured_path = settings.get("model_dir")
    model_dir = Path(configured_path).expanduser() if configured_path else DEFAULT_MODEL_DIR
    return model_dir.resolve()


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
    output_dir.mkdir(parents=True, exist_ok=True)
    update_settings([str(output_dir)], str(output_dir), str(get_model_dir()))
    return output_dir


def update_settings(output_dirs: list[str], default_output_dir: str, model_dir: str) -> dict[str, Any]:
    normalized_dirs = []
    for value in output_dirs:
        if not value.strip():
            continue
        path = Path(value).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
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

    settings = _read_settings()
    settings.update(
        {
            "output_dir": str(default_path),
            "output_dirs": normalized_dirs,
            "default_output_dir": str(default_path),
            "model_dir": str(model_path),
        }
    )
    _write_settings(settings)
    return settings


def _read_settings() -> dict[str, Any]:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        with SETTINGS_FILE.open(encoding="utf-8") as settings_file:
            data = json.load(settings_file)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_settings(settings: dict[str, Any]) -> None:
    with SETTINGS_FILE.open("w", encoding="utf-8") as settings_file:
        json.dump(settings, settings_file, indent=2)
        settings_file.write("\n")
