import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { parseLRC, parseTTMLContent } from '@braccato/parsers';
import { LucideEye, LucideFileText, LucideRefreshCw, LucideTrash2, LucideUpload } from '@lucide/angular';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { LyricsCandidate, SongManifest, SongsService } from '../../../../shared/services/songs.service';
import { stripLyricMetadata } from '../../../../shared/util/lyrics-metadata';

@Component({
  selector: 'app-lyrics-files-panel',
  imports: [Tooltip, LucideEye, LucideFileText, LucideRefreshCw, LucideTrash2, LucideUpload],
  templateUrl: './lyrics-files-panel.html',
  styleUrl: './lyrics-files-panel.scss',
})
export class LyricsFilesPanel {
  readonly song = input.required<SongManifest>();
  readonly changed = output<void>();
  readonly over = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly searching = signal(false);
  readonly notFound = signal(false);
  readonly candidate = signal<LyricsCandidate | null>(null);
  readonly previewing = signal(false);
  readonly previewLines = computed(() => {
    const found = this.candidate();
    if (!found?.content) return [];
    const lyrics = found.format === 'ttml' ? parseTTMLContent(found.content).lyrics : parseLRC(found.content, 0);
    return stripLyricMetadata(lyrics).map((line) => ({ time: this.formatTime(line.startTimeMs), text: line.words }));
  });
  private readonly service = inject(SongsService);

  onDragOver(event: DragEvent): void { event.preventDefault(); this.over.set(true); }
  onDragLeave(event: DragEvent): void {
    if (!event.currentTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) this.over.set(false);
  }
  onDrop(event: DragEvent): void { event.preventDefault(); this.over.set(false); const file = event.dataTransfer?.files[0]; if (file) this.upload(file); }
  onPicked(event: Event): void { const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (file) this.upload(file); input.value = ''; }

  refetch(): void {
    if (this.busy() || this.searching()) return;
    this.searching.set(true); this.error.set(''); this.notFound.set(false);
    this.candidate.set(null); this.previewing.set(false);
    this.service.refetchSongLyrics(this.song()).subscribe({
      next: (result) => {
        this.searching.set(false);
        if (result.found) this.candidate.set(result); else this.notFound.set(true);
      },
      error: (err: unknown) => { this.searching.set(false); this.fail(err); },
    });
  }

  discardCandidate(): void { this.candidate.set(null); this.previewing.set(false); }

  replaceWithCandidate(): void {
    const found = this.candidate();
    if (!found?.format || !found.content || this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.service.applySongLyrics(this.song(), { format: found.format, content: found.content }).subscribe({
      next: () => { this.busy.set(false); this.discardCandidate(); this.changed.emit(); },
      error: (err: unknown) => this.fail(err),
    });
  }

  remove(): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.service.deleteSongLyrics(this.song()).subscribe({
      next: () => { this.busy.set(false); this.changed.emit(); },
      error: (err: unknown) => this.fail(err),
    });
  }

  private upload(file: File): void {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['lrc', 'ttml', 'srt', 'vtt'].includes(extension ?? '')) {
      this.error.set('Choose an .lrc, .ttml, .srt, or .vtt file.'); return;
    }
    if (file.size > 5 * 1024 * 1024) { this.error.set('Lyrics files must be 5 MB or smaller.'); return; }
    this.busy.set(true); this.error.set('');
    this.service.uploadSongLyrics(this.song(), file).subscribe({
      next: () => { this.busy.set(false); this.changed.emit(); },
      error: (err: unknown) => this.fail(err),
    });
  }

  private formatTime(milliseconds: number): string {
    const seconds = Math.max(0, milliseconds) / 1000;
    return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
  }

  private fail(err: unknown): void {
    this.busy.set(false);
    this.error.set(err instanceof HttpErrorResponse ? err.error?.detail || err.message : 'Lyrics update failed.');
  }
}
