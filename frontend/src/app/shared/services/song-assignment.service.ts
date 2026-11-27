import { inject, Injectable } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { PartySessionService, QueueSingerAssignment } from './party-session.service';
import { SongManifest } from './songs.service';
import { DuetAnalyzerService } from './duet-analyzer.service';
import { SongAssignmentDialog } from '../components/song-assignment-dialog/song-assignment-dialog';

@Injectable({ providedIn: 'root' })
export class SongAssignmentService {
  private readonly party = inject(PartySessionService);
  private readonly duetAnalyzer = inject(DuetAnalyzerService);
  private readonly overlay = inject(Overlay);

  async resolveAssignment(
    song: SongManifest,
    isDuet: boolean,
    anchor?: HTMLElement | MouseEvent | null,
    batchIndex = 1,
    batchTotal = 1,
    forcePrompt = false,
    customInitial?: QueueSingerAssignment,
  ): Promise<QueueSingerAssignment> {
    const roster = this.party.roster();

    if (!forcePrompt) {
      if (roster.length === 0) {
        return { primarySingerId: null, secondarySingerId: null, prioritySingerId: null };
      }
      if (roster.length === 1) {
        return { primarySingerId: roster[0].id, secondarySingerId: null, prioritySingerId: null };
      }
      const fitSinger = this.party.singerForFitSorting();
      if (fitSinger && roster.some((s) => s.id === fitSinger.id)) {
        return { primarySingerId: fitSinger.id, secondarySingerId: null, prioritySingerId: null };
      }
    }

    let initialAssignment: QueueSingerAssignment;
    if (customInitial) {
      initialAssignment = customInitial;
    } else {
      let initialPrimaryId = this.party.activeSingerId() ?? roster[0]?.id ?? null;
      let initialSecondaryId: string | null = null;
      if (isDuet) {
        try {
          const duetMatch = await Promise.race([
            this.duetAnalyzer.analyzeDuetParts(song, roster),
            new Promise<{ part1SingerId: null; part2SingerId: null }>((resolve) =>
              setTimeout(() => resolve({ part1SingerId: null, part2SingerId: null }), 1200),
            ),
          ]);
          if (duetMatch.part1SingerId) initialPrimaryId = duetMatch.part1SingerId;
          if (duetMatch.part2SingerId) initialSecondaryId = duetMatch.part2SingerId;
        } catch {}
      }
      initialAssignment = {
        primarySingerId: initialPrimaryId,
        secondarySingerId: initialSecondaryId,
        prioritySingerId: null,
      };
    }

    return this.showPromptDialog(song, isDuet, initialAssignment, anchor, batchIndex, batchTotal);
  }

  private showPromptDialog(
    song: SongManifest,
    isDuet: boolean,
    initial: QueueSingerAssignment,
    anchor?: HTMLElement | MouseEvent | null,
    batchIndex = 1,
    batchTotal = 1,
  ): Promise<QueueSingerAssignment> {
    return new Promise((resolve) => {
      let positionStrategy;

      if (anchor instanceof HTMLElement) {
        positionStrategy = this.overlay
          .position()
          .flexibleConnectedTo(anchor)
          .withPositions([
            { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
            { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
            { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
            { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
          ])
          .withPush(true)
          .withViewportMargin(16);
      } else if (anchor && 'clientX' in anchor) {
        positionStrategy = this.overlay
          .position()
          .flexibleConnectedTo({ x: anchor.clientX, y: anchor.clientY })
          .withPositions([
            { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
            { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
            { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
          ])
          .withPush(true)
          .withViewportMargin(16);
      } else {
        positionStrategy = this.overlay
          .position()
          .global()
          .centerHorizontally()
          .centerVertically();
      }

      let overlayRef: OverlayRef | null = this.overlay.create({
        hasBackdrop: true,
        backdropClass: 'cdk-overlay-transparent-backdrop',
        positionStrategy,
        scrollStrategy: this.overlay.scrollStrategies.reposition(),
      });

      const portal = new ComponentPortal(SongAssignmentDialog);
      const componentRef = overlayRef.attach(portal);

      componentRef.setInput('song', song);
      componentRef.setInput('isDuet', isDuet);
      componentRef.setInput('initialAssignment', initial);
      componentRef.setInput('batchIndex', batchIndex);
      componentRef.setInput('batchTotal', batchTotal);

      const cleanup = (result: QueueSingerAssignment): void => {
        if (overlayRef) {
          overlayRef.dispose();
          overlayRef = null;
        }
        resolve(result);
      };

      componentRef.instance.confirmed.subscribe((assignment) => cleanup(assignment));
      componentRef.instance.dismissed.subscribe((assignment) => cleanup(assignment));
      overlayRef.backdropClick().subscribe(() => componentRef.instance.dismiss());
    });
  }
}