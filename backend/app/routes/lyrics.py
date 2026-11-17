import asyncio

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

router = APIRouter(prefix="/api/lyrics", tags=["Lyrics"])

MAX_TEXTS = 300
MAX_TOTAL_CHARACTERS = 30_000
TRANSLITERATION_TIMEOUT_SECONDS = 20.0
MAX_CONCURRENT_TRANSLITERATIONS = 6
GOOGLE_WEB_URL = "https://translate.googleapis.com/translate_a/single"


class LyricsTransliterationRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_TEXTS)

    @model_validator(mode="after")
    def validate_total_characters(self):
        if sum(len(text) for text in self.texts) > MAX_TOTAL_CHARACTERS:
            raise ValueError("Lyrics exceed the transliteration size limit.")
        return self


def _romanized_line(payload: object) -> str | None:
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], list):
        raise HTTPException(status_code=502, detail="Google Translate returned an invalid response.")
    parts = payload[0]
    if len(parts) < 2 or not isinstance(parts[1], list):
        return None

    part = parts[1]
    for index in (-2, 2):
        if (
            -len(part) <= index < len(part)
            and isinstance(part[index], str)
            and part[index].strip()
        ):
            return part[index].strip()
    return None


async def _transliterate_with_google(
    client: httpx.AsyncClient, texts: list[str]
) -> list[str | None]:
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_TRANSLITERATIONS)

    async def transliterate(text: str) -> str | None:
        async with semaphore:
            response = await client.get(
                GOOGLE_WEB_URL,
                params={
                    "client": "gtx",
                    "sl": "auto",
                    "tl": "en",
                    "dt": ["rm", "t"],
                    "q": text,
                },
            )
        if response.status_code in (403, 429):
            raise HTTPException(status_code=429, detail="Google transliteration is rate-limited.")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="Google transliteration is unavailable.")
        return _romanized_line(response.json())

    return await asyncio.gather(*(transliterate(text) for text in texts))


@router.post("/transliterate")
async def transliterate_lyrics(
    request: LyricsTransliterationRequest,
) -> dict[str, list[str | None]]:
    try:
        async with httpx.AsyncClient(timeout=TRANSLITERATION_TIMEOUT_SECONDS) as client:
            transliterations = await _transliterate_with_google(client, request.texts)
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Google transliteration.") from exc
    return {"transliterations": transliterations}
