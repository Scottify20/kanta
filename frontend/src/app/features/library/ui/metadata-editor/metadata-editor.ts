import { HttpErrorResponse } from '@angular/common/http';
import { Component, HostListener, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideCheck, LucideFileText, LucideImage, LucideSlidersHorizontal, LucideX } from '@lucide/angular';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { SongManifest, SongsService, songAlbum, songArtist, songTitle } from '../../../../shared/services/songs.service';
import { CoverDropZone } from './cover-drop-zone';
import { LyricsFilesPanel } from './lyrics-files-panel';
import { ReplaygainPanel } from './replaygain-panel';

export interface MetadataDraft {
  artist: string; album: string; title: string; album_artist: string; year: string; genre: string;
  track_number: number | null; disc_number: number | null; composer: string; bpm: number | null;
  comment: string; replaygain_track_gain: string; replaygain_track_peak: string;
  replaygain_album_gain: string; replaygain_album_peak: string;
}

@Component({
  selector: 'app-metadata-editor',
  imports: [FormsModule, Tooltip, CoverDropZone, LyricsFilesPanel, ReplaygainPanel, LucideCheck, LucideFileText, LucideImage, LucideSlidersHorizontal, LucideX],
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
  readonly error = signal('');
  readonly confirmClose = signal(false);
  readonly leaving = signal(false);
  private readonly songs = inject(SongsService);

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
  setText(field: keyof MetadataDraft, value: string): void { this.draft.update((draft) => ({ ...draft, [field]: value })); }
  setNumber(field: 'track_number' | 'disc_number' | 'bpm', value: number | null): void { this.draft.update((draft) => ({ ...draft, [field]: value })); }

  saveMetadata(): void {
    const song = this.manifest();
    if (!song || this.saving()) return;
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
    this.saving.set(true);
    const metadata = {
      artist: draft.artist.trim(), album: draft.album.trim(), title: draft.title.trim(),
      album_artist: draft.album_artist.trim() || null, year: draft.year.trim() ? Number(draft.year) : null,
      genre: draft.genre.trim() || null, track_number: draft.track_number, disc_number: draft.disc_number,
      composer: draft.composer.trim() || null, bpm: draft.bpm, comment: draft.comment.trim() || null,
      replaygain_track_gain: this.parseNumber(draft.replaygain_track_gain),
      replaygain_track_peak: this.parseNumber(draft.replaygain_track_peak),
      replaygain_album_gain: this.parseNumber(draft.replaygain_album_gain),
      replaygain_album_peak: this.parseNumber(draft.replaygain_album_peak),
    };
    this.songs.updateSongMetadata(song, metadata).subscribe({
      next: (updated) => {
        const renamed = song.artist !== updated.artist || song.album !== updated.album || song.title !== updated.title;
        const fresh$ = renamed ? this.songs.getManifest(updated.artist, updated.album, updated.title) : null;
        if (fresh$) fresh$.subscribe({ next: (manifest) => this.finishSave(manifest), error: (err: unknown) => this.fail(err) });
        else this.finishSave(updated);
      },
      error: (err: unknown) => this.fail(err),
    });
  }

  onPanelChanged(): void {
    const song = this.manifest();
    if (!song || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    const currentDraft = this.draft();
    const previousBaseline = this.baseline();
    this.songs.getManifest(song.artist, song.album, song.title).subscribe({
      next: (fresh) => {
        const freshDraft = this.toDraft(fresh);
        const merged = { ...freshDraft };
        for (const key of Object.keys(freshDraft) as (keyof MetadataDraft)[]) {
          if (currentDraft[key] !== previousBaseline[key]) merged[key] = currentDraft[key] as never;
        }
        this.manifest.set(fresh);
        this.baseline.set(freshDraft);
        this.draft.set(merged);
        this.saving.set(false);
        this.saved.emit(fresh);
      },
      error: (err: unknown) => this.fail(err),
    });
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
    if (event.key === 'Escape') { event.preventDefault(); this.requestClose(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); this.saveMetadata(); }
  }

  private finishSave(manifest: SongManifest): void {
    this.manifest.set(manifest);
    this.resetDraft(manifest);
    this.saving.set(false);
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
    return { artist: '', album: '', title: '', album_artist: '', year: '', genre: '', track_number: null, disc_number: null, composer: '', bpm: null, comment: '', replaygain_track_gain: '', replaygain_track_peak: '', replaygain_album_gain: '', replaygain_album_peak: '' };
  }

  private toDraft(song: SongManifest): MetadataDraft {
    return {
      artist: songArtist(song), album: songAlbum(song), title: songTitle(song), album_artist: song.album_artist ?? '',
      year: song.year == null ? '' : String(song.year), genre: song.genre ?? '', track_number: song.track_number ?? null,
      disc_number: song.disc_number ?? null, composer: song.composer ?? '', bpm: song.bpm ?? null, comment: song.comment ?? '',
      replaygain_track_gain: song.replaygain_track_gain ?? '', replaygain_track_peak: song.replaygain_track_peak ?? '',
      replaygain_album_gain: song.replaygain_album_gain ?? '', replaygain_album_peak: song.replaygain_album_peak ?? '',
    };
  }

  private close(): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    setTimeout(() => this.closed.emit(), 220);
  }
}
