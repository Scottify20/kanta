from app.services import settings


def test_original_copy_setting_defaults_on_and_persists(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(
        settings,
        "_cache",
        {"sig": None, "data": {}, "derived": {}, "version": 0},
    )

    assert settings.get_keep_original() is True
    settings._write_settings({"keep_original": False})
    assert settings.get_keep_original() is False
    settings._write_settings({"keep_original": True})
    assert settings.get_keep_original() is True
