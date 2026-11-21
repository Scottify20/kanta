import { HttpErrorResponse } from '@angular/common/http';
import { Component, HostListener, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideCheck, LucideChevronDown, LucideFileText, LucideImage, LucideMic, LucideSlidersHorizontal, LucideX } from '@lucide/angular';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { LibraryService } from '../../../../shared/services/library.service';
import { SongManifest, SongsService, hasVocalRange, hasVocalStem, songAlbum, songArtist, songTitle } from '../../../../shared/services/songs.service';
import { CoverDropZone } from './cover-drop-zone';
import { LyricsFilesPanel } from './lyrics-files-panel';
import { ReplaygainPanel } from './replaygain-panel';

export interface MetadataDraft {
  artist: string; album: string; title: string; album_artist: string; year: string; genre: string;
  track_number: number | null; disc_number: number | null; composer: string; bpm: number | null; musical_key: string;
  comment: string; replaygain_track_gain: string; replaygain_track_peak: string;
  replaygain_album_gain: string; replaygain_album_peak: string;
}

const MUSICAL_KEY_OPTIONS = [
  { key: 'C', camelot: '8B', mode: 'Major' }, { key: 'C#', camelot: '3B', mode: 'Major' },
  { key: 'D', camelot: '10B', mode: 'Major' }, { key: 'D#', camelot: '5B', mode: 'Major' },
  { key: 'E', camelot: '12B', mode: 'Major' }, { key: 'F', camelot: '7B', mode: 'Major' },
  { key: 'F#', camelot: '2B', mode: 'Major' }, { key: 'G', camelot: '9B', mode: 'Major' },
  { key: 'G#', camelot: '4B', mode: 'Major' }, { key: 'A', camelot: '11B', mode: 'Major' },
  { key: 'A#', camelot: '6B', mode: 'Major' }, { key: 'B', camelot: '1B', mode: 'Major' },
  { key: 'Cm', camelot: '5A', mode: 'Minor' }, { key: 'C#m', camelot: '12A', mode: 'Minor' },
  { key: 'Dm', camelot: '7A', mode: 'Minor' }, { key: 'D#m', camelot: '2A', mode: 'Minor' },
  { key: 'Em', camelot: '9A', mode: 'Minor' }, { key: 'Fm', camelot: '4A', mode: 'Minor' },
  { key: 'F#m', camelot: '11A', mode: 'Minor' }, { key: 'Gm', camelot: '6A', mode: 'Minor' },
  { key: 'G#m', camelot: '1A', mode: 'Minor' }, { key: 'Am', camelot: '8A', mode: 'Minor' },
  { key: 'A#m', camelot: '3A', mode: 'Minor' }, { key: 'Bm', camelot: '10A', mode: 'Minor' },
] as const;

@Component({
  selector: 'app-metadata-editor',
  imports: [FormsModule, Tooltip, CoverDropZone, LyricsFilesPanel, ReplaygainPanel, LucideCheck, LucideChevronDown, LucideFileText, LucideImage, LucideMic, LucideSlidersHorizontal, LucideX],
  templateUrl: './metadata-editor.html',
  styleUrl: './metadata-editor.scss',
})
export class MetadataEditor {
  readonly song = input.required<SongManifest>();
  readonly closed = output<void>();
  readonly saved = output<SongManifest>();
  readonly activeTab = signal<'general' | 'cover' | 'lyrics' | 'replaygain'>('general');
  readonly manifest = signal<SongManifest | null>(null);
  readonly draft = signal<MetadataDraft>(this.emptyDraft());
  readonly baseline = signal<MetadataDraft>(this.emptyDraft());
  readonly saving = signal(false);
  readonly analyzingVocalRange = signal(false);
  readonly analyzingMusicalKey = signal(false);
  readonly error = signal('');
  readonly vocalRangeError = signal('');
  readonly musicalKeyError = signal('');
  readonly saveStatus = signal('');
  readonly confirmClose = signal(false);
  readonly leaving = signal(false);
  readonly keyPickerOpen = signal(false);
  readonly musicalKeyOptions = MUSICAL_KEY_OPTIONS;
  private readonly songs = inject(SongsService);
  private readonly library = inject(LibraryService);

  constructor() {
    effect(() => {
      const value = this.song();
      untracked(() => {
        const previous = this.manifest();
        this.manifest.set(value);
        const pathChanged = !previous || previous.artist !== value.artist || previous.album !== value.album || previous.title !== value.title;
        if (pathChanged || !this.dirty()) this.resetDraft(value);
      });
    });
  }

