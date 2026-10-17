"""Download large runtime assets (separation models, ffmpeg) into the Kanta data dir.

    python scripts/fetch_assets.py [models] [ffmpeg] [--full]     # no targets = both

--full also downloads the lead/backing vocal and instrument models used by Full mode.
Release builds do not bundle these; the app also offers to download them on first run.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import assets  # noqa: E402


def main(argv: list[str]) -> None:
    full = "--full" in argv
    targets = {arg for arg in argv if not arg.startswith("--")} or {"models", "ffmpeg"}
    if "ffmpeg" in targets:
        if assets.ffmpeg_available():
            print("ffmpeg already available, skipping")
        else:
            print("Downloading ffmpeg ...")
            assets.fetch_ffmpeg()
            print("ffmpeg installed")
    if "models" in targets:
        print("Downloading models (this can take a while) ...")
        assets.fetch_models(full)
        print("Models are ready")


if __name__ == "__main__":
    main(sys.argv[1:])
