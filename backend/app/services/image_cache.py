"""On-demand image resizing and local disk cache for album covers and artist photos."""
import hashlib
import os
import threading
from pathlib import Path
from typing import Optional

from PIL import Image, ImageOps, UnidentifiedImageError

from app.services.paths import DATA_DIR

IMAGE_CACHE_DIR = DATA_DIR / "cache" / "images"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
WIDTH_BUCKETS = (128, 256, 384, 512, 768, 1024)

_locks_guard = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}


def is_optimizable_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def snap_width(requested: int) -> int:
    for bucket in WIDTH_BUCKETS:
        if requested <= bucket:
            return bucket
    return WIDTH_BUCKETS[-1]


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if len(_key_locks) > 512:
            # Prune unlocked entries so memory stays bounded.
            stale = [k for k, lock in _key_locks.items() if not lock.locked()]
            for k in stale:
                _key_locks.pop(k, None)
        return _key_locks.setdefault(key, threading.Lock())


def get_optimized_image(
    source: Path,
    width: Optional[int],
    prefer_webp: bool = True,
) -> tuple[Path, str]:
    """Return (file_path, media_type) for an optimized cached copy, or the source if no resize applies."""
    if not width or width <= 0 or not is_optimizable_image(source):
        return source, _mime_for_suffix(source.suffix.lower())

    try:
        stat = source.stat()
    except OSError:
        return source, _mime_for_suffix(source.suffix.lower())

    target_w = snap_width(width)
    fmt = "webp" if prefer_webp else "jpeg"
    ext = ".webp" if fmt == "webp" else ".jpg"
    mime = "image/webp" if fmt == "webp" else "image/jpeg"

    digest = hashlib.sha1(
        f"{source.resolve()}:{stat.st_mtime_ns}:{stat.st_size}:{target_w}:{fmt}".encode("utf-8")
    ).hexdigest()
    subdir = IMAGE_CACHE_DIR / digest[:2]
    cached_path = subdir / f"{digest}{ext}"

    if cached_path.is_file():
        return cached_path, mime

    with _lock_for(digest):
        if cached_path.is_file():
            return cached_path, mime
        try:
            subdir.mkdir(parents=True, exist_ok=True)
            with Image.open(source) as raw_img:
                img = ImageOps.exif_transpose(raw_img)
                if img.width > target_w or img.height > target_w:
                    img.thumbnail((target_w, target_w), Image.Resampling.LANCZOS)

                if fmt == "jpeg" and img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                elif fmt == "webp" and img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGB")

                tmp_path = subdir / f".{digest}.{os.getpid()}.{threading.get_ident()}.tmp"
                try:
                    if fmt == "webp":
                        img.save(tmp_path, format="WEBP", quality=82, method=4)
                    else:
                        img.save(tmp_path, format="JPEG", quality=84, optimize=True, progressive=True)
                    os.replace(tmp_path, cached_path)
                except Exception:
                    tmp_path.unlink(missing_ok=True)
                    raise
            return cached_path, mime
        except (UnidentifiedImageError, OSError, ValueError):
            return source, _mime_for_suffix(source.suffix.lower())


def _mime_for_suffix(suffix: str) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(suffix, "application/octet-stream")