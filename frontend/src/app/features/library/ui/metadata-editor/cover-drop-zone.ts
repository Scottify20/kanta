import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnDestroy, input, output, signal, inject } from '@angular/core';
import { LucideImage, LucideTrash2, LucideUpload } from '@lucide/angular';
import { Tooltip } from '../../../../shared/directives/tooltip';
import { SongManifest, SongsService } from '../../../../shared/services/songs.service';

@Component({
  selector: 'app-cover-drop-zone',
  imports: [Tooltip, LucideImage, LucideTrash2, LucideUpload],
  templateUrl: './cover-drop-zone.html',
  styleUrl: './cover-drop-zone.scss',
})
export class CoverDropZone implements OnDestroy {
  readonly song = input.required<SongManifest>();
  readonly changed = output<void>();
  readonly over = signal(false);
  readonly busy = signal(false);
  readonly preview = signal('');
  readonly error = signal('');
  private readonly service = inject(SongsService);
  private objectUrl = '';

  get coverUrl(): string { return this.preview() || this.song().covers?.[0]?.url || ''; }

  onDragOver(event: DragEvent): void { event.preventDefault(); this.over.set(true); }
  onDragLeave(event: DragEvent): void {
    if (!event.currentTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) this.over.set(false);
  }
  onDrop(event: DragEvent): void { event.preventDefault(); this.over.set(false); const file = event.dataTransfer?.files[0]; if (file) this.select(file); }
  onPicked(event: Event): void { const file = (event.target as HTMLInputElement).files?.[0]; if (file) this.select(file); (event.target as HTMLInputElement).value = ''; }

  remove(): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.service.deleteSongCover(this.song()).subscribe({
      next: () => { this.clearPreview(); this.busy.set(false); this.changed.emit(); },
      error: (err: unknown) => this.fail(err),
    });
  }

  ngOnDestroy(): void { this.clearPreview(); }

  private select(file: File): void {
    if (!file.type.startsWith('image/')) { this.error.set('Choose an image file.'); return; }
    if (file.size > 20 * 1024 * 1024) { this.error.set('Cover images must be 20 MB or smaller.'); return; }
    this.error.set('');
    this.clearPreview();
    this.objectUrl = URL.createObjectURL(file);
    this.preview.set(this.objectUrl);
    this.busy.set(true);
    this.service.uploadSongCover(this.song(), file).subscribe({
      next: () => { this.clearPreview(); this.busy.set(false); this.changed.emit(); },
      error: (err: unknown) => this.fail(err),
    });
  }

  private fail(err: unknown): void {
    this.busy.set(false);
    this.error.set(err instanceof HttpErrorResponse ? err.error?.detail || err.message : 'Cover update failed.');
  }

  private clearPreview(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.preview.set('');
  }
}
