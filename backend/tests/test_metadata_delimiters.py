from app.services import settings


def test_metadata_delimiters_default_and_persist(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(
        settings,
        "_cache",
        {"sig": None, "data": {}, "derived": {}, "version": 0},
    )

    assert settings.get_artist_delimiters() == settings.DEFAULT_ARTIST_DELIMITERS
    assert settings.get_genre_delimiters() == settings.DEFAULT_GENRE_DELIMITERS

    settings.update_settings(
        [str(tmp_path / "output")],
        str(tmp_path / "output"),
        str(tmp_path / "models"),
        artist_delimiters=["&", "feat."],
        genre_delimiters=["|/", "metalcore"],
    )

    assert settings.get_artist_delimiters() == ["&", "feat."]
    assert settings.get_genre_delimiters() == ["|/", "metalcore"]


def test_legacy_delimiter_settings_remain_supported(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(
        settings,
        "_cache",
        {"sig": None, "data": {}, "derived": {}, "version": 0},
    )
    settings._write_settings({
        "artist_delimiters": "&,;/+",
        "genre_delimiters": ",\n;\n/",
    })

    assert settings.get_artist_delimiters() == ["&", ",", ";", "/", "+"]
    assert settings.get_genre_delimiters() == [",", ";", "/"]
