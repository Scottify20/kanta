import asyncio
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.services import playlists
from app.services.settings import find_song_directory

router = APIRouter(prefix="/api/playlists", tags=["Playlists"])


class PlaylistName(BaseModel):
    name: str


class SongRef(BaseModel):
    artist: str
    album: str
    title: str


class AddSongs(BaseModel):
    songs: list[SongRef]


class Reorder(BaseModel):
    order: list[int]


def _clean_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Playlist name is required")
    return name


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Playlist not found") from exc


def _render(playlist: dict, request: Request) -> Dict[str, Any]:
    return playlists.render(playlist, str(request.base_url))


@router.get("")
async def list_all(request: Request) -> list[Dict[str, Any]]:
    items = await asyncio.to_thread(playlists.list_playlists)
    return [_render(p, request) for p in items]


@router.post("", status_code=201)
async def create(body: PlaylistName, request: Request) -> Dict[str, Any]:
    playlist = await asyncio.to_thread(playlists.create_playlist, _clean_name(body.name))
    return _render(playlist, request)


@router.get("/{playlist_id}")
async def get_one(playlist_id: str, request: Request) -> Dict[str, Any]:
    return _render(await _run(playlists.get_playlist, playlist_id), request)


@router.patch("/{playlist_id}")
async def rename(playlist_id: str, body: PlaylistName, request: Request) -> Dict[str, Any]:
    name = _clean_name(body.name)

    def change(playlist: dict) -> None:
        playlist["name"] = name

    return _render(await _run(playlists.mutate, playlist_id, change), request)


@router.delete("/{playlist_id}")
async def delete(playlist_id: str) -> Dict[str, str]:
    await _run(playlists.delete_playlist, playlist_id)
    return {"message": "Playlist deleted"}


@router.post("/{playlist_id}/songs")
async def add_songs(playlist_id: str, body: AddSongs, request: Request) -> Dict[str, Any]:
    for song in body.songs:
        if find_song_directory(song.artist, song.album, song.title) is None:
            raise HTTPException(
                status_code=404,
                detail=f"Song not found: {song.artist} / {song.album} / {song.title}",
            )
    entries = [s.model_dump() for s in body.songs]

    def change(playlist: dict) -> None:
        playlist["songs"].extend(entries)

    return _render(await _run(playlists.mutate, playlist_id, change), request)


@router.delete("/{playlist_id}/songs/{index}")
async def remove_song(playlist_id: str, index: int, request: Request) -> Dict[str, Any]:
    def change(playlist: dict) -> None:
        if not 0 <= index < len(playlist["songs"]):
            raise IndexError
        del playlist["songs"][index]

    try:
        playlist = await _run(playlists.mutate, playlist_id, change)
    except IndexError:
        raise HTTPException(status_code=404, detail="Song index out of range")
    return _render(playlist, request)


@router.put("/{playlist_id}/order")
async def reorder(playlist_id: str, body: Reorder, request: Request) -> Dict[str, Any]:
    def change(playlist: dict) -> None:
        if sorted(body.order) != list(range(len(playlist["songs"]))):
            raise ValueError
        playlist["songs"] = [playlist["songs"][i] for i in body.order]

    try:
        playlist = await _run(playlists.mutate, playlist_id, change)
    except ValueError:
        raise HTTPException(status_code=400, detail="order must be a permutation of song indices")
    return _render(playlist, request)
