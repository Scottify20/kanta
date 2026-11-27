import { Component, inject, output, signal, viewChild } from '@angular/core';
import { PopupPanel } from '../../../../../shared/components/popup-panel/popup-panel';
import { PopupStateService } from '../../../../../shared/services/popup-state.service';
import { UserProfile } from '../../../../../shared/services/party-session.service';
import { QueueItem } from '../../../../queue/interfaces/queue.models';

@Component({
  selector: 'app-party-remove-singer',
  imports: [PopupPanel],
  templateUrl: './party-remove-singer.html',
  styleUrl: './party-remove-singer.scss',
})
export class PartyRemoveSinger {
  readonly singer = signal<UserProfile | null>(null);
  readonly assignedSongs = signal<QueueItem[]>([]);

  readonly confirmed = output<string>();
  readonly cancelled = output<void>();

  private readonly popup = viewChild.required(PopupPanel);
  private readonly popups = inject(PopupStateService);

  open(singer: UserProfile, assignedSongs: QueueItem[], event: MouseEvent): void {
    this.singer.set(singer);
    this.assignedSongs.set(assignedSongs);
    this.popup().openAt(event);
  }

  confirm(): void {
    const s = this.singer();
    if (s) {
      this.confirmed.emit(s.id);
      this.close();
    }
  }

  cancel(): void {
    this.close();
    this.cancelled.emit();
  }

  private close(): void {
    this.popups.close('player', 'party-singer-remove');
    this.singer.set(null);
    this.assignedSongs.set([]);
  }
}