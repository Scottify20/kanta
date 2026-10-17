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
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH)
ONEFILE = os.environ.get("KANTA_ONEFILE") == "1"

CUDA = os.environ.get("KANTA_CUDA") == "1"
STRIP = sys.platform != "win32"

EXCLUDES = [
    "tkinter", "matplotlib", "IPython", "pytest", "notebook", "jupyter",
    "torchvision", "tensorboard", "torch.utils.tensorboard", "caffe2",
    "torch.testing._internal", "pandas.tests", "numpy.tests", "scipy.tests",
]
# The CPU build ships no GPU runtime; onnxruntime-gpu's CUDA/TensorRT providers are large.
DROP_BINARIES = () if CUDA else (
    "libonnxruntime_providers_cuda", "libonnxruntime_providers_tensorrt",
    "onnxruntime_providers_cuda", "onnxruntime_providers_tensorrt",
)

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
    excludes=EXCLUDES,
)

# Drop test suites and GPU-only provider libraries the build does not need.
a.datas = [d for d in a.datas if not any(m in d[0].replace("\\", "/") for m in ("/tests/", "/test/", "/testing/_internal/"))]
a.binaries = [b for b in a.binaries if not b[0].lower().replace("\\", "/").split("/")[-1].startswith(DROP_BINARIES)]
pyz = PYZ(a.pure)

if ONEFILE:
    exe = EXE(
        pyz, a.scripts, a.binaries, a.datas, [],
        name="kanta-backend", console=True, upx=False, strip=STRIP,
    )
else:
    exe = EXE(
        pyz, a.scripts, [], exclude_binaries=True,
        name="kanta-backend", console=True, upx=False, strip=STRIP,
    )
    coll = COLLECT(exe, a.binaries, a.datas, name="kanta-backend", upx=False, strip=STRIP)
