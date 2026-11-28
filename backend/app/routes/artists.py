import asyncio
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from app.services.artist_info import artist_photo_path, get_artist_info
from app.services.image_cache import get_optimized_image, is_optimizable_image

router = APIRouter(prefix="/api/artists", tags=["Artists"])


@router.get("/photo/{photo_id}")
async def artist_photo(
    photo_id: str,
    request: Request,
    w: Optional[int] = Query(default=None, ge=32, le=2048),
) -> FileResponse:
    photo = await asyncio.to_thread(artist_photo_path, photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="Artist photo not found")

    headers = {"Cache-Control": "public, max-age=604800, stale-while-revalidate=2592000"}
    if w is not None and is_optimizable_image(photo):
        prefer_webp = "image/webp" in request.headers.get("accept", "").lower()
        target, media_type = await asyncio.to_thread(get_optimized_image, photo, w, prefer_webp)
        headers["Vary"] = "Accept"
        return FileResponse(target, media_type=media_type, headers=headers)

    media_type = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(photo.suffix.lower(), "application/octet-stream")
    return FileResponse(photo, media_type=media_type, headers=headers)


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