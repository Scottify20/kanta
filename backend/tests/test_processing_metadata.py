import shutil
import tempfile
import unittest
import io
from pathlib import Path
from unittest.mock import patch

from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TIT2, TPE1, TALB, TXXX
from mutagen.mp4 import MP4
from PIL import Image

from app.services.metadata import (
    convert_and_tag_stem,
    create_compressed_original_with_cover,
    extract_metadata_and_setup_dirs,
    extract_raw_metadata,
)
from app.services.paths import run_ffmpeg


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
class ProcessingMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        image = io.BytesIO()
        Image.new("RGB", (2, 2), "red").save(image, format="PNG")
        self.picture = image.getvalue()
        self.wav = self.root / "source.wav"
        run_ffmpeg(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1",
                    "-y", str(self.wav)])

    def make_source(self, extension):
        source = self.root / f"source.{extension}"
        run_ffmpeg(["-v", "error", "-y", "-i", str(self.wav), str(source)])
        if extension == "flac":
            audio = FLAC(source)
            audio["artist"] = ["First artist", "Second artist"]
            audio["album"] = ["Album"]
            audio["title"] = ["Real title"]
            audio["composer"] = ["First composer", "Second composer"]
            audio["custom_tag"] = ["first", "second"]
            for label, kind in (("front", 3), ("back", 4)):
                picture = Picture()
                picture.type = kind
                picture.mime = "image/png"
                picture.desc = label
                picture.data = self.picture
                audio.add_picture(picture)
            audio.save()
        else:
            tags = ID3(source)
            tags.add(TPE1(encoding=3, text=["First artist", "Second artist"]))
            tags.add(TALB(encoding=3, text=["Album"]))
            tags.add(TIT2(encoding=3, text=["Real title"]))
            tags.add(TXXX(encoding=3, desc="custom", text=["first", "second"]))
            tags.add(APIC(encoding=3, mime="image/png", type=3, desc="front", data=self.picture))
            tags.save()
        return source

    def test_mp3_metadata_names_are_read_for_queue_and_processing(self):
        source = self.make_source("mp3")
        raw = extract_raw_metadata(source)
        self.assertEqual((raw["raw_artist"], raw["raw_album"], raw["raw_title"]),
                         ("First artist", "Album", "Real title"))
        extracted = extract_metadata_and_setup_dirs(source, self.root / "song")
        self.assertEqual(extracted[:3], ("First artist", "Album", "Real title"))

    def test_native_tags_preserved_in_master_and_stem(self):
        for extension in ("mp3", "flac"):
            with self.subTest(extension=extension):
                source = self.make_source(extension)
                master = self.root / f"master.{extension}"
                stem = self.root / f"stem.{extension}"
                stem_input = self.root / f"stem-{extension}.wav"
                shutil.copyfile(self.wav, stem_input)
                with patch("app.services.metadata.get_output_quality", return_value="standard"):
                    create_compressed_original_with_cover(source, master, self.root / "missing.jpg",
                                                          "First artist", "Album", "Real title")
                    convert_and_tag_stem(stem_input, stem, "First artist", "Album",
                                         "Real title (Vocals)", source, self.root / "missing.jpg")
                if extension == "flac":
                    for path in (master, stem):
                        tags = FLAC(path)
                        self.assertEqual(tags["artist"], ["First artist", "Second artist"])
                        self.assertEqual(tags["composer"], ["First composer", "Second composer"])
                        self.assertEqual(tags["custom_tag"], ["first", "second"])
                        self.assertEqual([picture.desc for picture in tags.pictures], ["front", "back"])
                    self.assertEqual(FLAC(master)["title"], ["Real title"])
                    self.assertEqual(FLAC(stem)["title"], ["Real title (Vocals)"])
                else:
                    for path in (master, stem):
                        tags = ID3(path)
                        self.assertEqual(tags["TPE1"].text, ["First artist", "Second artist"])
                        self.assertEqual(tags["TXXX:custom"].text, ["first", "second"])
                        self.assertEqual(tags.getall("APIC")[0].data, self.picture)
                    self.assertEqual(ID3(master)["TIT2"].text, ["Real title"])
                    self.assertEqual(ID3(stem)["TIT2"].text, ["Real title (Vocals)"])

    def test_cross_format_preserves_compatible_tags_and_cover(self):
        for source_ext, output_ext in (("flac", "mp3"), ("mp3", "flac")):
            with self.subTest(source=source_ext, output=output_ext):
                source = self.make_source(source_ext)
                song_dir = self.root / f"song-{source_ext}"
                raw_artist, raw_album, raw_title, _, _, _, _, cover = extract_metadata_and_setup_dirs(source, song_dir)
                output = self.root / f"cross.{output_ext}"
                create_compressed_original_with_cover(source, output, cover, raw_artist, raw_album, raw_title)
                stem_input = self.root / f"cross-{source_ext}.wav"
                shutil.copyfile(self.wav, stem_input)
                stem = self.root / f"cross-stem.{output_ext}"
                convert_and_tag_stem(stem_input, stem, raw_artist, raw_album,
                                     "Real title (Vocals)", source, cover)
                for path, title in ((output, "Real title"), (stem, "Real title (Vocals)")):
                    if output_ext == "mp3":
                        tags = ID3(path)
                        self.assertEqual(tags["TIT2"].text, [title])
                        self.assertEqual(tags["TPE1"].text, ["First artist", "Second artist"])
                        self.assertEqual(tags["TXXX:custom_tag"].text, ["first", "second"])
                        self.assertEqual(len(tags.getall("APIC")), 2)
                    else:
                        tags = FLAC(path)
                        self.assertEqual(tags["title"], [title])
                        self.assertEqual(tags["artist"], ["First artist", "Second artist"])
                        self.assertEqual(tags["custom"], ["first", "second"])
                        self.assertEqual(tags.pictures[0].data, self.picture)

    def test_m4a_source_preserves_standard_metadata(self):
        source = self.root / "source.m4a"
        run_ffmpeg(["-v", "error", "-y", "-i", str(self.wav), "-c:a", "aac", str(source)])
        tags = MP4(source)
        tags["\xa9ART"] = ["First artist", "Second artist"]
        tags["\xa9alb"] = ["Album"]
        tags["\xa9nam"] = ["Real title"]
        tags["\xa9wrt"] = ["Composer"]
        tags.save()
        names = extract_raw_metadata(source)
        self.assertEqual(names["raw_title"], "Real title")
        for extension in ("mp3", "flac"):
            output = self.root / f"m4a-master.{extension}"
            create_compressed_original_with_cover(
                source, output, self.root / "missing.jpg", "First artist", "Album", "Real title"
            )
            if extension == "mp3":
                converted = ID3(output)
                self.assertEqual(converted["TPE1"].text, ["First artist", "Second artist"])
                self.assertEqual(converted["TCOM"].text, ["Composer"])
            else:
                converted = FLAC(output)
                self.assertEqual(converted["artist"], ["First artist", "Second artist"])
                self.assertEqual(converted["composer"], ["Composer"])
