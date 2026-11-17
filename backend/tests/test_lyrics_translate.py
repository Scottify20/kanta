import pytest
from fastapi import HTTPException

from app.routes import lyrics
from app.routes import settings as settings_routes
from app.services import settings as settings_service


def test_web_translation_preserves_line_breaks():
    payload = [
        [
            ["Hello", "안녕", None, None, 1],
            ["\n", "\n", None, None, 1],
            ["world", "세계", None, None, 1],
        ],
        None,
        "ko",
    ]

    assert lyrics._translated_web_lines(payload, 2) == ["Hello", "world"]


@pytest.mark.asyncio
async def test_web_translation_reports_rate_limit():
    class RateLimitedResponse:
        status_code = 429

    class FakeClient:
        async def get(self, *_args, **_kwargs):
            return RateLimitedResponse()

    with pytest.raises(HTTPException) as error:
        await lyrics._translate_without_key(FakeClient(), ["안녕"])

    assert error.value.status_code == 429


def test_cloud_translation_identifies_quota_rate_limits():
    class RateLimitedResponse:
        status_code = 403

        def json(self):
            return {"error": {"message": "Quota exceeded"}}

    assert lyrics._is_rate_limited(RateLimitedResponse())


@pytest.mark.asyncio
async def test_cloud_translation_decodes_html_entities():
    class Response:
        status_code = 200

        def json(self):
            return {"data": {"translations": [{"translatedText": "Rock &amp; Roll"}]}}

    class FakeClient:
        async def post(self, *_args, **_kwargs):
            return Response()

    assert await lyrics._translate_with_key(FakeClient(), "test-key", ["록 앤 롤"]) == [
        "Rock & Roll"
    ]


def test_google_translate_key_is_stored_but_not_returned(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_service, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(
        settings_service,
        "_cache",
        {"sig": None, "data": {}, "derived": {}, "version": 0},
    )

    assert settings_service.update_google_translate_api_key("secret-key")
    assert settings_routes.get_google_translate_settings() == {"api_key_configured": True}
    assert settings_service.get_google_translate_api_key() == "secret-key"
    assert not settings_service.update_google_translate_api_key(None)
    assert settings_routes.get_google_translate_settings() == {"api_key_configured": False}
