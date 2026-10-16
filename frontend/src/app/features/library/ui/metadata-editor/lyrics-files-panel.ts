import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, input, output, signal } from '@angular/core';
import { LucideFileText, LucideTrash2, LucideUpload } from '@lucide/angular';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { SongManifest, SongsService } from '../../../../shared/services/songs.service';

@Component({
  selector: 'app-lyrics-files-panel',
  imports: [Tooltip, LucideFileText, LucideTrash2, LucideUpload],
  templateUrl: './lyrics-files-panel.html',
  styleUrl: './lyrics-files-panel.scss',
})
export class LyricsFilesPanel {
  readonly song = input.required<SongManifest>();
  readonly changed = output<void>();
  readonly over = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  private readonly service = inject(SongsService);

  onDragOver(event: DragEvent): void { event.preventDefault(); this.over.set(true); }
  onDragLeave(event: DragEvent): void {
    if (!event.currentTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) this.over.set(false);
  }
  onDrop(event: DragEvent): void { event.preventDefault(); this.over.set(false); const file = event.dataTransfer?.files[0]; if (file) this.upload(file); }
  onPicked(event: Event): void { const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (file) this.upload(file); input.value = ''; }

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

  private fail(err: unknown): void {
    this.busy.set(false);
    this.error.set(err instanceof HttpErrorResponse ? err.error?.detail || err.message : 'Lyrics update failed.');
  }
}
