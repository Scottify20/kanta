"""Pitch-range analysis for separated vocal stems, including per-singer duet ranges."""
import gc
import json
from pathlib import Path
from typing import Any, Optional
import xml.etree.ElementTree as ET

import numpy as np

from app.services.fsutil import atomic_write_json

SAMPLE_RATE = 22050
HOP_LENGTH = 512
MIN_VOICED_FRAMES = 100
MIN_DUET_PART_VOICED_FRAMES = 25
VOICED_PROBABILITY_THRESHOLD = 0.65
_TESSITURA_INSET = 0.175
_PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_KEY_PROFILES = {
    "Major": np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
    "Minor": np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
}
_CAMELOT_MAJOR = (8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1)
_CAMELOT_MINOR = (5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10)


def _get_librosa():
    import librosa

    return librosa


def _note_name(midi_note: float) -> str:
    return _get_librosa().midi_to_note(int(round(midi_note)))


def _voice_type(tessitura_midpoint: float) -> str:
    if tessitura_midpoint < 48:
        return "Bass"
    if tessitura_midpoint < 53:
        return "Baritone"
    if tessitura_midpoint < 59:
        return "Tenor"
    if tessitura_midpoint < 64:
        return "Alto"
    if tessitura_midpoint < 69:
        return "Mezzo-Soprano"
    return "Soprano"


def _summarize_pitches(
    voiced_pitches: np.ndarray,
    min_frames: int = MIN_VOICED_FRAMES,
) -> Optional[dict[str, Any]]:
    if voiced_pitches.size < min_frames:
        return None
    librosa = _get_librosa()
    min_hz, max_hz = np.percentile(voiced_pitches, [5, 95])
    min_midi, max_midi = librosa.hz_to_midi([min_hz, max_hz])
    tessitura_min_midi = min_midi + (max_midi - min_midi) * _TESSITURA_INSET
    tessitura_max_midi = max_midi - (max_midi - min_midi) * _TESSITURA_INSET
    tessitura_midpoint = (tessitura_min_midi + tessitura_max_midi) / 2

    return {
        "min_hz": float(min_hz),
        "max_hz": float(max_hz),
        "min_note": _note_name(min_midi),
        "max_note": _note_name(max_midi),
        "tessitura_min_hz": float(librosa.midi_to_hz(tessitura_min_midi)),
        "tessitura_max_hz": float(librosa.midi_to_hz(tessitura_max_midi)),
        "tessitura_min_note": _note_name(tessitura_min_midi),
        "tessitura_max_note": _note_name(tessitura_max_midi),
        "voice_type": _voice_type(tessitura_midpoint),
    }


def _parse_ttml_time(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    raw = value.strip()
    if raw.endswith("s"):
        try:
            return float(raw[:-1])
        except ValueError:
            return None
    try:
        parts = [float(p) for p in raw.split(":")]
    except ValueError:
        return None
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0] if parts else None


