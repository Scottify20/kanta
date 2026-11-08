import '@angular/compiler';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { Library } from '../src/app/features/library/library.ts';
import { MetadataEditor } from '../src/app/features/library/ui/metadata-editor/metadata-editor.ts';
import { MiniLyrics } from '../src/app/features/now-playing/ui/mini-lyrics/mini-lyrics.ts';
import { replayGainFactor } from '../src/app/shared/services/audio-player.service.ts';
import { songEntry } from '../src/app/features/library/data/library-entries.ts';

const song = {
  artist: 'Artist', album: 'Album', title: 'Title',
  stems: [{ name: 'Title (Vocals).mp3' }, { name: 'Title (Instrumental).mp3' }],
  covers: [], lyrics: [], replaygain_track_gain: -3.2, replaygain_track_peak: 0.9,
};

describe('metadata editor', () => {
  it('accepts numeric ReplayGain values returned by the library', () => {
    const editor = Object.create(MetadataEditor.prototype);
    const draft = editor.toDraft(song);
    expect(draft.replaygain_track_gain).toBe('-3.2');
    expect(draft.replaygain_track_peak).toBe('0.9');
    expect(replayGainFactor({ trackGain: -3.2 }, 'track')).toBeCloseTo(10 ** (-3.2 / 20));
  });

  it('saves numeric ReplayGain values and confirms the result', () => {
    const editor = Object.create(MetadataEditor.prototype);
    editor.manifest = signal(song);
    editor.draft = signal(editor.toDraft(song));
    editor.baseline = signal(editor.toDraft(song));
    editor.saving = signal(false);
    editor.error = signal('');
    editor.saveStatus = signal('');
    editor.saved = { emit: vi.fn() };
    editor.songs = { updateSongMetadata: vi.fn(() => of(song)) };
    editor.setText('genre', 'Pop');
    editor.saveMetadata();
    expect(editor.songs.updateSongMetadata).toHaveBeenCalledWith(song, expect.objectContaining({
      genre: 'Pop', replaygain_track_gain: -3.2,
    }));
    expect(editor.saveStatus()).toBe('Changes saved.');
    expect(editor.saved.emit).toHaveBeenCalledWith(song);
  });
});

describe('mini lyrics', () => {
  it('toggles the pill while preserving the expanded bounds', () => {
    const mini = Object.create(MiniLyrics.prototype);
    mini.minimized = signal(false);
    mini.savedBounds = signal({ x: 20, y: 30, width: 360, height: 240 });
    mini.popups = { close: vi.fn() };
    mini.toggleMinimized();
    expect(mini.minimized()).toBe(true);
    mini.toggleMinimized();
    expect(mini.minimized()).toBe(false);
    expect(mini.savedBounds()).toEqual({ x: 20, y: 30, width: 360, height: 240 });
    expect(mini.popups.close).toHaveBeenCalledTimes(2);
  });
});

describe('library processing', () => {
  it('blocks unfinished songs even when stems already exist', () => {
    const library = Object.create(Library.prototype);
    library.processingSongs = () => new Map([['Artist\0Album\0Title', 50]]);
    expect(library.entryUnavailable(songEntry(song))).toBe(true);
    const actions = vi.fn();
    library.open = actions;
    library.activate(songEntry(song), 0, {});
    expect(actions).not.toHaveBeenCalled();
    expect(library.playable([song])).toEqual([]);
    library.processingSongs = () => new Map();
    expect(library.entryUnavailable(songEntry(song))).toBe(false);
    expect(library.playable([song])).toEqual([song]);
    expect(library.entryUnavailable(songEntry({ ...song, stems: [] }))).toBe(true);
  });
});
