import asyncio
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Query

from app.services.artist_info import get_artist_info

router = APIRouter(prefix="/api/artists", tags=["Artists"])


@router.get("/info")
async def artist_info(name: str = Query(..., min_length=1, max_length=200)) -> Dict[str, Any]:
    if not name.strip():
        raise HTTPException(status_code=422, detail="name must not be empty")
    return await asyncio.to_thread(get_artist_info, name.strip())
