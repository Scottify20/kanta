import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.routes.artists import router
from app.services import artist_info


def image_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(buffer, format="PNG")
    return buffer.getvalue()


class ArtistPhotoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.first = self.root / "first"
        self.second = self.root / "second"
        self.first_artist = self.first / "Artist Folder"
        self.second_artist = self.second / "Artist Folder"
        self.first_artist.mkdir(parents=True)
        self.second_artist.mkdir(parents=True)
        self.roots = patch.object(artist_info, "get_output_dirs", return_value=[self.first, self.second])
        self.roots.start()
        self.cache = patch.object(artist_info, "CACHE_FILE", self.root / "artist_info.json")
        self.cache.start()
        self.photo_dir = patch.object(artist_info, "PHOTO_DIR", self.root / "artist_photos")
        self.photo_dir.start()

    def tearDown(self):
        self.photo_dir.stop()
        self.cache.stop()
        self.roots.stop()
        self.tmp.cleanup()

    def test_cached_url_populates_all_artist_folders_and_returns_local_url(self):
        remote = "https://www.theaudiodb.com/photo"
        data = {"name": "Display Name", "bio": "Bio", "photo_url": remote, "source_url": None, "sources": []}
        artist_info.atomic_write_json(artist_info.CACHE_FILE, {"display name": {"ts": artist_info.time.time(), "data": data}})
        with patch.object(artist_info, "_download_photo", return_value=(image_bytes(), ".png")) as download:
            result = artist_info.get_artist_info("Display Name", "Artist Folder", "http://localhost:8004/")
        download.assert_called_once_with(remote)
        photo_id = artist_info._photo_id("Display Name")
        self.assertEqual((self.root / "artist_photos" / f"{photo_id}.png").read_bytes(), image_bytes())
        self.assertEqual(result["photo_url"], f"http://localhost:8004/api/artists/photo/{photo_id}")
        self.assertEqual(artist_info._load()["display name"]["data"]["photo_url"], remote)

    def test_existing_photo_is_preserved_and_copied_without_download(self):
        (self.first_artist / "artist.png").write_bytes(image_bytes())
        with patch.object(artist_info, "_download_photo") as download:
            url = artist_info._local_photo(
                "Artist Folder", "Artist Folder", "https://www.theaudiodb.com/photo", "http://localhost"
            )
        download.assert_not_called()
        photo_id = artist_info._photo_id("Artist Folder")
        self.assertEqual((self.root / "artist_photos" / f"{photo_id}.png").read_bytes(), image_bytes())
        self.assertEqual(url, f"http://localhost/api/artists/photo/{photo_id}")

    def test_missing_folder_and_download_failures_do_not_create_folders(self):
        with patch.object(artist_info, "_download_photo", side_effect=ValueError("bad photo")):
            self.assertIsNone(artist_info._local_photo("Missing", None, "https://www.theaudiodb.com/photo", "http://localhost"))
            self.assertIsNone(artist_info._local_photo("Other Artist", "Artist Folder", "https://www.theaudiodb.com/photo", "http://localhost"))
        self.assertFalse((self.first / "Missing").exists())
        self.assertFalse((self.first_artist / "artist.png").exists())

    def test_collaborator_does_not_inherit_the_folder_artist_photo(self):
        (self.first_artist / "artist.png").write_bytes(image_bytes())
        with patch.object(artist_info, "_download_photo", return_value=(image_bytes(), ".png")) as download:
            url = artist_info._local_photo(
                "Collaborating Artist", "Artist Folder", "https://www.theaudiodb.com/photo", "http://localhost"
            )
        download.assert_called_once()
        photo_id = artist_info._photo_id("Collaborating Artist")
        self.assertEqual(url, f"http://localhost/api/artists/photo/{photo_id}")
        self.assertTrue((self.root / "artist_photos" / f"{photo_id}.png").is_file())

    def test_artist_photo_can_be_saved_without_an_artist_folder(self):
        remote = "https://www.theaudiodb.com/photo"
        data = {"name": "Solo Artist", "bio": "Bio", "photo_url": remote, "source_url": None, "sources": []}
        with patch.object(artist_info, "_lookup", return_value=data), patch.object(
            artist_info, "_download_photo", return_value=(image_bytes(), ".png")
        ):
            result = artist_info.get_artist_info("Solo Artist", None, "http://localhost")
        photo_id = artist_info._photo_id("Solo Artist")
        self.assertEqual(result["photo_url"], f"http://localhost/api/artists/photo/{photo_id}")
        self.assertTrue((self.root / "artist_photos" / f"{photo_id}.png").is_file())

    def test_rejects_traversal_and_symlinked_artist_folders(self):
        for folder in ("../outside", r"..\outside", ".", ".."):
            with self.assertRaises(ValueError):
                artist_info._artist_dirs(folder)
        outside = self.root / "outside"
        outside.mkdir()
        (self.first / "Link").symlink_to(outside, target_is_directory=True)
        self.assertEqual(artist_info._artist_dirs("Link"), [])

    def test_download_checks_host_and_image_content(self):
        with self.assertRaises(ValueError):
            artist_info._download_photo("https://example.com/image")
        url = "https://www.theaudiodb.com/photo"
        response = httpx.Response(200, content=image_bytes(), request=httpx.Request("GET", url))
        with patch.object(httpx, "stream") as stream:
            stream.return_value.__enter__.return_value = response
            data, suffix = artist_info._download_photo(url)
        self.assertEqual((data, suffix), (image_bytes(), ".png"))
        response = httpx.Response(200, content=b"not an image", request=httpx.Request("GET", url))
        with patch.object(httpx, "stream") as stream:
            stream.return_value.__enter__.return_value = response
            with self.assertRaises(OSError):
                artist_info._download_photo(url)

    def test_api_passes_folder_and_base_url_and_rejects_traversal(self):
        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client, patch("app.routes.artists.get_artist_info", return_value={"photo_url": None}) as lookup:
            response = client.get("/api/artists/info", params={"name": "Display Name", "folder": "Artist Folder"})
            self.assertEqual(response.status_code, 200)
            lookup.assert_called_once_with("Display Name", "Artist Folder", "http://testserver/")
            response = client.get("/api/artists/info", params={"name": "Display Name", "folder": "../escape"})
            self.assertEqual(response.status_code, 422)
            lookup.assert_called_once()

    def test_api_serves_only_known_cached_artist_photos(self):
        app = FastAPI()
        app.include_router(router)
        photo_id = artist_info._photo_id("Display Name")
        (self.root / "artist_photos").mkdir()
        (self.root / "artist_photos" / f"{photo_id}.png").write_bytes(image_bytes())
        with TestClient(app) as client:
            response = client.get(f"/api/artists/photo/{photo_id}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/png")
            response = client.get("/api/artists/photo/../../etc/passwd")
            self.assertNotEqual(response.status_code, 200)

    def test_failed_download_keeps_remote_url_and_logs_warning(self):
        data = {"name": "Artist", "bio": None, "photo_url": "https://www.theaudiodb.com/photo", "source_url": None, "sources": []}
        with (
            patch.object(artist_info, "_lookup", return_value=data),
            patch.object(artist_info, "_download_photo", side_effect=httpx.ConnectError("offline")),
            self.assertLogs("uvicorn", level="WARNING"),
        ):
            result = artist_info.get_artist_info("Artist", "Artist Folder", "http://localhost")
        self.assertEqual(result["photo_url"], data["photo_url"])


if __name__ == "__main__":
    unittest.main()