  dirty(): boolean { return JSON.stringify(this.draft()) !== JSON.stringify(this.baseline()); }
  setText(field: keyof MetadataDraft, value: string): void { this.saveStatus.set(''); this.draft.update((draft) => ({ ...draft, [field]: value })); }
  setNumber(field: 'track_number' | 'disc_number' | 'bpm', value: number | null): void { this.saveStatus.set(''); this.draft.update((draft) => ({ ...draft, [field]: value })); }

  camelotCode(): string | null {
    const key = this.draft().musical_key.trim().toLocaleLowerCase();
    return MUSICAL_KEY_OPTIONS.find((option) => option.key.toLocaleLowerCase() === key)?.camelot ?? null;
  }

  selectMusicalKey(key: string): void {
    this.setText('musical_key', key);
    this.keyPickerOpen.set(false);
  }

  saveMetadata(): void {
    const song = this.manifest();
    if (!song || this.saving() || this.analyzingVocalRange() || this.analyzingMusicalKey() || !this.dirty()) return;
    const draft = this.draft();
    if (!draft.artist.trim() || !draft.album.trim() || !draft.title.trim()) {
      this.error.set('Artist, album, and title are required.');
      return;
    }
    if (draft.year.trim() && (!/^\d{1,4}$/.test(draft.year.trim()) || Number(draft.year) > 9999)) {
      this.error.set('Year must be a number from 0 to 9999.');
      return;
    }
    const gains = [draft.replaygain_track_gain, draft.replaygain_track_peak, draft.replaygain_album_gain, draft.replaygain_album_peak];
    if (gains.some((value) => value.trim() && !Number.isFinite(Number.parseFloat(value)))) {
      this.error.set('ReplayGain values must be numeric.');
      return;
    }
    this.error.set('');
    this.saveStatus.set('');
    this.saving.set(true);
    const metadata = {
      artist: draft.artist.trim(), album: draft.album.trim(), title: draft.title.trim(),
      album_artist: draft.album_artist.trim() || null, year: draft.year.trim() ? Number(draft.year) : null,
      genre: draft.genre.trim() || null, track_number: draft.track_number, disc_number: draft.disc_number,
      composer: draft.composer.trim() || null, bpm: draft.bpm, musical_key: draft.musical_key.trim() || null,
      comment: draft.comment.trim() || null,
      replaygain_track_gain: this.parseNumber(draft.replaygain_track_gain),
      replaygain_track_peak: this.parseNumber(draft.replaygain_track_peak),
      replaygain_album_gain: this.parseNumber(draft.replaygain_album_gain),
      replaygain_album_peak: this.parseNumber(draft.replaygain_album_peak),
    };
    this.songs.updateSongMetadata(song, metadata).subscribe({
      next: (updated) => {
        this.finishSave(updated);
      },
      error: (err: unknown) => this.fail(err),
    });
  }

  onPanelChanged(): void {
    const song = this.manifest();
    if (!song || this.saving() || this.analyzingVocalRange() || this.analyzingMusicalKey()) return;
    this.saving.set(true);
    this.error.set('');
    this.songs.getManifest(song.artist, song.album, song.title).subscribe({
      next: (fresh) => {
        this.syncManifestPreservingDraft(fresh);
        this.saving.set(false);
        this.saveStatus.set('Changes saved.');
      },
      error: (err: unknown) => this.fail(err),
    });
  }

  async analyzeVocalRange(): Promise<void> {
    const song = this.manifest();
    if (!song || !hasVocalStem(song) || this.saving() || this.analyzingVocalRange() || this.analyzingMusicalKey()) return;
    this.analyzingVocalRange.set(true);
    this.vocalRangeError.set('');
    this.saveStatus.set('');
    try {
      const updated = await this.library.requestVocalRangeAnalysis(song, true);
      if (!updated) throw new Error('The vocal range analysis returned no song manifest.');
      this.syncManifestPreservingDraft(updated);
      this.saveStatus.set(hasVocalRange(updated) ? 'Vocal range updated.' : 'No vocal range was detected.');
    } catch (error: unknown) {
      this.vocalRangeError.set(
        error instanceof HttpErrorResponse
          ? error.error?.detail || error.message || 'Could not analyze the vocal stem.'
          : error instanceof Error ? error.message : 'Could not analyze the vocal stem.',
      );
    } finally {
      this.analyzingVocalRange.set(false);
    }
  }

