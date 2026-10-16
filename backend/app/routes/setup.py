from fastapi import APIRouter

from app.services import assets

router = APIRouter(prefix="/api/setup", tags=["Setup"])


@router.get("/status")
def setup_status():
    return assets.status()


@router.post("/install")
def setup_install():
    started = assets.start_install()
    return {"started": started, **assets.status()}
