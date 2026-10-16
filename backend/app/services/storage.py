"""Detect storage volumes and report whether configured output folders are usable."""
import hashlib
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

_REAL_FS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "zfs", "vfat", "fat", "exfat",
    "ntfs", "ntfs3", "fuseblk", "hfsplus", "apfs", "reiserfs", "jfs", "udf", "iso9660",
    "9p", "cifs", "smb3", "nfs", "nfs4",
}
_SKIP_PREFIXES = (
    "/proc", "/sys", "/dev", "/boot", "/snap", "/var/lib/docker", "/var/lib/snapd",
    "/var/snap", "/usr", "/etc", "/tmp",
)
_REMOVABLE_ROOTS = ("/media", "/run/media")

_cache_lock = threading.Lock()
_volumes_cache: dict[str, Any] = {"at": 0.0, "value": None}
_VOLUMES_TTL = 2.0


def _volume_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8", "surrogateescape")).hexdigest()[:12]


def _usage(path: str) -> tuple[int, int]:
    try:
        usage = shutil.disk_usage(path)
        return usage.total, usage.free
    except OSError:
        return 0, 0


def _unescape_mount(value: str) -> str:
    return value.replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")


def _linux_labels() -> dict[str, str]:
    labels: dict[str, str] = {}
    by_label = Path("/dev/disk/by-label")
    try:
        for entry in by_label.iterdir():
            labels[os.path.realpath(entry)] = entry.name.replace("\\x20", " ")
    except OSError:
        pass
    return labels


def _linux_is_removable_device(device: str) -> bool:
    name = Path(os.path.realpath(device)).name
    sys_dev = Path("/sys/class/block") / name
    try:
        real = sys_dev.resolve()
    except OSError:
        return False
    for candidate in (real, real.parent):
        flag = candidate / "removable"
        try:
            if flag.read_text(encoding="utf-8").strip() == "1":
                return True
        except OSError:
            continue
    return False


def _user_media_roots() -> list[str]:
    user = os.environ.get("USER") or os.environ.get("LOGNAME") or ""
    roots = [f"/media/{user}", f"/run/media/{user}"] if user else []
    return roots + ["/media", "/run/media", "/mnt"]


