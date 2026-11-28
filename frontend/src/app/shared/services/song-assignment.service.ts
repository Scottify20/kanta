import { inject, Injectable } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { PartySessionService, QueueSingerAssignment } from './party-session.service';
import { SongManifest } from './songs.service';
import { DuetAnalyzerService } from './duet-analyzer.service';
import { SongAssignmentDialog } from '../components/song-assignment-dialog/song-assignment-dialog';

export interface AnchorPoint {
  x: number;
  y: number;
}

export type AssignmentAnchor = HTMLElement | MouseEvent | AnchorPoint | null | undefined;

@Injectable({ providedIn: 'root' })
export class SongAssignmentService {
  private readonly party = inject(PartySessionService);
  private readonly duetAnalyzer = inject(DuetAnalyzerService);
  private readonly overlay = inject(Overlay);

  /** Snapshots a stable viewport anchor point before async work or multi-song batch loops. */
  captureAnchor(anchor?: AssignmentAnchor): AnchorPoint | null {
    if (!anchor) return null;

    if (anchor instanceof HTMLElement) {
      if (!anchor.isConnected) return null;
      const rect = anchor.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 ? { x: rect.left, y: rect.top } : null;
    }

    if ('clientX' in anchor) {
      // For drag-and-drop, anchor directly to the drop coordinates rather than an underlying button.
      const isDrop = anchor.type === 'drop' || (typeof DragEvent !== 'undefined' && anchor instanceof DragEvent);
      if (!isDrop) {
        const target =
          anchor.target instanceof Element
            ? anchor.target.closest<HTMLElement>('[role="menuitem"], button')
            : null;
        if (target && target.isConnected) {
          const rect = target.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            return { x: rect.left, y: rect.top };
          }
        }
      }
      if (anchor.clientX === 0 && anchor.clientY === 0) return null;
      return { x: anchor.clientX, y: anchor.clientY };
    }

    if (typeof anchor.x === 'number' && typeof anchor.y === 'number') {
      return { x: anchor.x, y: anchor.y };
    }

    return null;
  }

  async resolveAssignment(
    song: SongManifest,
    isDuet: boolean,
    anchor?: AssignmentAnchor,
    batchIndex = 1,
    batchTotal = 1,
    forcePrompt = false,
    customInitial?: QueueSingerAssignment,
  ): Promise<QueueSingerAssignment> {
    const capturedPoint = this.captureAnchor(anchor);
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

    return this.showPromptDialog(song, isDuet, initialAssignment, anchor, capturedPoint, batchIndex, batchTotal);
  }

  private showPromptDialog(
    song: SongManifest,
    isDuet: boolean,
    initial: QueueSingerAssignment,
    anchor?: AssignmentAnchor,
    capturedPoint?: AnchorPoint | null,
    batchIndex = 1,
    batchTotal = 1,
  ): Promise<QueueSingerAssignment> {
    return new Promise((resolve) => {
      let positionStrategy;

      const liveElement = anchor instanceof HTMLElement && anchor.isConnected ? anchor : null;
      const target = liveElement ?? capturedPoint;

      if (target) {
        positionStrategy = this.overlay
          .position()
          .flexibleConnectedTo(target)
          .withFlexibleDimensions(false)
          .withPositions([
            // 1. Top-left of popover aligned to top-left of trigger / drop point
            { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
            // 2. Lower-left quadrant fallback
            { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 4 },
            // 3. Flip upward keeping left edge aligned
            { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'bottom' },
            // 4. Right-aligned fallbacks if near right viewport edge
            { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
            { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'bottom' },
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

      let rafId: number | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (!overlayRef) return;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = null;
          overlayRef?.updatePosition();
        });
      });
      resizeObserver.observe(overlayRef.overlayElement);

      const cleanup = (result: QueueSingerAssignment): void => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        resizeObserver.disconnect();
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