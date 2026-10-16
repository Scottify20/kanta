"""Download large runtime assets (separation models, ffmpeg) into the Kanta data dir.

    python scripts/fetch_assets.py [models] [ffmpeg]     # no args = both

Release builds do not bundle these; the app also offers to download them on first run.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import assets  # noqa: E402

if __name__ == "__main__":
    targets = set(sys.argv[1:]) or {"models", "ffmpeg"}
    if "ffmpeg" in targets:
        if assets.ffmpeg_available():
            print("ffmpeg already available, skipping")
        else:
            print("Downloading ffmpeg ...")
            assets.fetch_ffmpeg()
    if "models" in targets:
        assets.fetch_models(lambda step, _i: print(step + " ..."))
