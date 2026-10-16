import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideWandSparkles } from '@lucide/angular';
import { MetadataDraft } from './metadata-editor';
import { SongManifest, SongsService } from '../../../../shared/services/songs.service';

@Component({
  selector: 'app-replaygain-panel',
  imports: [FormsModule, LucideWandSparkles],
  templateUrl: './replaygain-panel.html',
  styleUrl: './replaygain-panel.scss',
})
export class ReplaygainPanel {
  readonly song = input.required<SongManifest>();
  readonly values = input.required<MetadataDraft>();
  readonly valueChange = output<{ field: keyof MetadataDraft; value: string }>();
  readonly changed = output<void>();
  readonly analyzing = signal(false);
  readonly error = signal('');
  private readonly service = inject(SongsService);

  set(field: keyof MetadataDraft, value: string): void { this.valueChange.emit({ field, value }); }

  analyze(): void {
    if (this.analyzing()) return;
    this.analyzing.set(true); this.error.set('');
    this.service.analyzeSongReplayGain(this.song()).subscribe({
      next: (result) => {
        this.set('replaygain_track_gain', result.replaygain_track_gain == null ? '' : String(result.replaygain_track_gain));
        this.set('replaygain_track_peak', result.replaygain_track_peak == null ? '' : String(result.replaygain_track_peak));
        this.analyzing.set(false); this.changed.emit();
      },
      error: (err: unknown) => {
        this.analyzing.set(false);
        this.error.set(err instanceof HttpErrorResponse ? err.error?.detail || err.message : 'ReplayGain analysis failed.');
      },
    });
  }
}
