import asyncio
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from app.services.artist_info import artist_photo_path, get_artist_info

router = APIRouter(prefix="/api/artists", tags=["Artists"])


@router.get("/photo/{photo_id}")
def artist_photo(photo_id: str) -> FileResponse:
    photo = artist_photo_path(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="Artist photo not found")
    media_type = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }[photo.suffix.lower()]
    return FileResponse(photo, media_type=media_type)


@router.get("/info")
async def artist_info(
    request: Request,
    name: str = Query(..., min_length=1, max_length=200),
    folder: str | None = Query(None, min_length=1, max_length=255),
) -> Dict[str, Any]:
    if not name.strip():
        raise HTTPException(status_code=422, detail="name must not be empty")
    if folder and (folder in {".", ".."} or any(char in folder for char in ("/", "\\", "\x00"))):
        raise HTTPException(status_code=422, detail="Invalid artist folder")
    return await asyncio.to_thread(get_artist_info, name.strip(), folder, str(request.base_url))
