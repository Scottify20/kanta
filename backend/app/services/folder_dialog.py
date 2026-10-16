"""Open the host operating system's native folder-selection dialog."""
import shutil
import subprocess
import sys
from typing import Optional

from app.services.paths import subprocess_kwargs

_TIMEOUT_SECONDS = 600


class DialogUnavailable(RuntimeError):
    pass


def _run(command: list[str]) -> Optional[str]:
    result = subprocess.run(
        command, capture_output=True, text=True, timeout=_TIMEOUT_SECONDS, **subprocess_kwargs()
    )
    if result.returncode != 0:
        return None
    path = result.stdout.strip()
    return path or None


def pick_folder(title: str = "Select folder", start: str = "") -> Optional[str]:
    """Return the chosen folder, or None when the user cancels."""
    if sys.platform == "win32":
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
            f"$d.Description = '{title.replace(chr(39), '')}';"
            + (f"$d.SelectedPath = '{start.replace(chr(39), '')}';" if start else "")
            + "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"
        )
        return _run(["powershell", "-NoProfile", "-STA", "-Command", script])
    if sys.platform == "darwin":
        script = f'POSIX path of (choose folder with prompt "{title.replace(chr(34), "")}")'
        path = _run(["osascript", "-e", script])
        return path.rstrip("/") or "/" if path else None
    if shutil.which("zenity"):
        command = ["zenity", "--file-selection", "--directory", f"--title={title}"]
        if start:
            command.append(f"--filename={start.rstrip('/')}/")
        return _run(command)
    if shutil.which("kdialog"):
        return _run(["kdialog", "--getexistingdirectory", start or ".", "--title", title])
    raise DialogUnavailable("No native folder dialog is available on this system.")
