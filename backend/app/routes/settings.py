import asyncio
import sys
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import folder_dialog, storage
from app.services.lyrics_providers import PROVIDERS_BY_ID
from app.services.settings import (
    device_availability,
    get_default_output_dir,
    get_inference_device,
    get_lyrics_auto_fetch,
    get_lyrics_provider_keys,
    get_lyrics_provider_order,
    get_lyrics_providers,
    get_model_dir,
    get_output_dirs,
    get_output_mode,
    get_output_quality,
    suggested_output_dir,
    update_lyrics_settings,
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
    inference_device: Optional[Literal["cuda", "mps", "directml", "vulkan", "cpu"]] = None


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
        "lyrics_providers": get_lyrics_providers(),
        "lyrics_auto_fetch": get_lyrics_auto_fetch(),
        "output_dirs_status": storage.output_dirs_status(list(output_dirs)),
        "suggested_output_dir": str(suggested_output_dir()),
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
        *(
            [{"id": "mps", "label": "Apple GPU (Metal)", "available": availability["mps"]}]
            if sys.platform == "darwin"
            else []
        ),
        *(
            [{"id": "directml", "label": "DirectML GPU", "available": availability["directml"]}]
            if sys.platform == "win32"
            else []
        ),
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


class LyricsSettingsUpdate(BaseModel):
    providers: Optional[dict[str, bool]] = None
    auto_fetch: Optional[bool] = None
    order: Optional[list[str]] = None
    keys: Optional[dict[str, dict[str, str]]] = None


@router.get("/lyrics")
def get_lyrics_settings() -> dict[str, Any]:
    enabled = get_lyrics_providers()
    stored_keys = get_lyrics_provider_keys()
    providers = []
    for pid in get_lyrics_provider_order():
        provider = PROVIDERS_BY_ID[pid]
        values = stored_keys.get(pid, {})
        providers.append(
            {
                "id": provider.id,
                "label": provider.label,
                "description": provider.description,
                "word_level": provider.word_level,
                "enabled": enabled[pid],
                "key_required": provider.key_required,
                "key_url": provider.key_url,
                "key_fields": [
                    {"id": f.id, "label": f.label, "secret": f.secret, "value": values.get(f.id, "")}
                    for f in provider.key_fields
                ],
            }
        )
    return {"providers": providers, "auto_fetch": get_lyrics_auto_fetch()}


@router.put("/lyrics")
def update_lyrics(update: LyricsSettingsUpdate) -> dict[str, Any]:
    try:
        update_lyrics_settings(update.providers, update.auto_fetch, update.order, update.keys)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return get_lyrics_settings()


class PickFolderRequest(BaseModel):
    title: str = "Select folder"
    start: str = ""


fs_router = APIRouter(prefix="/api/fs", tags=["Filesystem"])


@fs_router.get("/devices")
def list_storage_devices() -> list[dict[str, Any]]:
    return storage.list_volumes(force=True)


@fs_router.post("/pick-folder")
async def pick_native_folder(request: PickFolderRequest) -> dict[str, Optional[str]]:
    try:
        path = await asyncio.to_thread(folder_dialog.pick_folder, request.title, request.start)
    except folder_dialog.DialogUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    return {"path": path}


@fs_router.get("/browse")
def browse_directories(path: Optional[str] = None) -> dict[str, Any]:
    on_windows = sys.platform == "win32"
    if on_windows and path is not None and not path.strip():
        return {"path": "", "parent": None, "dirs": storage.windows_drive_roots()}
    try:
        raw = (path or "").strip()
        if on_windows and len(raw) == 2 and raw[1] == ":":
            raw += "\\"  # "C:" alone means the drive's cwd; treat it as the root
        target = Path(raw).expanduser() if raw else Path.home()
        target = target.resolve()
        if not target.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found")
        dirs = sorted(
            (
                entry.name
                for entry in target.iterdir()
                if not _is_hidden(entry) and _is_dir(entry)
            ),
            key=str.casefold,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if target.parent != target:
        parent: Optional[str] = str(target.parent)
    else:
        parent = "" if on_windows else None  # drive root -> list of drives
    return {"path": str(target), "parent": parent, "dirs": dirs}


def _is_hidden(entry: Path) -> bool:
    name = entry.name
    if name.startswith((".", "$")) or name == "System Volume Information":
        return True
    if sys.platform == "win32":
        try:
            return bool(entry.stat().st_file_attributes & 0x2)  # FILE_ATTRIBUTE_HIDDEN
        except (OSError, AttributeError):
            return False
    return False


def _is_dir(entry: Path) -> bool:
    try:
        return entry.is_dir()
    except OSError:
        return False
