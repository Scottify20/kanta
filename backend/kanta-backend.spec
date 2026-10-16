# PyInstaller spec for the Kanta backend sidecar.
#
#   cd backend
#   pyinstaller kanta-backend.spec --noconfirm
#
# Default output is one-folder (dist/kanta-backend/): torch/onnx make one-file builds slow
# to start because they unpack on every launch. Set KANTA_ONEFILE=1 for a single executable.
#
# Tauri sidecars (tauri.conf.json -> bundle.externalBin: ["binaries/kanta-backend"]) must be
# named with the Rust target triple, e.g. binaries/kanta-backend-x86_64-unknown-linux-gnu,
# -x86_64-pc-windows-msvc.exe, -aarch64-apple-darwin. With the one-folder build, ship the
# folder via bundle.resources and launch the executable inside it.
#
# Model weights and ffmpeg are NOT bundled; fetch them with `npm run assets:fetch`
# (python scripts/fetch_assets.py) or let the app download models on first use.
# To bundle ffmpeg anyway, put it in backend/vendor/ and set KANTA_BUNDLE_FFMPEG=1.
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH)
ONEFILE = os.environ.get("KANTA_ONEFILE") == "1"

datas, binaries, hiddenimports = [], [], []
for package in ("audio_separator", "onnxruntime", "librosa", "soundfile", "mutagen", "PIL"):
    try:
        pkg_datas, pkg_binaries, pkg_hidden = collect_all(package)
    except Exception:
        continue
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

hiddenimports += collect_submodules("uvicorn") + collect_submodules("app")
hiddenimports += ["multipart", "python_multipart", "email.mime.multipart"]

# ffmpeg is fetched on first run unless KANTA_BUNDLE_FFMPEG=1 (then backend/vendor/ is bundled).
vendor = ROOT / "vendor"
if os.environ.get("KANTA_BUNDLE_FFMPEG") == "1" and vendor.is_dir():
    for tool in vendor.iterdir():
        if tool.is_file():
            binaries.append((str(tool), "."))

datas.append((str(ROOT / "models" / "*.yaml"), "models"))

a = Analysis(
    ["run_server.py"],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest"],
)
pyz = PYZ(a.pure)

if ONEFILE:
    exe = EXE(
        pyz, a.scripts, a.binaries, a.datas, [],
        name="kanta-backend", console=True, upx=False,
    )
else:
    exe = EXE(
        pyz, a.scripts, [], exclude_binaries=True,
        name="kanta-backend", console=True, upx=False,
    )
    coll = COLLECT(exe, a.binaries, a.datas, name="kanta-backend", upx=False)
