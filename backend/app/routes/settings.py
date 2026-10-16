from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.settings import (
    device_availability,
    get_default_output_dir,
    get_inference_device,
    get_model_dir,
    get_output_dirs,
    get_output_mode,
    get_output_quality,
    update_settings as save_settings,
)

router = APIRouter(prefix="/api/settings", tags=["Settings"])


class SettingsUpdate(BaseModel):
    output_dir: Optional[str] = None
    output_dirs: Optional[list[str]] = None
    default_output_dir: Optional[str] = None
    model_dir: Optional[str] = None
    output_mode: Optional[Literal["basic", "full"]] = None
    output_quality: Optional[Literal["high", "standard", "low"]] = None
    inference_device: Optional[Literal["cuda", "vulkan", "cpu"]] = None


def _settings_payload(
    default_dir: Any, output_dirs: Any, model_dir: Any
) -> dict[str, Any]:
    return {
        "output_dir": str(default_dir),
        "output_dirs": [str(path) for path in output_dirs],
        "default_output_dir": str(default_dir),
        "model_dir": str(model_dir),
        "output_mode": get_output_mode(),
        "output_quality": get_output_quality(),
        "inference_device": get_inference_device(),
    }


@router.get("")
def get_settings() -> dict[str, Any]:
    return _settings_payload(get_default_output_dir(), get_output_dirs(), get_model_dir())


@router.get("/devices")
def get_devices() -> list[dict[str, Any]]:
    availability = device_availability()
    return [
        {"id": "cuda", "label": "NVIDIA GPU (CUDA)", "available": availability["cuda"]},
        {"id": "vulkan", "label": "Vulkan GPU", "available": availability["vulkan"]},
        {"id": "cpu", "label": "CPU", "available": True},
    ]


@router.put("")
def update_settings(settings: SettingsUpdate) -> dict[str, Any]:
    try:
        current = get_settings()
        output_dirs = settings.output_dirs
        if output_dirs is None:
            output_dirs = current["output_dirs"]
        default_dir = settings.default_output_dir or settings.output_dir or current["default_output_dir"]
        if settings.output_dir and settings.output_dirs is None:
            output_dirs = [settings.output_dir]
        model_dir = settings.model_dir or current["model_dir"]
        updated = save_settings(
            output_dirs,
            default_dir,
            model_dir,
            output_mode=settings.output_mode,
            output_quality=settings.output_quality,
            inference_device=settings.inference_device,
        )
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _settings_payload(
        updated["default_output_dir"], updated["output_dirs"], updated["model_dir"]
    )


fs_router = APIRouter(prefix="/api/fs", tags=["Filesystem"])


@fs_router.get("/browse")
def browse_directories(path: Optional[str] = None) -> dict[str, Any]:
    try:
        target = Path(path).expanduser() if path else Path.home()
        target = target.resolve()
        if not target.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found")
        dirs = sorted(
            (
                entry.name
                for entry in target.iterdir()
                if not entry.name.startswith(".") and _is_dir(entry)
            ),
            key=str.casefold,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    parent = str(target.parent) if target.parent != target else None
    return {"path": str(target), "parent": parent, "dirs": dirs}


def _is_dir(entry: Path) -> bool:
    try:
        return entry.is_dir()
    except OSError:
        return False
