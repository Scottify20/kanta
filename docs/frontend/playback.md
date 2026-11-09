# Frontend Playback

**Navigation:** [Home](../README.md) | [API guide](../api/README.md) | [Queue API](../api/queue.md) | [Separation API](../api/separation.md) | [Songs and media](../api/songs.md) | **Frontend playback**

Playback is handled by Angular in the frontend. The backend only generates and serves the audio files.
The navigation sidebar and queue sheet overlay the current page without resizing
it. Click outside an open panel to dismiss it.
While a queued song is playing or paused, a mini lyrics panel appears outside
the Now Playing page. It remains hidden before playback starts and when the
queue is empty. Use the header's pause and resume buttons to control playback.
Drag its header to move it or drag its bottom-right corner to
resize it; its position and size are saved across app launches. The move and
resize handles also support the arrow keys (hold Shift for larger steps).
Use the panel header's lyrics size button to adjust its text independently of
the main player; the mini lyrics text size is saved across launches.
Use the minimize button to collapse the panel into a pill with the song title
and playback control, anchored at the panel's bottom-right corner. Drag the pill
to reposition it; expanding restores the panel size at the new position.

## Recommended flow

1. Add an external audio file with `QueueService.addTrack()`; priority `2` is the default.
   To include local lyrics, select or drop the audio and its same-named `.ttml` or `.lrc`
   file together. Individual file selection does not grant access to other files
   in the original folder.
2. Subscribe to `QueueService.queue$`.
3. Wait for the item to become `completed`.
4. Request its song manifest.
5. Find the vocal and instrumental stem URLs.
6. Call `AudioPlayerService.loadStems()` from the player component.
7. Start playback from a user gesture.

Processed songs from the Library skip separation. The player loads their existing manifest and stems directly. Library clicks play the song after clearing the queues; the card menu can add it to Karaoke Queue without reprocessing.
On an artist page, each album heading expands or collapses its songs. Playing or
queueing the whole artist still includes songs in collapsed albums.
In the Library's Songs tab, select one filter: Word synced, Line synced, Duet
Lyrics, or No lyrics. Select All songs or select the active filter again to reset
the filter. Duets
are identified from saved lyrics containing a second singer or group vocal line.
The filter and each tab's sort remain selected while the app is running and
reset on relaunch; other library tabs are not filtered.

## Queue service

`QueueService` receives queue snapshots from `GET /api/queue/stream`, falling
back to polling `GET /api/queue` every 1.5 seconds, and provides methods for:

- `addTrack(file, priority, lyrics?)`
- `addProcessedTrack(song)`
- `promoteTrack(taskId)`
- `pauseTrack(taskId)`
- `resumeTrack(taskId)`
- `removeTrack(taskId)`
- `reorderTracks(karaokeQueue, processingOnlyQueue)`
- `clearQueue(priority)`
- `clearAllQueue()`

The API base URL is configured in `app.config.ts`. Polls do not overlap, and
failures retain the last snapshot. `shareReplay` allows multiple components to
observe one queue stream.

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

The Space bar toggles playback when focus is not in an editable or interactive
control. Supported webviews also expose play/pause through the Media Session API
and request a screen wake lock while playing. Bluetooth media controls and wake
locks depend on the operating system and webview support.

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

The lyrics appearance popup in Now Playing controls size and color. White is the
default; album accents sample the current cover, and custom mode offers separate
colors for two singers. Duet coloring requires singer identifiers in the lyrics.
Inactive and backing vocals use a translucent version of their line's singer
color; album mode adjusts their opacity using the sampled backdrop and brightens
active colors separately for greater distinction. The glow follows each singer's color. Lines marked
as a vocal group use a blend of the two singer colors. Album mode
automatically adjusts saturation and lightness using the cover and an estimate of
the darkened backdrop. When a duet cover cannot provide two sufficiently
distinct singer colors, album mode uses the saved custom colors for both singers.
Custom colors use the selected values without automatic
lightening. Both color modes use a subtle text shadow rather than a gradient;
readability depends on the background.
Appearance preferences are saved locally. If a cover cannot be sampled, the
automatic colors fall back to white for solo lyrics and to the custom colors for
duets. Color Thief extracts accents from the cover; monochrome covers use the
same fallback.

Right-click a library, search, or queue item for its available actions. Other
areas show application navigation or text-editing actions instead of the webview
menu. Clipboard actions depend on webview permissions.
