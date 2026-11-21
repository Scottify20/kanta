import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import librosa
import numpy as np

from app.services import vocal_analysis


class VocalAnalysisTests(unittest.TestCase):
    def test_analysis_filters_unvoiced_and_low_confidence_frames(self):
        pitch_values = np.linspace(100.0, 300.0, 120)
        pitches = np.concatenate((pitch_values, [50.0, 900.0]))
        voiced_flags = np.array([True] * 120 + [False, True])
        voiced_probs = np.array([0.9] * 120 + [0.99, 0.64])
        with (
            patch.object(vocal_analysis, "_get_librosa", return_value=librosa),
            patch.object(librosa, "load", return_value=(np.ones(1000), 22050)),
            patch.object(
                librosa,
                "pyin",
                return_value=(pitches, voiced_flags, voiced_probs),
            ) as pyin,
        ):
            result = vocal_analysis.analyze_vocal_range(Path("vocals.wav"))

        self.assertIsNotNone(result)
        self.assertAlmostEqual(result["min_hz"], np.percentile(pitch_values, 5))
        self.assertAlmostEqual(result["max_hz"], np.percentile(pitch_values, 95))
        self.assertEqual(pyin.call_count, 1)
        self.assertTrue(np.array_equal(pyin.call_args.args[0], np.ones(1000)))
        self.assertEqual(pyin.call_args.kwargs, {
            "fmin": 50.0,
            "fmax": 1100.0,
            "sr": 22050,
            "frame_length": 2048,
            "hop_length": 512,
        })
        self.assertEqual(result["min_note"], librosa.midi_to_note(
            int(round(librosa.hz_to_midi(result["min_hz"])))
        ))
        self.assertLess(result["tessitura_min_hz"], result["tessitura_max_hz"])
        self.assertIn(result["voice_type"], {
            "Bass", "Baritone", "Tenor", "Alto", "Mezzo-Soprano", "Soprano",
        })

    def test_instrumental_fallback_when_fewer_than_100_frames_are_voiced(self):
        with (
            patch.object(vocal_analysis, "_get_librosa", return_value=librosa),
            patch.object(librosa, "load", return_value=(np.ones(1000), 22050)),
            patch.object(
                librosa,
                "pyin",
                return_value=(
                    np.full(99, 220.0),
                    np.ones(99, dtype=bool),
                    np.ones(99),
                ),
            ),
        ):
            self.assertIsNone(vocal_analysis.analyze_vocal_range(Path("instrumental.wav")))

    def test_sidecar_update_preserves_existing_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            song_dir = Path(temp)
            sidecar = song_dir / ".kanta.json"
            sidecar.write_text(
                json.dumps({"date_added": 123.0, "custom": {"keep": True}}),
                encoding="utf-8",
            )
            expected_range = {
                "min_hz": 100.0,
                "max_hz": 300.0,
                "voice_type": "Alto",
            }
            with patch.object(
                vocal_analysis, "analyze_vocal_range", return_value=expected_range
            ):
                result = vocal_analysis.analyze_and_save_vocal_range(
                    song_dir, song_dir / "stems" / "Song (Vocals).mp3"
                )

            saved = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(result, expected_range)
            self.assertEqual(saved["date_added"], 123.0)
            self.assertEqual(saved["custom"], {"keep": True})
            self.assertEqual(saved["vocal_range"], expected_range)

    def test_key_and_bpm_analysis_returns_camelot_key_and_rounded_tempo(self):
        major_profile = vocal_analysis._KEY_PROFILES["Major"]
        chroma = np.tile(major_profile[:, np.newaxis], (1, 4))
        with (
            patch.object(vocal_analysis, "_get_librosa", return_value=librosa),
            patch.object(librosa, "load", return_value=(np.ones(1000), 22050)),
            patch.object(librosa.beat, "beat_track", return_value=(np.array([123.6]), [])),
            patch.object(librosa.feature, "chroma_cqt", return_value=chroma),
        ):
            result = vocal_analysis.analyze_track_metadata(Path("master.wav"))

        self.assertEqual(result, {
            "bpm": 124,
            "musical_key": "C",
            "musical_key_mode": "Major",
            "camelot_key": "8B",
        })

    def test_minor_key_maps_to_minor_camelot_wheel_code(self):
        minor_profile = np.roll(vocal_analysis._KEY_PROFILES["Minor"], 9)
        chroma = np.tile(minor_profile[:, np.newaxis], (1, 3))
        with (
            patch.object(vocal_analysis, "_get_librosa", return_value=librosa),
            patch.object(librosa, "load", return_value=(np.ones(1000), 22050)),
            patch.object(librosa.feature, "chroma_cqt", return_value=chroma),
        ):
            result = vocal_analysis.analyze_track_metadata(
                Path("instrumental.wav"), analyze_musical_key=True, analyze_bpm=False
            )

        self.assertEqual(result, {
            "musical_key": "Am",
            "musical_key_mode": "Minor",
            "camelot_key": "8A",
        })

    def test_key_uses_lead_vocals_while_tempo_uses_master(self):
        lead_samples = np.full(1000, 0.25)
        master_samples = np.full(1000, 0.75)
        chroma = np.tile(
            vocal_analysis._KEY_PROFILES["Major"][:, np.newaxis], (1, 4)
        )
        with (
            patch.object(vocal_analysis, "_get_librosa", return_value=librosa),
            patch.object(
                librosa,
                "load",
                side_effect=[
                    (lead_samples, 22050),
                    (master_samples, 22050),
                ],
            ) as load,
            patch.object(
                librosa.beat, "beat_track", return_value=(np.array([120.0]), [])
            ) as beat_track,
            patch.object(librosa.feature, "chroma_cqt", return_value=chroma) as chroma_cqt,
        ):
            result = vocal_analysis.analyze_track_metadata(
                Path("lead.wav"),
                analyze_musical_key=True,
                analyze_bpm=True,
                bpm_audio_path=Path("master.wav"),
            )

        self.assertEqual([call.args[0] for call in load.call_args_list], [
            Path("lead.wav"),
            Path("master.wav"),
        ])
        self.assertIs(chroma_cqt.call_args.kwargs["y"], lead_samples)
        self.assertIs(beat_track.call_args.kwargs["y"], master_samples)
        self.assertEqual(result["musical_key"], "C")
        self.assertEqual(result["bpm"], 120)

    def test_key_and_bpm_sidecar_update_preserves_existing_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            song_dir = Path(temp)
            sidecar = song_dir / ".kanta.json"
            sidecar.write_text(
                json.dumps({"date_added": 42.0, "custom": "keep"}),
                encoding="utf-8",
            )
            result = {"musical_key": "D", "musical_key_mode": "Major", "camelot_key": "10B", "bpm": 96}
            with patch.object(vocal_analysis, "analyze_track_metadata", return_value=result):
                saved = vocal_analysis.analyze_and_save_track_metadata(
                    song_dir, song_dir / "master.wav"
                )

            data = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(saved, result)
            self.assertEqual(data["date_added"], 42.0)
            self.assertEqual(data["custom"], "keep")
            self.assertEqual(data["musical_key"], "D")
            self.assertEqual(data["camelot_key"], "10B")
            self.assertEqual(data["bpm"], 96)


if __name__ == "__main__":
    unittest.main()
