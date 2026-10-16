# Building Kanta for Windows (and macOS/Linux)

Kanta is a Tauri shell around the Angular frontend, with the FastAPI backend shipped as a **sidecar**
executable that Tauri starts and stops (release builds only; in dev you run the backend yourself).

## What changed in the repo for this

- `frontend/src-tauri/src/lib.rs` starts the `kanta-backend` sidecar in release builds, passes
  `KANTA_PARENT_PID`, and kills it on exit. The backend also exits if the parent disappears.
- `frontend/src-tauri/tauri.bundle.conf.json` adds `bundle.externalBin`. It is a separate file so
  `tauri dev` works without a built sidecar.
- `frontend/src-tauri/capabilities/default.json` allows spawning the sidecar and window fullscreen.
- Fullscreen uses the Tauri window API when running in Tauri (the DOM Fullscreen API is unreliable in
  WebView2/WKWebView) and falls back to the DOM API in a browser.
- Backend: `run_server.py` (entrypoint), `kanta-backend.spec` (PyInstaller), `requirements.txt` with
  per-OS onnxruntime markers, `app/services/paths.py` (data dir, ffmpeg lookup), Windows-safe
  filenames, path-traversal-safe media serving, drive listing in `/api/fs/*`.

## Prerequisites (on a Windows machine; cross-compiling the backend is not supported)

1. Node 22+, Rust (MSVC toolchain) and the Visual Studio C++ Build Tools. WebView2 ships with Windows 11
   (the installer bootstraps it on Windows 10).
2. Python 3.11/3.12 with a venv, then:
   ```powershell
   cd backend
   python -m venv venv; .\venv\Scripts\activate
   pip install -r requirements.txt pyinstaller
   pip install torch --index-url https://download.pytorch.org/whl/cu121   # NVIDIA; plain `pip install torch` for CPU
   ```
3. ffmpeg: `npm run assets:ffmpeg`, `KANTA_FFMPEG`, or PATH (not bundled by default).

## Build

Models and ffmpeg are **not** bundled; the installer only contains the app and the Python sidecar.

```powershell
cd frontend
npm ci
npm run app:build        # PyInstaller sidecar -> src-tauri/binaries, then tauri build
```

Individual steps: `npm run backend:build` (sidecar only), `npm run tauri:dev`.

Fetch the large assets into the user data dir (also useful on a dev machine):

```powershell
npm run assets:fetch     # models + ffmpeg;  assets:models / assets:ffmpeg for one of them
```

Models are also downloaded automatically on first use, and ffmpeg is picked up from
`<data dir>/bin`, `KANTA_FFMPEG`, or PATH. To bundle ffmpeg anyway, put it in `backend\vendor\` and
set `KANTA_BUNDLE_FFMPEG=1` before building.

Installers land in `frontend/src-tauri/target/release/bundle/`. Use `rustc -vV` to read the host triple
for other platforms (`aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`).

## Things to know

- **Size and start-up:** torch/onnx make the sidecar large and a one-file build unpacks on each launch.
  If start-up is too slow, use the one-folder build and ship it through `bundle.resources`.
- **Models** are downloaded into the user data dir on first use (`%APPDATA%\Kanta` on Windows,
  `~/Library/Application Support/Kanta` on macOS, `~/.local/share/kanta` on Linux); override with `KANTA_DATA_DIR`.
- **GPU:** CUDA (NVIDIA), DirectML (any DX12 GPU on Windows), MPS (Apple Silicon), CPU fallback. Vulkan is Linux only.
- **Code signing:** unsigned installers trigger SmartScreen; configure `bundle.windows.signCommand`/certificate for releases.
- **Identifier** is now `com.scottify20.kanta`; change it before shipping if you prefer another reverse-DNS name.
- **Ports:** the app talks to `http://127.0.0.1:8000`. If a different port is needed, change `API_URL` in the
  frontend and `--port` in the sidecar launch together.
- **Backslashes/drives:** the API always exchanges `/`-separated relative URLs; absolute paths only appear in
  settings and the folder picker, which lists drive letters on Windows.
- **Auto-updates** are not configured (`tauri-plugin-updater` would be the next step).
