import json
import logging
import shutil
import subprocess
import time
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Optional
import tqdm

if TYPE_CHECKING:
    from audio_separator.separator import Separator

from app.tasks import check_cancellation_and_update
from app.services.audio_file import read_audio_file
from app.services.metadata import (
    extract_metadata_and_setup_dirs,
    create_compressed_original_with_cover,
    convert_and_tag_stem,
)
from app.services.lyrics import fetch_and_save_lyrics
from app.services.paths import (
    configure_environment,
    ffprobe_path,
    output_root_for_input,
    processing_dir,
    run_ffmpeg,
    seed_bundled_models,
    subprocess_kwargs,
)
from app.services.storage import ensure_output_root_available
from app.services.settings import (
    audio_extension,
    device_availability,
    get_inference_device,
    get_keep_original,
    get_model_dir,
    get_output_dir,
)


logger = logging.getLogger(__name__)

class TaskProgressTqdm(tqdm.tqdm):
    """Interception wrapper for tqdm to update tasks_db during audio-separator inference."""
    _current_task_id: Optional[str] = None
    _start_pct: int = 0
    _end_pct: int = 100
    _step_prefix: str = "Processing"
    _last_log: float = 0.0

    @classmethod
    def set_task_context(cls, task_id: Optional[str], start_pct: int, end_pct: int, prefix: str):
        cls._current_task_id = task_id
        cls._start_pct = start_pct
        cls._end_pct = end_pct
        cls._step_prefix = prefix
        cls._last_log = 0.0

    def update(self, n=1):
        displayed = super().update(n)
        if self._current_task_id and self.total:
            fraction = self.n / self.total
            scaled_pct = int(self._start_pct + fraction * (self._end_pct - self._start_pct))
            
            # Format ETA if available from tqdm rate calculations
            rate = self.format_dict.get("rate")
            remaining = (self.total - self.n) / rate if rate else None
            eta_str = f" - ~{int(remaining)}s left" if remaining and remaining > 0 else ""
            
            step_text = f"{self._step_prefix} [{self.n}/{self.total} chunks]{eta_str}"
            check_cancellation_and_update(self._current_task_id, step_text, scaled_pct)
            now = time.monotonic()
            if rate and (now - self._last_log >= 5 or self.n >= self.total):
                logger.info(
                    "Task %s: %s, %.2f s/it",
                    self._current_task_id, step_text, 1 / rate,
                )
                type(self)._last_log = now
        return displayed


# Patch tqdm globally for audio-separator calls
tqdm.tqdm = TaskProgressTqdm


def _patch_librosa_compat() -> None:
    """audio-separator still calls librosa.get_duration(filename=...), removed in librosa 1.0.

    Without this every stem write fails (the error is swallowed and no stems are produced).
    """
    import inspect
    import librosa

    if getattr(librosa.get_duration, "_kanta_patched", False):
        return
    if "filename" in inspect.signature(librosa.get_duration).parameters:
        return
    original = librosa.get_duration

    def get_duration(*args, filename=None, **kwargs):
        if filename is not None:
            kwargs.setdefault("path", filename)
        return original(*args, **kwargs)

    get_duration._kanta_patched = True  # type: ignore[attr-defined]
    librosa.get_duration = get_duration


def _separate(separator: "Separator", input_path: Path, expected: int, temp_dir: Path) -> list[Path]:
    """Run a separation and return absolute stem paths, failing loudly if nothing was written."""
    try:
        names = separator.separate(str(input_path))
    finally:
        TaskProgressTqdm.set_task_context(None, 0, 100, "Processing")
    paths = [
        Path(n) if Path(n).is_absolute() else temp_dir / n for n in (names or [])
    ]
    missing = [p for p in paths if not p.is_file()]
    if len(paths) < expected or missing:
        raise RuntimeError(
            f"Stem separation produced no usable output for {input_path.name} "
            f"(got {len(paths)} of {expected} files); see the backend log for the cause."
        )
    return paths


