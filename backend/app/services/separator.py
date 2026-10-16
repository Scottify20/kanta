import shutil
from pathlib import Path
from typing import Optional
import mutagen
from audio_separator.separator import Separator
import tqdm

from app.tasks import check_cancellation_and_update
from app.services.metadata import (
    extract_metadata_and_setup_dirs,
    create_compressed_original_with_cover,
    convert_and_tag_stem,
)
from app.services.lyrics import fetch_and_save_lyrics
from app.services.settings import (
    audio_extension,
    device_availability,
    get_inference_device,
    get_model_dir,
    get_output_dir,
)

TEMP_DIR = Path("temp_processing")


class TaskProgressTqdm(tqdm.tqdm):
    """Interception wrapper for tqdm to update tasks_db during audio-separator inference."""
    _current_task_id: Optional[str] = None
    _start_pct: int = 0
    _end_pct: int = 100
    _step_prefix: str = "Processing"

    @classmethod
    def set_task_context(cls, task_id: Optional[str], start_pct: int, end_pct: int, prefix: str):
        cls._current_task_id = task_id
        cls._start_pct = start_pct
        cls._end_pct = end_pct
        cls._step_prefix = prefix

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
        return displayed


# Patch tqdm globally for audio-separator calls
tqdm.tqdm = TaskProgressTqdm


def _create_separator() -> Separator:
    separator = Separator(
        model_file_dir=str(get_model_dir()), output_dir=str(TEMP_DIR), output_format="wav"
    )
    _apply_inference_device(separator)
    return separator


def _apply_inference_device(separator: Separator) -> None:
    """Override audio-separator's auto-detected device with the configured one."""
    device = get_inference_device()
    if device == "cpu":
        separator.torch_device = separator.torch_device_cpu
        separator.onnx_execution_provider = ["CPUExecutionProvider"]
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


def run_basic_pipeline(input_file_path: Path, task_id: Optional[str] = None) -> Path:
    ext = audio_extension()
    check_cancellation_and_update(task_id, "Extracting audio metadata...", 5)
    audio_info = mutagen.File(input_file_path)

    output_root = get_output_dir()
    temp_song_dir = output_root / "temp" / input_file_path.stem
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

    separator = _create_separator()
    separator.load_model("model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    pass1_files = separator.separate(str(input_file_path))

    check_cancellation_and_update(task_id, "Converting stems...", 85)
    convert_and_tag_stem(
        TEMP_DIR / pass1_files[0],
        stems_dir / f"{title} (Instrumental){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Instrumental)",
        input_file_path,
        cover_path,
    )
    convert_and_tag_stem(
        TEMP_DIR / pass1_files[1],
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
    ext = audio_extension()
    check_cancellation_and_update(task_id, "Extracting metadata...", 5)
    audio_info = mutagen.File(input_file_path)

    output_root = get_output_dir()
    temp_song_dir = output_root / "temp" / input_file_path.stem
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
    create_compressed_original_with_cover(
        input_file_path,
        final_song_dir / f"{title}{ext}",
        cover_path,
        raw_artist,
        raw_album,
        raw_title,
    )

    separator = _create_separator()

    # Pass 1: BS-RoFormer (15% -> 40%)
    TaskProgressTqdm.set_task_context(task_id, 15, 40, "Pass 1/3 (BS-RoFormer)")
    separator.load_model("model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    pass1_files = separator.separate(str(input_file_path))
    vocal_pass2_input = TEMP_DIR / f"vocal_temp_{task_id or 'default'}.wav"
    shutil.copy(TEMP_DIR / pass1_files[1], vocal_pass2_input)

    convert_and_tag_stem(
        TEMP_DIR / pass1_files[0],
        stems_dir / f"{title} (Instrumental){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Instrumental)",
        input_file_path,
        cover_path,
    )
    convert_and_tag_stem(
        TEMP_DIR / pass1_files[1],
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
    pass2_files = separator.separate(str(vocal_pass2_input))
    convert_and_tag_stem(
        TEMP_DIR / pass2_files[1],
        stems_dir / f"{title} (Lead Vocals){ext}",
        raw_artist,
        raw_album,
        f"{raw_title} (Lead Vocals)",
        input_file_path,
        cover_path,
    )
    convert_and_tag_stem(
        TEMP_DIR / pass2_files[0],
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
    pass3_files = separator.separate(str(input_file_path))
    for file_name in pass3_files:
        wav_file = TEMP_DIR / file_name
        stem_type = file_name.split("_(")[-1].split(")")[0].title()
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