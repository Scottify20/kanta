"""Download large runtime assets (separation models, ffmpeg) into the Kanta data dir.

    python scripts/fetch_assets.py [models] [ffmpeg]     # no args = both

Release builds do not bundle these; the app also downloads models on first use.
"""
import io
import platform
import shutil
import stat
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.paths import find_tool, get_data_dir, seed_bundled_models  # noqa: E402
from app.services.settings import get_model_dir  # noqa: E402

MODELS = (
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    "htdemucs_6s.yaml",
)

FFMPEG_URLS = {
    "win32": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "linux": "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
}


def fetch_models() -> None:
    from audio_separator.separator import Separator

    model_dir = get_model_dir()
    seed_bundled_models(model_dir)
    separator = Separator(model_file_dir=str(model_dir))
    for name in MODELS:
        print(f"Fetching {name} ...")
        separator.load_model(name)
    print(f"Models are in {model_dir}")


def fetch_ffmpeg() -> None:
    if shutil.which("ffmpeg") or Path(find_tool("ffmpeg")).is_file():
        print("ffmpeg already available, skipping")
        return
    url = FFMPEG_URLS.get(sys.platform)
    if not url or platform.machine().lower() not in ("amd64", "x86_64"):
        print("No automatic ffmpeg download for this platform; install it (e.g. `brew install ffmpeg`).")
        return
    target_dir = get_data_dir() / "bin"
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url} ...")
    data = urllib.request.urlopen(url, timeout=300).read()
    wanted = {"ffmpeg", "ffprobe"}
    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.namelist():
                if Path(member).stem in wanted and member.endswith(".exe"):
                    (target_dir / Path(member).name).write_bytes(archive.read(member))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
            for member in archive.getmembers():
                if member.isfile() and Path(member.name).name in wanted:
                    path = target_dir / Path(member.name).name
                    path.write_bytes(archive.extractfile(member).read())
                    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    print(f"ffmpeg installed in {target_dir}")


if __name__ == "__main__":
    targets = set(sys.argv[1:]) or {"models", "ffmpeg"}
    if "ffmpeg" in targets:
        fetch_ffmpeg()
    if "models" in targets:
        fetch_models()
