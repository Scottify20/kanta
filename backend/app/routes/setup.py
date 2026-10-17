from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.services import assets
from app.services.settings import (
    get_default_output_dir,
    get_output_mode,
    is_output_configured,
    suggested_output_dir,
)

router = APIRouter(prefix="/api/setup", tags=["Setup"])


class InstallRequest(BaseModel):
    full: bool = False


def _payload() -> dict[str, Any]:
    return {
        **assets.status(),
        "output_configured": is_output_configured(),
        "output_dir": str(get_default_output_dir()),
        "suggested_output_dir": str(suggested_output_dir()),
        "output_mode": get_output_mode(),
    }


@router.get("/status")
def setup_status():
    return _payload()


@router.post("/install")
def setup_install(request: InstallRequest | None = None):
    started = assets.start_install(bool(request and request.full))
    return {"started": started, **_payload()}