def _extract_duet_intervals(song_dir: Path) -> Optional[dict[str, list[tuple[float, float]]]]:
    """Extract (begin_s, end_s) intervals for primary (v1) and secondary (v2) duet agents from TTML."""
    lyrics_dir = song_dir / "lyrics"
    if not lyrics_dir.is_dir():
        return None
    ttml_files = sorted(lyrics_dir.glob("*.ttml"), key=lambda p: p.name.casefold())
    if not ttml_files:
        return None

    try:
        root = ET.fromstring(ttml_files[0].read_text(encoding="utf-8", errors="replace"))
    except (OSError, ET.ParseError):
        return None

    agents: dict[str, str] = {}
    paragraphs: list[tuple[str, float, Optional[float]]] = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1].lower()
        attrs = {k.rsplit("}", 1)[-1].lower(): v for k, v in el.attrib.items()}
        if tag == "agent" and attrs.get("id"):
            agents[attrs["id"]] = attrs.get("type", "").lower()
        elif tag == "p" and attrs.get("agent") and attrs.get("begin"):
            begin_s = _parse_ttml_time(attrs.get("begin"))
            end_s = _parse_ttml_time(attrs.get("end"))
            if begin_s is not None:
                paragraphs.append((attrs["agent"], begin_s, end_s))

    if not paragraphs:
        return None

    person_agents = [aid for aid, kind in agents.items() if kind in {"person", "character"}]
    primary_id = person_agents[0] if person_agents else "v1"
    secondary_ids = set(person_agents[1:]) if len(person_agents) > 1 else {"v2", "v3"}

    v1_intervals: list[tuple[float, float]] = []
    v2_intervals: list[tuple[float, float]] = []

    for idx, (agent, begin_s, end_s) in enumerate(paragraphs):
        if end_s is None or end_s <= begin_s:
            next_begin = paragraphs[idx + 1][1] if idx + 1 < len(paragraphs) else begin_s + 4.0
            end_s = max(begin_s + 0.5, min(next_begin, begin_s + 8.0))
        if agent == primary_id:
            v1_intervals.append((begin_s, end_s))
        elif agent in secondary_ids:
            v2_intervals.append((begin_s, end_s))

    if not v1_intervals or not v2_intervals:
        return None
    return {"v1": v1_intervals, "v2": v2_intervals}


