import pytest
from fastapi import HTTPException

from app.routes import lyrics
from app.routes import settings as settings_routes
from app.services import settings as settings_service


def test_google_response_extracts_romanization_not_translation():
    payload = [
        [
            ["Hello", "こんにちは", None, None, 1],
            ["", "", None, None, "konnichiwa", None],
        ],
        None,
        "ja",
    ]

    assert lyrics._romanized_line(payload) == "konnichiwa"


def test_google_response_without_romanization_does_not_use_translation():
    payload = [
        [
            ["Hello", "こんにちは", None, None, 1],
            ["", "", None, None, None, None],
        ],
        None,
        "ja",
    ]

    assert lyrics._romanized_line(payload) is None


@pytest.mark.asyncio
async def test_google_transliteration_reports_rate_limit():
    class RateLimitedResponse:
        status_code = 429

    class FakeClient:
        async def get(self, *_args, **_kwargs):
            return RateLimitedResponse()

    with pytest.raises(HTTPException) as error:
        await lyrics._transliterate_with_google(FakeClient(), ["안녕"])

    assert error.value.status_code == 429


@pytest.mark.asyncio
async def test_google_transliteration_requests_romanization():
    class Response:
        status_code = 200

        def json(self):
            return [
                [
                    ["Hello", "こんにちは", None, None, 1],
                    ["", "", None, None, "konnichiwa", None],
                ],
                None,
                "ja",
            ]

    class FakeClient:
        async def get(self, _url, *, params):
            assert params["dt"] == ["rm", "t"]
            return Response()

    assert await lyrics._transliterate_with_google(FakeClient(), ["こんにちは"]) == [
        "konnichiwa"
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