  async analyzeMusicalKey(): Promise<void> {
    const song = this.manifest();
    if (!song || !this.analysisAudioAvailable(song) || this.saving() || this.analyzingVocalRange() || this.analyzingMusicalKey()) return;
    this.analyzingMusicalKey.set(true);
    this.musicalKeyError.set('');
    this.saveStatus.set('');
    try {
      const updated = await this.songs.analyzeSongMusicalKey(song);
      this.syncManifestPreservingDraft(updated);
      this.saveStatus.set(updated.musical_key ? 'Musical key updated.' : 'No musical key was detected.');
    } catch (error: unknown) {
      this.musicalKeyError.set(
        error instanceof HttpErrorResponse
          ? error.error?.detail || error.message || 'Could not analyze the musical key.'
          : error instanceof Error ? error.message : 'Could not analyze the musical key.',
      );
    } finally {
      this.analyzingMusicalKey.set(false);
    }
  }

  vocalStemAvailable(): boolean {
    const song = this.manifest();
    return !!song && hasVocalStem(song);
  }

  analysisAudioAvailable(song = this.manifest()): boolean {
    return !!song && (!!song.master || song.stems.some((stem) => /\(instrumental\)\.[a-z0-9]+$/i.test(stem.name)));
  }

  vocalRangeAvailable(): boolean {
    const song = this.manifest();
    return !!song && hasVocalRange(song);
  }

  updateReplaygain(change: { field: keyof MetadataDraft; value: string }): void {
    this.setText(change.field, change.value);
  }

  requestClose(): void {
    if (this.dirty() || this.saving()) { this.confirmClose.set(true); return; }
    this.close();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.keyPickerOpen()) this.keyPickerOpen.set(false);
      else this.requestClose();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); this.saveMetadata(); }
  }

  @HostListener('document:click')
  closeKeyPicker(): void {
    this.keyPickerOpen.set(false);
  }

  private finishSave(manifest: SongManifest): void {
    this.manifest.set(manifest);
    this.resetDraft(manifest);
    this.saving.set(false);
    this.saveStatus.set('Changes saved.');
    this.saved.emit(manifest);
  }

  private syncManifestPreservingDraft(manifest: SongManifest): void {
    const currentDraft = this.draft();
    const previousBaseline = this.baseline();
    const freshDraft = this.toDraft(manifest);
    const merged = { ...freshDraft };
    for (const key of Object.keys(freshDraft) as (keyof MetadataDraft)[]) {
      if (currentDraft[key] !== previousBaseline[key]) merged[key] = currentDraft[key] as never;
    }
    this.manifest.set(manifest);
    this.baseline.set(freshDraft);
    this.draft.set(merged);
    this.saved.emit(manifest);
  }

  private fail(error: unknown): void {
    this.saving.set(false);
    this.error.set(this.errorMessage(error));
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) return error.error?.detail || error.message || 'Could not save song changes.';
    return 'Could not save song changes.';
  }

  private resetDraft(song: SongManifest): void {
    const draft = this.toDraft(song);
    this.draft.set(draft);
    this.baseline.set(draft);
  }

  private parseNumber(value: string): number | null {
    return value.trim() ? Number.parseFloat(value) : null;
  }

  private emptyDraft(): MetadataDraft {
    return { artist: '', album: '', title: '', album_artist: '', year: '', genre: '', track_number: null, disc_number: null, composer: '', bpm: null, musical_key: '', comment: '', replaygain_track_gain: '', replaygain_track_peak: '', replaygain_album_gain: '', replaygain_album_peak: '' };
  }

  private toDraft(song: SongManifest): MetadataDraft {
    return {
      artist: songArtist(song), album: songAlbum(song), title: songTitle(song), album_artist: song.album_artist ?? '',
      year: song.year == null ? '' : String(song.year), genre: song.genre ?? '', track_number: song.track_number ?? null,
      disc_number: song.disc_number ?? null, composer: song.composer ?? '', bpm: song.bpm ?? null,
      musical_key: song.musical_key ?? '', comment: song.comment ?? '',
      replaygain_track_gain: String(song.replaygain_track_gain ?? ''), replaygain_track_peak: String(song.replaygain_track_peak ?? ''),
      replaygain_album_gain: String(song.replaygain_album_gain ?? ''), replaygain_album_peak: String(song.replaygain_album_peak ?? ''),
    };
  }

  private close(): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    setTimeout(() => this.closed.emit(), 220);
  }
}
