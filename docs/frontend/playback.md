# Frontend Playback

**Navigation:** [Home](../README.md) | [API guide](../api/README.md) | [Queue API](../api/queue.md) | [Separation API](../api/separation.md) | [Songs and media](../api/songs.md) | **Frontend playback**

Playback is handled by Angular in the frontend. The backend only generates and serves the audio files.

## Recommended flow

1. Add an external audio file with `QueueService.addTrack()`; priority `2` is the default.
2. Subscribe to `QueueService.queue$`.
3. Wait for the item to become `completed`.
4. Request its song manifest.
5. Find the vocal and instrumental stem URLs.
6. Call `AudioPlayerService.loadStems()` from the player component.
7. Start playback from a user gesture.

Processed songs from the Library skip separation. The player loads their existing manifest and stems directly. Library clicks play the song after clearing the queues; the card menu can add it to Karaoke Queue without reprocessing.

## Queue service

`QueueService` polls `GET /api/queue` every 1.5 seconds and provides methods for:

- `addTrack(file, priority)`
- `addProcessedTrack(song)`
- `promoteTrack(taskId)`
- `pauseTrack(taskId)`
- `resumeTrack(taskId)`
- `removeTrack(taskId)`
- `reorderTracks(karaokeQueue, processingOnlyQueue)`
- `clearQueue(priority)`
- `clearAllQueue()`

The API base URL is currently `http://127.0.0.1:8000` in `queue.service.ts`.

The service uses `switchMap`, so a slow poll is replaced by the next interval request. `shareReplay` allows multiple components to observe one polling stream.

## Stem player

`AudioPlayerService` uses two HTML audio elements connected to one `AudioContext`:

```ts
await audioPlayer.loadStems({
  vocals: manifest.stems.find(stem => stem.name.includes('Vocals'))!.url,
  instrumental: manifest.stems.find(stem => stem.name.includes('Instrumental'))!.url
});

await audioPlayer.play();
audioPlayer.setVocalsVolume(0.75);
audioPlayer.setInstrumentalVolume(1);
audioPlayer.seek(30);
audioPlayer.pause();
```

Each stem has a separate `GainNode`, so vocal and instrumental volume can be controlled independently.

The player exposes signals for `isPlaying`, `currentTime`, `duration`, `vocalsVolume`, and `instrumentalVolume`. It also emits `trackEnded`, which the now-playing component uses to advance through the Karaoke Queue. Vocal and instrumental controls are separate vertical popup sliders.

## Synchronization behavior

`play()`, `pause()`, and `seek()` operate on both media elements. The displayed time is calculated from the two current times. The stems should come from the same separation run and have matching duration; mixing files from different songs can cause drift.

## Example component usage

```ts
async playSong(manifest: SongManifest): Promise<void> {
  const vocals = manifest.stems.find(stem => stem.name.includes('Vocals'));
  const instrumental = manifest.stems.find(stem => stem.name.includes('Instrumental'));
  if (!vocals || !instrumental) {
    return;
  }

  await this.audioPlayer.loadStems({
    vocals: vocals.url,
    instrumental: instrumental.url
  });
  await this.audioPlayer.play();
}
```

Call `release()` when switching songs or destroying a player view so the old audio elements are disconnected and the signals reset. The player also supports previous/next queue navigation and clickable seeking.

## Browser requirements

Call `play()` from a user gesture such as a button click because browsers commonly block autoplay. The backend must allow CORS requests from the frontend origin.

If the player is served from a different origin, the audio URLs must remain accessible to the browser and the media elements use anonymous CORS requests. A failed `loadStems()` promise usually means a URL returned `404`, the backend is offline, or the browser rejected the media format.

## Angular control examples

Register `HttpClient` in a standalone Angular application:

```ts
export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient()]
};
```

Transport and volume controls can call the player service directly:

```ts
async togglePlayback(): Promise<void> {
  if (this.audioPlayer.isPlaying()) {
    this.audioPlayer.pause();
  } else {
    await this.audioPlayer.play();
  }
}

onSeek(event: Event): void {
  this.audioPlayer.seek(Number((event.target as HTMLInputElement).value));
}

onVocalsVolume(event: Event): void {
  this.audioPlayer.setVocalsVolume(Number((event.target as HTMLInputElement).value));
}

onInstrumentalVolume(event: Event): void {
  this.audioPlayer.setInstrumentalVolume(Number((event.target as HTMLInputElement).value));
}
```

## Saved lyrics

Song manifests include generated `.ttml` or `.lrc` URLs. Load the first saved lyric file before falling back to remote lookup. The backend lyrics proxy is available at `/api/blyrics/getLyrics` and serves local saved lyrics when they exist.