def _analyze_pitches(audio_path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    librosa = _get_librosa()
    samples = None
    try:
        samples, _ = librosa.load(audio_path, sr=SAMPLE_RATE, mono=True)
        pitches, voiced_flag, voiced_probs = librosa.pyin(
            samples,
            fmin=50.0,
            fmax=1100.0,
            sr=SAMPLE_RATE,
            frame_length=2048,
            hop_length=HOP_LENGTH,
        )
        pitches_arr = np.asarray(pitches)
        voiced_mask = (
            np.asarray(voiced_flag, dtype=bool)
            & (np.asarray(voiced_probs) >= VOICED_PROBABILITY_THRESHOLD)
            & np.isfinite(pitches_arr)
            & (pitches_arr > 0)
        )
        times = librosa.frames_to_time(np.arange(pitches_arr.size), sr=SAMPLE_RATE, hop_length=HOP_LENGTH)
        return pitches_arr, voiced_mask, times
    finally:
        del samples
        gc.collect()


def analyze_vocal_range(audio_path: Path) -> Optional[dict[str, Any]]:
    """Estimate a stem's vocal pitch boundaries, returning None when it is unvoiced."""
    pitches_arr, voiced_mask, _ = _analyze_pitches(audio_path)
    return _summarize_pitches(pitches_arr[voiced_mask], MIN_VOICED_FRAMES)


def _compute_duet_part_ranges(
    song_dir: Path,
    pitches_arr: np.ndarray,
    voiced_mask: np.ndarray,
    times: np.ndarray,
) -> Optional[dict[str, Optional[dict[str, Any]]]]:
    intervals = _extract_duet_intervals(song_dir)
    if not intervals:
        return None

    result: dict[str, Optional[dict[str, Any]]] = {}
    for part in ("v1", "v2"):
        part_mask = np.zeros(times.size, dtype=bool)
        for start_s, end_s in intervals[part]:
            part_mask |= (times >= start_s) & (times <= end_s)
        combined = voiced_mask & part_mask
        result[part] = _summarize_pitches(pitches_arr[combined], MIN_DUET_PART_VOICED_FRAMES)

    return result if (result.get("v1") or result.get("v2")) else None


def analyze_track_metadata(
    audio_path: Path,
    analyze_musical_key: bool = True,
    analyze_bpm: bool = True,
    bpm_audio_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Estimate key from the selected vocal stem and BPM from master/instrumental audio."""
    if not analyze_musical_key and not analyze_bpm:
        raise ValueError("Select key or BPM analysis.")

    librosa = _get_librosa()
    samples = None
    bpm_samples = None
    try:
        if analyze_musical_key or (
            analyze_bpm and (bpm_audio_path is None or bpm_audio_path == audio_path)
        ):
            samples, _ = librosa.load(audio_path, sr=SAMPLE_RATE, mono=True)
        result: dict[str, Any] = {}

        if analyze_bpm:
            if bpm_audio_path is not None and bpm_audio_path != audio_path:
                bpm_samples, _ = librosa.load(bpm_audio_path, sr=SAMPLE_RATE, mono=True)
            else:
                bpm_samples = samples
            tempo, _ = librosa.beat.beat_track(y=bpm_samples, sr=SAMPLE_RATE)
            tempo_value = tempo[0] if isinstance(tempo, (list, np.ndarray)) else tempo
            result["bpm"] = int(round(float(tempo_value)))

        if analyze_musical_key:
            chroma = librosa.feature.chroma_cqt(y=samples, sr=SAMPLE_RATE)
            chroma_avg = np.mean(chroma, axis=1)
            if chroma_avg.shape != (12,):
                raise ValueError("Chroma analysis did not return 12 pitch classes.")

            if float(np.std(chroma_avg)) == 0.0:
                best: tuple[float, int, str] = (float("-inf"), 0, "Major")
            else:
                best = (float("-inf"), 0, "Major")
                for mode, profile in _KEY_PROFILES.items():
                    for tonic in range(12):
                        correlation = float(np.corrcoef(chroma_avg, np.roll(profile, tonic))[0, 1])
                        if np.isfinite(correlation) and correlation > best[0]:
                            best = (correlation, tonic, mode)

            if not np.isfinite(best[0]):
                result.update({
                    "musical_key": None,
                    "musical_key_mode": None,
                    "camelot_key": None,
                })
            else:
                _, tonic, mode = best
                pitch_class = _PITCH_CLASSES[tonic]
                result.update({
                    "musical_key": pitch_class if mode == "Major" else f"{pitch_class}m",
                    "musical_key_mode": mode,
                    "camelot_key": (
                        f"{_CAMELOT_MAJOR[tonic]}B"
                        if mode == "Major"
                        else f"{_CAMELOT_MINOR[tonic]}A"
                    ),
                })

        return result
    finally:
        del samples, bpm_samples
        gc.collect()


def _read_sidecar(song_dir: Path) -> dict[str, Any]:
    sidecar = song_dir / ".kanta.json"
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise ValueError(f"Could not read song sidecar {sidecar}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Song sidecar must contain a JSON object: {sidecar}")
    return data


def analyze_and_save_track_metadata(
    song_dir: Path,
    audio_path: Path,
    analyze_musical_key: bool = True,
    analyze_bpm: bool = True,
    bpm_audio_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Analyze vocal key and master/instrumental BPM, then merge results into the sidecar."""
    analysis = analyze_track_metadata(
        audio_path, analyze_musical_key, analyze_bpm, bpm_audio_path
    )
    data = _read_sidecar(song_dir)
    data.update(analysis)
    atomic_write_json(song_dir / ".kanta.json", data, indent=None)
    return analysis


def analyze_and_save_vocal_range(song_dir: Path, audio_path: Path) -> Optional[dict[str, Any]]:
    """Analyze a vocal stem (plus per-singer v1/v2 duet ranges when TTML agents exist)."""
    pitches_arr, voiced_mask, times = _analyze_pitches(audio_path)
    vocal_range = _summarize_pitches(pitches_arr[voiced_mask], MIN_VOICED_FRAMES)
    duet_ranges = _compute_duet_part_ranges(song_dir, pitches_arr, voiced_mask, times)

    sidecar = song_dir / ".kanta.json"
    data = _read_sidecar(song_dir)
    data["vocal_range"] = vocal_range
    if duet_ranges is not None:
        data["duet_vocal_ranges"] = duet_ranges
    else:
        data.pop("duet_vocal_ranges", None)
    atomic_write_json(sidecar, data, indent=None)
    return vocal_range