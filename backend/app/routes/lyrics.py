import html

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from app.services.settings import get_google_translate_api_key

router = APIRouter(prefix="/api/lyrics", tags=["Lyrics"])

MAX_TEXTS = 300
MAX_TOTAL_CHARACTERS = 30_000
MAX_WEB_CHUNK_CHARACTERS = 4_000
TRANSLATE_TIMEOUT_SECONDS = 20.0
GOOGLE_BASIC_URL = "https://translation.googleapis.com/language/translate/v2"
GOOGLE_WEB_URL = "https://translate.googleapis.com/translate_a/single"


class LyricsTranslationRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_TEXTS)

    @model_validator(mode="after")
    def validate_total_characters(self):
        if sum(len(text) for text in self.texts) > MAX_TOTAL_CHARACTERS:
            raise ValueError("Lyrics exceed the translation size limit.")
        return self


def _chunks(texts: list[str]) -> list[list[str]]:
    result: list[list[str]] = []
    current: list[str] = []
    size = 0
    for text in texts:
        if len(text) > MAX_WEB_CHUNK_CHARACTERS:
            raise HTTPException(status_code=413, detail="A lyric line exceeds the translation size limit.")
        added_size = len(text) + (1 if current else 0)
        if current and size + added_size > MAX_WEB_CHUNK_CHARACTERS:
            result.append(current)
            current = []
            size = 0
            added_size = len(text)
        current.append(text)
        size += added_size
    if current:
        result.append(current)
    return result


def _translated_web_lines(payload: object, expected: int) -> list[str]:
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], list):
        raise HTTPException(status_code=502, detail="Google Translate returned an invalid response.")
    text = "".join(
        str(segment[0])
        for segment in payload[0]
        if isinstance(segment, list) and segment and isinstance(segment[0], str)
    )
    lines = text.splitlines()
    if len(lines) != expected:
        raise HTTPException(status_code=502, detail="Google Translate could not preserve lyric line breaks.")
    return [html.unescape(line.strip()) for line in lines]


def _is_rate_limited(response: httpx.Response) -> bool:
    if response.status_code == 429:
        return True
    try:
        payload = response.json()
    except ValueError:
        return False
    message = str(payload.get("error", {})).lower() if isinstance(payload, dict) else ""
    return "rate" in message or "quota" in message


async def _translate_with_key(client: httpx.AsyncClient, api_key: str, texts: list[str]) -> list[str]:
    translations: list[str] = []
    for start in range(0, len(texts), 128):
        response = await client.post(
            GOOGLE_BASIC_URL,
            params={"key": api_key},
            json={"q": texts[start : start + 128], "target": "en", "format": "text"},
        )
        if _is_rate_limited(response):
            raise HTTPException(status_code=429, detail="Google Translate is rate-limited.")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="Google Translation API rejected the request or API key.")
        try:
            payload = response.json()
            items = payload["data"]["translations"]
            if len(items) != len(texts[start : start + 128]):
                raise ValueError("Unexpected translation count")
            translations.extend(html.unescape(item["translatedText"]).strip() for item in items)
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(status_code=502, detail="Google Translation API returned an invalid response.") from exc
    return translations


async def _translate_without_key(client: httpx.AsyncClient, texts: list[str]) -> list[str]:
    translations: list[str] = []
    for chunk in _chunks(texts):
        response = await client.get(
            GOOGLE_WEB_URL,
            params={
                "client": "gtx",
                "sl": "auto",
                "tl": "en",
                "dt": "t",
                "q": "\n".join(chunk),
            },
        )
        if response.status_code in (403, 429):
            raise HTTPException(status_code=429, detail="Google Translate is rate-limited.")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="Google Translate is unavailable.")
        try:
            translations.extend(_translated_web_lines(response.json(), len(chunk)))
        except ValueError as exc:
            raise HTTPException(status_code=502, detail="Google Translate returned an invalid response.") from exc
    return translations


@router.post("/translate")
async def translate_lyrics(request: LyricsTranslationRequest) -> dict[str, list[str]]:
    try:
        async with httpx.AsyncClient(timeout=TRANSLATE_TIMEOUT_SECONDS) as client:
            api_key = get_google_translate_api_key()
            translations = (
                await _translate_with_key(client, api_key, request.texts)
                if api_key
                else await _translate_without_key(client, request.texts)
            )
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Google Translate.") from exc
    return {"translations": translations}
