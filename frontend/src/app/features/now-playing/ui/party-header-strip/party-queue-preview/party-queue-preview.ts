import { Component, computed, inject, input } from '@angular/core';
import { PartySessionService, UserProfile } from '../../../../../shared/services/party-session.service';
import { QueueItem } from '../../../../queue/interfaces/queue.models';

@Component({
  selector: 'app-party-queue-preview',
  templateUrl: 'party-queue-preview.html',
  styleUrl: 'party-queue-preview.scss',
})
export class PartyQueuePreview {
  readonly queuePreview = input<QueueItem[]>([]);
  readonly playing = input(false);
  readonly currentTime = input(0);
  readonly duration = input(0);

  private readonly party = inject(PartySessionService);

  primarySingerFor(item: QueueItem): UserProfile | null {
    return this.party.queueSinger(item.task_id, 'primary') ?? this.party.activeSinger();
  }

  secondarySingerFor(item: QueueItem): UserProfile | null {
    return this.party.queueSinger(item.task_id, 'secondary');
  }

  isDuetTrack(item: QueueItem): boolean {
    return item.is_duet === true || this.secondarySingerFor(item) !== null;
  }

  upNextSingersLabel(item: QueueItem): string {
    const s1 = this.primarySingerFor(item);
    const s2 = this.secondarySingerFor(item);
    if (s1 && s2) return `${s1.name} & ${s2.name}`;
    return s1?.name ?? 'Singer';
  }

  isUpNext(item: QueueItem): boolean {
    const remaining = this.duration() - this.currentTime();
    return (
      this.playing() &&
      this.queuePreview()[0]?.task_id === item.task_id &&
      this.duration() > 0 &&
      remaining >= 0 &&
      remaining <= 18
    );
  }
}