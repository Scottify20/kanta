import { Component, input, linkedSignal, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SongManifest } from '../../../../shared/services/songs.service';

@Component({
  selector: 'app-metadata-editor',
  imports: [FormsModule],
  templateUrl: './metadata-editor.html',
  styleUrl: './metadata-editor.scss',
})
export class MetadataEditor {
  readonly song = input.required<SongManifest>();
  readonly saving = input(false);
  readonly error = input('');
  readonly save = output<Pick<SongManifest, 'artist' | 'album' | 'title'>>();
  readonly close = output<void>();

  readonly metadata = linkedSignal(() => {
    const song = this.song();
    return { artist: song.artist, album: song.album, title: song.title };
  });

  updateMetadata(field: 'artist' | 'album' | 'title', value: string): void {
    this.metadata.update((metadata) => ({ ...metadata, [field]: value }));
  }

  submit(): void {
    this.save.emit(this.metadata());
  }
}