def _linux_volumes() -> list[dict[str, Any]]:
    entries: list[tuple[str, str, str]] = []
    try:
        with open("/proc/mounts", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                fields = line.split()
                if len(fields) >= 3:
                    entries.append((fields[0], _unescape_mount(fields[1]), fields[2]))
    except OSError:
        entries = []

    labels = _linux_labels()
    media_roots = _user_media_roots()
    volumes: list[dict[str, Any]] = []
    seen_mounts: set[str] = set()
    seen_devices: set[str] = set()
    for device, mount, fstype in entries:
        if mount in seen_mounts:
            continue
        under_media = any(mount.startswith(root + "/") for root in media_roots)
        if not under_media:
            if fstype not in _REAL_FS:
                continue
            if mount != "/" and any(
                mount == p or mount.startswith(p + "/") for p in _SKIP_PREFIXES
            ):
                continue
            if not device.startswith("/") and fstype not in {"9p", "cifs", "smb3", "nfs", "nfs4"}:
                continue
        real_device = os.path.realpath(device) if device.startswith("/") else device
        if real_device in seen_devices and fstype in {"btrfs", "zfs"}:
            continue
        seen_mounts.add(mount)
        seen_devices.add(real_device)
        removable = any(mount.startswith(root + "/") for root in _REMOVABLE_ROOTS) or (
            device.startswith("/dev/") and _linux_is_removable_device(device)
        )
        total, free = _usage(mount)
        label = labels.get(real_device) or (
            "System" if mount == "/" else Path(mount).name or mount
        )
        volumes.append(
            {
                "id": _volume_id(mount),
                "label": label,
                "path": mount,
                "removable": bool(removable),
                "total_bytes": total,
                "free_bytes": free,
                "writable": os.access(mount, os.W_OK),
                "mounted": True,
            }
        )
    return volumes


def _macos_volumes() -> list[dict[str, Any]]:
    volumes: list[dict[str, Any]] = []
    base = Path("/Volumes")
    try:
        entries = sorted(base.iterdir(), key=lambda p: p.name.casefold())
    except OSError:
        return volumes
    for entry in entries:
        is_boot = entry.is_symlink() and os.path.realpath(entry) == "/"
        path = "/" if is_boot else str(entry)
        if not is_boot and not os.path.ismount(entry):
            continue
        total, free = _usage(path)
        volumes.append(
            {
                "id": _volume_id(path),
                "label": entry.name,
                "path": path,
                "removable": not is_boot,
                "total_bytes": total,
                "free_bytes": free,
                "writable": os.access(path, os.W_OK),
                "mounted": True,
            }
        )
    return volumes


def windows_drive_roots() -> list[str]:
    """Drive roots such as 'C:\\' (empty on other platforms)."""
    if sys.platform != "win32":
        return []
    listdrives = getattr(os, "listdrives", None)
    if callable(listdrives):
        try:
            return list(listdrives())
        except OSError:
            pass
    import ctypes

    mask = ctypes.windll.kernel32.GetLogicalDrives()  # type: ignore[attr-defined]
    return [f"{chr(ord('A') + i)}:\\" for i in range(26) if mask & (1 << i)]


def _windows_volumes() -> list[dict[str, Any]]:
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    removable_types = {2, 5}  # DRIVE_REMOVABLE, DRIVE_CDROM
    volumes: list[dict[str, Any]] = []
    for root in windows_drive_roots():
        drive_type = kernel32.GetDriveTypeW(root)
        if drive_type in (0, 1):  # unknown / no root dir
            continue
        label_buffer = ctypes.create_unicode_buffer(261)
        ready = bool(
            kernel32.GetVolumeInformationW(
                root, label_buffer, 261, None, None, None, None, 0
            )
        )
        total, free = _usage(root) if ready else (0, 0)
        label = label_buffer.value if ready and label_buffer.value else root.rstrip("\\")
        volumes.append(
            {
                "id": _volume_id(root.upper()),
                "label": f"{label} ({root.rstrip(chr(92))})" if label != root.rstrip("\\") else label,
                "path": root,
                "removable": drive_type in removable_types,
                "total_bytes": total,
                "free_bytes": free,
                "writable": ready and drive_type != 5 and os.access(root, os.W_OK),
                "mounted": ready,
            }
        )
    return volumes


def list_volumes(force: bool = False) -> list[dict[str, Any]]:
    now = time.monotonic()
    with _cache_lock:
        cached = _volumes_cache["value"]
        if not force and cached is not None and now - _volumes_cache["at"] < _VOLUMES_TTL:
            return cached
    if sys.platform == "win32":
        volumes = _windows_volumes()
    elif sys.platform == "darwin":
        volumes = _macos_volumes()
    else:
        volumes = _linux_volumes()
    with _cache_lock:
        _volumes_cache.update(at=now, value=volumes)
    return volumes


def is_available(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _probe_writable(path: Path) -> bool:
    try:
        with tempfile.NamedTemporaryFile(dir=path, prefix=".kanta-write-test-"):
            pass
        return True
    except OSError:
        return False


def output_dir_status(path: Path) -> dict[str, Any]:
    available = is_available(path)
    writable = available and _probe_writable(path)
    free = _usage(str(path))[1] if available else 0
    return {
        "path": str(path),
        "available": available,
        "writable": writable,
        "free_bytes": free,
    }


def output_dirs_status(paths: list[Path]) -> list[dict[str, Any]]:
    return [output_dir_status(Path(path)) for path in paths]


def _external_mount_point(path: Path) -> Optional[Path]:
    """The drive root / volume folder a path would live on, if it is an external-style location."""
    if sys.platform == "win32":
        return Path(path.anchor) if path.anchor else None
    posix = path.as_posix()
    if sys.platform == "darwin" and posix.startswith("/Volumes/"):
        return Path("/Volumes") / path.parts[2] if len(path.parts) > 2 else None
    for root in _user_media_roots():
        if root in ("/mnt",):
            continue
        if posix.startswith(root + "/"):
            depth = len(Path(root).parts)
            return Path(*path.parts[: depth + 1]) if len(path.parts) > depth else None
    if posix.startswith("/mnt/") and len(path.parts) > 2:
        return Path(*path.parts[:3])
    return None


def mount_point_missing(path: Path) -> bool:
    mount = _external_mount_point(path)
    return mount is not None and not mount.exists()


def prepare_output_dir(path: Path) -> None:
    """Create (if needed) and verify a folder; raises ValueError with a user-facing reason."""
    try:
        if path.exists() and not path.is_dir():
            raise ValueError(f"'{path}' exists but is not a folder")
        if not path.exists():
            mount = _external_mount_point(path)
            if mount is not None and not mount.exists():
                raise ValueError(f"The drive or volume for '{path}' is not connected")
            path.mkdir(parents=True, exist_ok=True)
    except PermissionError as exc:
        raise ValueError(f"Permission denied creating folder '{path}'") from exc
    except OSError as exc:
        raise ValueError(f"Could not create folder '{path}': {exc.strerror or exc}") from exc
    if not _probe_writable(path):
        raise ValueError(
            f"'{path}' is not writable (read-only drive or insufficient permissions)"
        )


def ensure_output_root_available(root: Path) -> None:
    """Raise RuntimeError before writing into a root whose drive is missing."""
    if not is_available(root):
        raise RuntimeError(
            f"Output folder '{root}' is not available. Is the external drive connected?"
        )
    if not _probe_writable(root):
        raise RuntimeError(f"Output folder '{root}' is not writable.")
