from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.settings import (
    get_default_output_dir,
    get_model_dir,
    get_output_dirs,
    update_settings as save_settings,
)

router = APIRouter(prefix="/api/settings", tags=["Settings"])


class SettingsUpdate(BaseModel):
    output_dir: Optional[str] = None
    output_dirs: Optional[list[str]] = None
    default_output_dir: Optional[str] = None
    model_dir: Optional[str] = None


@router.get("")
def get_settings() -> dict[str, Any]:
    default_dir = get_default_output_dir()
    return {
        "output_dir": str(default_dir),
        "output_dirs": [str(path) for path in get_output_dirs()],
        "default_output_dir": str(default_dir),
        "model_dir": str(get_model_dir()),
    }


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
        updated = save_settings(output_dirs, default_dir, model_dir)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "output_dir": updated["default_output_dir"],
        "output_dirs": updated["output_dirs"],
        "default_output_dir": updated["default_output_dir"],
        "model_dir": updated["model_dir"],
    }