def _separator_input_path(input_path: Path, temp_dir: Path) -> Path:
    """Normalize formats that librosa/libsndfile cannot reliably decode for separation."""
    try:
        probe = subprocess.run(
            [
                ffprobe_path(),
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "json",
                str(input_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            **subprocess_kwargs(),
        )
        streams = json.loads(probe.stdout).get("streams", [])
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        raise RuntimeError(f"Could not inspect audio file {input_path.name}: {detail.strip()}") from exc

    codec = streams[0].get("codec_name") if streams else None
    if not codec:
        raise RuntimeError(f"No readable audio stream was found in {input_path.name}.")

    suffix = input_path.suffix.casefold()
    if (
        (suffix == ".flac" and codec == "flac")
        or (suffix == ".mp3" and codec == "mp3")
        or (suffix == ".wav" and codec.startswith("pcm_"))
    ):
        return input_path

    normalized = temp_dir / "separator_input.wav"
    try:
        run_ffmpeg(
            [
                "-v",
                "error",
                "-y",
                "-i",
                str(input_path),
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "44100",
                str(normalized),
            ],
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        raise RuntimeError(f"Could not decode audio file {input_path.name}: {detail.strip()}") from exc
    if not normalized.is_file() or normalized.stat().st_size == 0:
        raise RuntimeError(f"FFmpeg produced no decoded audio for {input_path.name}.")
    return normalized


def _create_separator(temp_dir: Path) -> "Separator":
    # Imported lazily: audio_separator pulls in torch, which would delay API startup by many seconds.
    from audio_separator.separator import Separator

    configure_environment()
    _patch_librosa_compat()
    temp_dir.mkdir(parents=True, exist_ok=True)
    seed_bundled_models(get_model_dir())
    separator = Separator(
        model_file_dir=str(get_model_dir()), output_dir=str(temp_dir), output_format="wav"
    )
    _apply_inference_device(separator)
    return separator


def _apply_inference_device(separator: "Separator") -> None:
    """Override audio-separator's auto-detected device with the configured one."""
    device = get_inference_device()
    if device == "cpu":
        separator.torch_device = separator.torch_device_cpu
        separator.onnx_execution_provider = ["CPUExecutionProvider"]
    elif device == "mps" and device_availability().get("mps"):
        import torch

        separator.torch_device = torch.device("mps")
        separator.onnx_execution_provider = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    elif device == "directml" and device_availability().get("directml"):
        separator.torch_device = separator.torch_device_cpu
        separator.onnx_execution_provider = ["DmlExecutionProvider", "CPUExecutionProvider"]
    elif device == "vulkan" and device_availability().get("vulkan"):
        import torch

        separator.torch_device = torch.device("vulkan")
        separator.onnx_execution_provider = ["CPUExecutionProvider"]
    # "cuda" (or an unavailable choice) keeps audio-separator's own detection.


def _preserve_existing_lyrics(existing_song_dir: Path, temp_song_dir: Path) -> None:
    existing_lyrics_dir = existing_song_dir / "lyrics"
    if not existing_lyrics_dir.is_dir():
        return
    target_lyrics_dir = temp_song_dir / "lyrics"
    target_lyrics_dir.mkdir(parents=True, exist_ok=True)
    for source in existing_lyrics_dir.iterdir():
        if source.is_file() and (
            source.suffix.lower() in {".ttml", ".lrc"}
            or source.name in {"timing.json", ".custom"}
        ):
            shutil.copy2(source, target_lyrics_dir / source.name)


def _copy_input_lyrics(input_file_path: Path, song_dir: Path) -> None:
    for suffix in (".ttml", ".lrc"):
        source = input_file_path.with_suffix(suffix)
        if source.is_file():
            lyrics_dir = song_dir / "lyrics"
            lyrics_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, lyrics_dir / f"uploaded{suffix}")


def run_basic_pipeline(input_file_path: Path, task_id: Optional[str] = None) -> Path:
    output_root = output_root_for_input(input_file_path, get_output_dir())
    ensure_output_root_available(output_root)
    temp_root = processing_dir(output_root)
    temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="basic-", dir=temp_root) as temp:
        return _run_basic_pipeline(input_file_path, output_root, Path(temp), task_id)


def _run_basic_pipeline(input_file_path: Path, output_root: Path, temp_dir: Path, task_id: Optional[str]) -> Path:
    ext = audio_extension()
    check_cancellation_and_update(task_id, "Extracting audio metadata...", 5)
    separator_input = _separator_input_path(input_file_path, temp_dir)
    audio_info = read_audio_file(input_file_path)

    temp_song_dir = temp_dir / "song"
    (
        raw_artist,
        raw_album,
        raw_title,
        artist,
        album,
        title,
        stems_dir,
        cover_path,
    ) = extract_metadata_and_setup_dirs(input_file_path, temp_song_dir)

    final_song_dir = output_root / artist / album / title
    final_song_dir.parent.mkdir(parents=True, exist_ok=True)

    if final_song_dir.exists():
        _preserve_existing_lyrics(final_song_dir, temp_song_dir)
        shutil.rmtree(final_song_dir)
    temp_song_dir.rename(final_song_dir)
    _copy_input_lyrics(input_file_path, final_song_dir)

    stems_dir = final_song_dir / "stems"
    cover_path = final_song_dir / "covers" / "cover.jpg"

    check_cancellation_and_update(task_id, "Fetching lyrics (TTML/LRC)...", 15)
    fetch_and_save_lyrics(
        final_song_dir,
        raw_artist,
        raw_album,
        raw_title,
        title,
        audio_info.info.length if audio_info and audio_info.info else None,
    )

    check_cancellation_and_update(task_id, "Creating original audio...", 25)
    if get_keep_original():
        create_compressed_original_with_cover(
            input_file_path,
            final_song_dir / f"{title}{ext}",
            cover_path,
            raw_artist,
            raw_album,
            raw_title,
        )

    # Attach task context for live tqdm progress (25% -> 80%)
    TaskProgressTqdm.set_task_context(task_id, 25, 80, "BS-RoFormer Separating")

    separator = _create_separator(temp_dir)
    separator.load_model("model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    pass1_files = _separate(separator, separator_input, 2, temp_dir)

    check_cancellation_and_update(task_id, "Converting stems...", 85)
    convert_and_tag_stem(
        pass1_files[0],
        stems_dir / f"{title} (Instrumental){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Instrumental)",
        input_file_path,
        cover_path,
    )
    convert_and_tag_stem(
        pass1_files[1],
        stems_dir / f"{title} (Vocals){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Vocals)",
        input_file_path,
        cover_path,
    )

    check_cancellation_and_update(task_id, "Finalizing...", 95)
    return final_song_dir


def run_karaoke_pipeline(input_file_path: Path, task_id: Optional[str] = None) -> Path:
    output_root = output_root_for_input(input_file_path, get_output_dir())
    ensure_output_root_available(output_root)
    temp_root = processing_dir(output_root)
    temp_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="karaoke-", dir=temp_root) as temp:
        return _run_karaoke_pipeline(input_file_path, output_root, Path(temp), task_id)


def _run_karaoke_pipeline(input_file_path: Path, output_root: Path, temp_dir: Path, task_id: Optional[str]) -> Path:
    ext = audio_extension()
    check_cancellation_and_update(task_id, "Extracting metadata...", 5)
    separator_input = _separator_input_path(input_file_path, temp_dir)
    audio_info = read_audio_file(input_file_path)

    temp_song_dir = temp_dir / "song"
    (
        raw_artist,
        raw_album,
        raw_title,
        artist,
        album,
        title,
        stems_dir,
        cover_path,
    ) = extract_metadata_and_setup_dirs(input_file_path, temp_song_dir)

    final_song_dir = output_root / artist / album / title
    final_song_dir.parent.mkdir(parents=True, exist_ok=True)

    if final_song_dir.exists():
        _preserve_existing_lyrics(final_song_dir, temp_song_dir)
        shutil.rmtree(final_song_dir)
    temp_song_dir.rename(final_song_dir)
    _copy_input_lyrics(input_file_path, final_song_dir)

    stems_dir = final_song_dir / "stems"
    cover_path = final_song_dir / "covers" / "cover.jpg"

    check_cancellation_and_update(task_id, "Fetching lyrics...", 10)
    fetch_and_save_lyrics(
        final_song_dir,
        raw_artist,
        raw_album,
        raw_title,
        title,
        audio_info.info.length if audio_info and audio_info.info else None,
    )

    check_cancellation_and_update(task_id, "Creating master original...", 15)
    if get_keep_original():
        create_compressed_original_with_cover(
            input_file_path,
            final_song_dir / f"{title}{ext}",
            cover_path,
            raw_artist,
            raw_album,
            raw_title,
        )

    separator = _create_separator(temp_dir)

    # Pass 1: BS-RoFormer (15% -> 40%)
    TaskProgressTqdm.set_task_context(task_id, 15, 40, "Pass 1/3 (BS-RoFormer)")
    separator.load_model("model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    pass1_files = _separate(separator, separator_input, 2, temp_dir)
    vocal_pass2_input = temp_dir / "vocal_temp.wav"
    shutil.copy(pass1_files[1], vocal_pass2_input)

    convert_and_tag_stem(
        pass1_files[0],
        stems_dir / f"{title} (Instrumental){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Instrumental)",
        input_file_path,
        cover_path,
    )
    convert_and_tag_stem(
        pass1_files[1],
        stems_dir / f"{title} (Vocals){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Vocals)",
        input_file_path,
        cover_path,
    )

    # Pass 2: Lead/Backing Vocals (40% -> 65%)
    TaskProgressTqdm.set_task_context(task_id, 40, 65, "Pass 2/3 (Karaoke Split)")
    separator.load_model("mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt")
    pass2_files = _separate(separator, vocal_pass2_input, 2, temp_dir)
    convert_and_tag_stem(
        pass2_files[1],
        stems_dir / f"{title} (Lead Vocals){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Lead Vocals)",
        input_file_path,
        cover_path,
    )
    convert_and_tag_stem(
        pass2_files[0],
        stems_dir / f"{title} (Backing Vocals){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Backing Vocals)",
        input_file_path,
        cover_path,
    )
    if vocal_pass2_input.exists():
        vocal_pass2_input.unlink()

    # Pass 3: Multi-Instruments (65% -> 90%)
    TaskProgressTqdm.set_task_context(task_id, 65, 90, "Pass 3/3 (Demucs 6s)")
    separator.load_model("htdemucs_6s.yaml")
    pass3_files = _separate(separator, separator_input, 1, temp_dir)
    for wav_file in pass3_files:
        stem_type = wav_file.name.split("_(")[-1].split(")")[0].title()
        if stem_type.lower() in ["vocals", "instrumental"]:
            if wav_file.exists():
                wav_file.unlink()
            continue
        convert_and_tag_stem(
            wav_file,
            stems_dir / f"{title} ({stem_type}){ext}",
            raw_artist,
            raw_album,
            f"{raw_title} ({stem_type})",
            input_file_path,
            cover_path,
        )

    check_cancellation_and_update(task_id, "Finalizing files...", 95)
    return final_song_dir