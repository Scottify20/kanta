import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import httpx

from app.tasks import tasks_db, TaskCancelledException
from app.routes.playlists import router as playlists_router
from app.routes.queue import router as queue_router, search_router, songs_router
from app.routes.setup import router as setup_router
from app.routes.settings import fs_router, router as settings_router
from app.services import library
from app.services.fsutil import safe_join, safe_upload_name
from app.services.paths import UPLOADS_DIR, configure_environment
from app.services.metadata import sanitize_filename
from app.services.lyrics import (
    classify_lyrics_file,
    lyrics_locked,
    save_lyrics_result,
    saved_lyrics_files,
)
from app.services.queue_manager import queue_manager
from app.services.separator import run_basic_pipeline, run_karaoke_pipeline
from app.services.settings import (
    find_song_directory,
    get_output_dir,
    get_output_dirs,
    warm_up_devices,
)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    warm_up_devices()
    await queue_manager.start()
    try:
        yield
    finally:
        await queue_manager.stop()


app = FastAPI(title="Kanta API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

configure_environment()
UPLOAD_DIR = UPLOADS_DIR
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# check_dir=False: the default folder may live on a drive that is currently unplugged.
app.mount(
    "/separated",
    StaticFiles(directory=get_output_dir(), check_dir=False),
    name="separated",
)
app.include_router(queue_router)
app.include_router(songs_router)
app.include_router(settings_router)
app.include_router(fs_router)
app.include_router(setup_router)
app.include_router(playlists_router)
app.include_router(search_router)


@app.get("/media/{file_path:path}")
def get_media(file_path: str) -> FileResponse:
    candidate = safe_join(get_output_dir(), file_path)
    if candidate is None or not candidate.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")
    return FileResponse(candidate)


@app.get("/media-roots/{root_index}/{file_path:path}")
def get_media_from_root(root_index: int, file_path: str) -> FileResponse:
    roots = get_output_dirs()
    if root_index < 0 or root_index >= len(roots):
        raise HTTPException(status_code=404, detail="Media file not found")
    candidate = safe_join(roots[root_index], file_path)
    if candidate is None or not candidate.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")
    return FileResponse(candidate)

async def process_audio_input(file: Optional[UploadFile], url: Optional[str]) -> Path:
    if not file and not url:
        raise HTTPException(status_code=400, detail="Must provide either a file or a url.")

    if file and file.filename:
        input_path = UPLOAD_DIR / safe_upload_name(file.filename)
        with open(input_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        return input_path

    if url:
        try:
            filename = safe_upload_name(url.split("?")[0].rsplit("/", 1)[-1], "downloaded_track.flac")
            input_path = UPLOAD_DIR / filename
            async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                with open(input_path, "wb") as f:
                    f.write(resp.content)
            return input_path
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to download audio: {str(e)}")

@app.get("/health")
def health_check():
    return {"status": "ok", "app": "Kanta Backend"}


@app.get("/api/blyrics/getLyrics")
async def get_better_lyrics(
    s: str,
    a: str,
    d: int = 1,
    al: Optional[str] = None,
):
    artist = sanitize_filename(a)
    album = sanitize_filename(al or "Unknown Album")
    title = sanitize_filename(s)
    song_location = find_song_directory(artist, album, title)
    song_dir = song_location[0] if song_location else None
    local_lyrics_dir = song_dir / "lyrics" if song_dir else None
    local_files = saved_lyrics_files(local_lyrics_dir) if local_lyrics_dir else []
    word_ttml = next(
        (
            path
            for path in local_files
            if path.suffix.lower() == ".ttml"
            and classify_lyrics_file(path) == "word"
        ),
        None,
    )
    if word_ttml:
        return {"ttml": word_ttml.read_text(encoding="utf-8"), "lrc": None}
    if local_lyrics_dir is not None and lyrics_locked(local_lyrics_dir):
        local_line = next(iter(local_files), None)
        if local_line is None:
            raise HTTPException(status_code=404, detail="No lyrics available")
        payload = {"ttml": None, "lrc": None}
        payload["ttml" if local_line.suffix.lower() == ".ttml" else "lrc"] = (
            local_line.read_text(encoding="utf-8")
        )
        return payload
    saved_line = next(
        (path for path in local_files if classify_lyrics_file(path) == "line"),
        None,
    )

    params = {"s": s, "a": a, "d": d}
    if al:
        params["al"] = al
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get("https://lyrics-api.boidu.dev/getLyrics", params=params)
        data = response.json()
        saved_result = None
        if (
            response.status_code == 200
            and isinstance(data, dict)
            and song_dir is not None
            and local_lyrics_dir is not None
        ):
            local_lyrics_dir.mkdir(parents=True, exist_ok=True)
            saved_result = save_lyrics_result(
                local_lyrics_dir,
                title,
                data.get("ttml"),
                data.get("lrc"),
            )
        if saved_result:
            library.invalidate(song_dir)
            return JSONResponse(content=saved_result, status_code=response.status_code)
        if saved_line:
            payload = {"ttml": None, "lrc": None}
            payload["ttml" if saved_line.suffix.lower() == ".ttml" else "lrc"] = (
                saved_line.read_text(encoding="utf-8")
            )
            return JSONResponse(content=payload, status_code=response.status_code)
        return JSONResponse(content=data, status_code=response.status_code)
    except (httpx.HTTPError, ValueError) as exc:
        if saved_line:
            payload = {"ttml": None, "lrc": None}
            payload["ttml" if saved_line.suffix.lower() == ".ttml" else "lrc"] = (
                saved_line.read_text(encoding="utf-8")
            )
            return payload
        raise HTTPException(status_code=502, detail=f"Lyrics provider request failed: {exc}") from exc

@app.get("/api/status/{task_id}")
def get_task_status(task_id: str):
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="Task ID not found")
    return tasks_db[task_id]

@app.post("/api/cancel/{task_id}")
def cancel_task(task_id: str):
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="Task ID not found")
    task = tasks_db[task_id]
    if task["status"] in ["completed", "failed", "cancelled"]:
        return {"status": task["status"], "message": f"Task already {task['status']}"}
    task["cancel_requested"] = True
    task["status"] = "cancelling"
    task["step"] = "Abortion requested..."
    return {"status": "cancelling", "task_id": task_id}

