import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException, UploadFile
from httpx import ASGITransport, AsyncClient

from app import main
from app.routes import queue
from app.services import separator
from app.services.paths import output_root_for_input, processing_dir, upload_dir


class OutputWorkPathTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_upload_uses_configured_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(main, "get_output_dir", return_value=root):
                result = await main.process_audio_input(
                    UploadFile(filename="song.mp3", file=io.BytesIO(b"audio")), None
                )
            self.assertEqual(result.parent, root / ".kanta" / "uploads")
            self.assertEqual(result.read_bytes(), b"audio")

    async def test_unavailable_output_fails_explicitly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "missing"
            with patch.object(queue, "get_output_dir", return_value=root):
                with self.assertRaises(HTTPException) as raised:
                    await queue.add_to_queue(UploadFile(filename="song.mp3", file=io.BytesIO(b"audio")), 2, None)
            self.assertEqual(raised.exception.status_code, 503)
            self.assertFalse(root.exists())

    async def test_direct_endpoints_keep_original_output_when_default_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            first = Path(temp) / "first"
            second = Path(temp) / "second"
            first.mkdir()
            second.mkdir()
            for endpoint in (main.separate_basic_endpoint, main.separate_full_endpoint):
                async def run(_pipeline, input_path, _task_id):
                    self.assertEqual(input_path.parent, upload_dir(first))
                    return first / "Artist" / "Album" / "Song"

                with patch.object(main, "get_output_dir", side_effect=[first, second]), \
                     patch.object(main, "get_output_dirs", return_value=[first, second]), \
                     patch.object(main.queue_manager, "run_exclusive", new=AsyncMock(side_effect=run)), \
                     patch.object(main.library, "invalidate"):
                    result = await endpoint(
                        UploadFile(filename="song.mp3", file=io.BytesIO(b"audio")), None, None
                    )
                self.assertEqual(result["http_base_url"], "http://127.0.0.1:8000/media-roots/0/Artist/Album/Song")
                self.assertEqual(list(upload_dir(first).iterdir()), [])

    def test_removed_root_has_no_media_url(self):
        first = Path("/first")
        with patch.object(main, "get_output_dir", return_value=Path("/second")), \
             patch.object(main, "get_output_dirs", return_value=[Path("/second")]):
            self.assertIsNone(main._output_http_base_url(first / "Artist", first))

    def test_pipeline_uses_original_root_and_cleans_temp_on_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            first = Path(temp) / "first"
            second = Path(temp) / "second"
            first.mkdir()
            second.mkdir()
            uploaded = upload_dir(first) / "song.mp3"
            legacy = Path(temp) / "old-upload.mp3"
            self.assertEqual(output_root_for_input(uploaded, second), first)
            self.assertEqual(output_root_for_input(legacy, second), second)
            for pipeline, internal in [
                (separator.run_basic_pipeline, "_run_basic_pipeline"),
                (separator.run_karaoke_pipeline, "_run_karaoke_pipeline"),
            ]:
                with self.subTest(pipeline=pipeline.__name__):
                    def fail(_input, root, work, task):
                        self.assertEqual(root, first)
                        self.assertEqual(work.parent, processing_dir(first))
                        (work / "intermediate.wav").write_bytes(b"temp")
                        raise RuntimeError("test failure")

                    with patch.object(separator, "get_output_dir", return_value=second), \
                         patch.object(separator, internal, side_effect=fail):
                        with self.assertRaisesRegex(RuntimeError, "test failure"):
                            pipeline(uploaded, "task")
                    self.assertEqual(list(processing_dir(first).iterdir()), [])
                    self.assertFalse(processing_dir(second).exists())

    def test_pipeline_cleans_temp_on_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_path = upload_dir(root) / "song.mp3"
            for pipeline, internal in [
                (separator.run_basic_pipeline, "_run_basic_pipeline"),
                (separator.run_karaoke_pipeline, "_run_karaoke_pipeline"),
            ]:
                def complete(_input, output, work, task):
                    (work / "intermediate.wav").write_bytes(b"temp")
                    return output / "Artist" / "Album" / "Song"

                with patch.object(separator, "get_output_dir", return_value=root), \
                     patch.object(separator, internal, side_effect=complete):
                    self.assertEqual(pipeline(input_path, "task"), root / "Artist" / "Album" / "Song")
                self.assertEqual(list(processing_dir(root).iterdir()), [])

    def test_pipelines_write_separator_outputs_inside_task_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_path = upload_dir(root) / "song.mp3"
            input_path.parent.mkdir(parents=True)
            input_path.write_bytes(b"audio")
            work_dirs = []

            def metadata(_input, song):
                (song / "stems").mkdir(parents=True)
                (song / "covers").mkdir()
                return ("Artist", "Album", "Song", "Artist", "Album", "Song",
                        song / "stems", song / "covers" / "cover.jpg")

            class FakeSeparator:
                def __init__(self, work):
                    self.work = work
                    self.pass_number = 0

                def load_model(self, _model):
                    self.pass_number += 1

                def separate(self, _input):
                    names = [f"pass{self.pass_number}_({stem}).wav" for stem in ("Instrumental", "Vocals")]
                    for name in names:
                        (self.work / name).write_bytes(b"stem")
                    return names

            def create(work):
                self.assertEqual(work.parent, processing_dir(root))
                work_dirs.append(work)
                return FakeSeparator(work)

            with patch.object(separator, "get_output_dir", return_value=root), \
                 patch.object(separator, "audio_extension", return_value=".mp3"), \
                 patch.object(separator, "check_cancellation_and_update"), \
                 patch.object(separator.mutagen, "File", return_value=None), \
                 patch.object(separator, "extract_metadata_and_setup_dirs", side_effect=metadata), \
                 patch.object(separator, "fetch_and_save_lyrics"), \
                 patch.object(separator, "create_compressed_original_with_cover"), \
                 patch.object(separator, "convert_and_tag_stem"), \
                 patch.object(separator, "_create_separator", side_effect=create):
                for pipeline in (separator.run_basic_pipeline, separator.run_karaoke_pipeline):
                    self.assertEqual(pipeline(input_path), root / "Artist" / "Album" / "Song")
                    self.assertEqual(list(processing_dir(root).iterdir()), [])
            self.assertEqual(len(work_dirs), 2)

    def test_private_work_files_are_not_public_media(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            work = root / ".kanta" / "uploads"
            work.mkdir(parents=True)
            (work / "song.mp3").write_bytes(b"audio")
            self.assertIsNone(main._public_media_path(root, ".kanta/uploads/song.mp3"))
            self.assertIsNone(main._public_media_path(root, ".kanta/library.sqlite3"))
            self.assertIsNotNone(main._public_media_path(root, "Artist/Album/Song.mp3"))

    async def test_media_endpoints_do_not_serve_work_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            work = root / ".kanta" / "uploads"
            work.mkdir(parents=True)
            (work / "song.mp3").write_bytes(b"audio")
            private_paths = [".kanta/uploads/song.mp3"]
            if os.name != "nt":
                (root / "alias").symlink_to(work, target_is_directory=True)
                private_paths.append("alias/song.mp3")
            (root / "public.mp3").write_bytes(b"public")
            static_app = FastAPI()
            static_app.mount("/separated", main.PublicMediaFiles(directory=root))
            with patch.object(main, "get_output_dir", return_value=root), \
                 patch.object(main, "get_output_dirs", return_value=[root]):
                async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
                    for prefix in ("/media", "/media-roots/0"):
                        for path in private_paths:
                            self.assertEqual((await client.get(f"{prefix}/{path}")).status_code, 404)
                        self.assertEqual((await client.get(f"{prefix}/public.mp3")).content, b"public")
                async with AsyncClient(transport=ASGITransport(app=static_app), base_url="http://test") as client:
                    for path in private_paths:
                        self.assertEqual((await client.get(f"/separated/{path}")).status_code, 404)
                    self.assertEqual((await client.get("/separated/public.mp3")).content, b"public")
