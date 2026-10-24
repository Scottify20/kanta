import asyncio
import json
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from app.services import log_buffer

router = APIRouter(prefix="/api/logs", tags=["Logs"])

POLL_SECONDS = 0.5
HEARTBEAT_SECONDS = 15


@router.get("")
def get_logs(after: int = Query(0, ge=0), limit: int = Query(1000, ge=1, le=3000)) -> list[dict[str, Any]]:
    return log_buffer.read(after, limit)


@router.delete("")
def clear_logs() -> dict[str, bool]:
    log_buffer.clear()
    return {"ok": True}


@router.get("/stream")
async def stream_logs(request: Request, after: int = Query(0, ge=0)) -> StreamingResponse:
    async def events():
        last_id = after
        idle = 0.0
        while not await request.is_disconnected():
            entries = log_buffer.read(last_id)
            if entries:
                last_id = entries[-1]["id"]
                idle = 0.0
                yield f"data: {json.dumps(entries)}\n\n"
            else:
                idle += POLL_SECONDS
                if idle >= HEARTBEAT_SECONDS:
                    idle = 0.0
                    yield ": heartbeat\n\n"
            await asyncio.sleep(POLL_SECONDS)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