@app.post("/api/separate-basic")
async def separate_basic_endpoint(file: Optional[UploadFile] = File(None), url: Optional[str] = Form(None), task_id: Optional[str] = Form(None)):
    active_task_id = task_id or str(uuid.uuid4())
    tasks_db[active_task_id] = {"task_id": active_task_id, "status": "pending", "progress": 0, "step": "Initializing...", "cancel_requested": False, "created_at": time.time()}

    input_path = await process_audio_input(file, url)
    try:
        output_song_dir = await queue_manager.run_exclusive(
            run_basic_pipeline, input_path, active_task_id
        )
        library.invalidate(output_song_dir)
        relative_dir = output_song_dir.relative_to(get_output_dir()).as_posix()
        result = {"status": "success", "task_id": active_task_id, "type": "basic", "folder_path": str(output_song_dir.resolve()), "http_base_url": f"http://127.0.0.1:8000/media/{relative_dir}"}
        tasks_db[active_task_id].update({"status": "completed", "progress": 100, "step": "Completed.", "result": result})
        return result
    except TaskCancelledException as e:
        tasks_db[active_task_id].update({"status": "cancelled", "step": "Cancelled by user.", "error": str(e)})
        raise HTTPException(status_code=499, detail="Task cancelled.")
    except Exception as e:
        tasks_db[active_task_id].update({"status": "failed", "step": "Error.", "error": str(e)})
        raise HTTPException(status_code=500, detail=f"Separation failed: {str(e)}")
    finally:
        if input_path.exists(): input_path.unlink()

@app.post("/api/separate-full")
async def separate_full_endpoint(file: Optional[UploadFile] = File(None), url: Optional[str] = Form(None), task_id: Optional[str] = Form(None)):
    active_task_id = task_id or str(uuid.uuid4())
    tasks_db[active_task_id] = {"task_id": active_task_id, "status": "pending", "progress": 0, "step": "Initializing...", "cancel_requested": False, "created_at": time.time()}

    input_path = await process_audio_input(file, url)
    try:
        output_song_dir = await queue_manager.run_exclusive(
            run_karaoke_pipeline, input_path, active_task_id
        )
        library.invalidate(output_song_dir)
        relative_dir = output_song_dir.relative_to(get_output_dir()).as_posix()
        result = {"status": "success", "task_id": active_task_id, "type": "full", "folder_path": str(output_song_dir.resolve()), "http_base_url": f"http://127.0.0.1:8000/media/{relative_dir}"}
        tasks_db[active_task_id].update({"status": "completed", "progress": 100, "step": "Completed.", "result": result})
        return result
    except TaskCancelledException as e:
        tasks_db[active_task_id].update({"status": "cancelled", "step": "Cancelled by user.", "error": str(e)})
        raise HTTPException(status_code=499, detail="Task cancelled.")
    except Exception as e:
        tasks_db[active_task_id].update({"status": "failed", "step": "Error.", "error": str(e)})
        raise HTTPException(status_code=500, detail=f"Separation failed: {str(e)}")
    finally:
        if input_path.exists(): input_path.unlink()