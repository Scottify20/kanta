import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { Component, Directive, ElementRef, OnDestroy, inject, input, signal } from '@angular/core';

@Component({
  selector: 'app-tooltip-bubble',
  template: `<span class="kanta-tooltip" [class.leaving]="leaving()">{{ text() }}</span>`,
})
export class TooltipBubble {
  readonly text = signal('');
  readonly leaving = signal(false);
}

const SHOW_DELAY_MS = 350;
const LEAVE_MS = 120;

@Directive({
  selector: '[appTooltip]',
  host: {
    '(mouseenter)': 'schedule()',
    '(focus)': 'schedule()',
    '(mouseleave)': 'hide()',
    '(blur)': 'hide()',
    '(click)': 'hide()',
    '(dragstart)': 'hide()',
  },
})
export class Tooltip implements OnDestroy {
  readonly appTooltip = input.required<string>();
  readonly tooltipPosition = input<'above' | 'below'>('above');

  private readonly overlay = inject(Overlay);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private overlayRef: OverlayRef | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private bubble: TooltipBubble | null = null;

  schedule(): void {
    this.cancelLeave();
    if (this.overlayRef?.hasAttached() || this.showTimer || !this.appTooltip()) return;
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      this.show();
    }, SHOW_DELAY_MS);
  }

  hide(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (!this.overlayRef?.hasAttached() || this.leaveTimer) return;
    this.bubble?.leaving.set(true);
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      this.overlayRef?.detach();
    }, LEAVE_MS);
  }

  ngOnDestroy(): void {
    this.cancelLeave();
    if (this.showTimer) clearTimeout(this.showTimer);
    this.overlayRef?.dispose();
  }

  private cancelLeave(): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
      this.bubble?.leaving.set(false);
    }
  }

  private show(): void {
    const above = this.tooltipPosition() === 'above';
    const positions = [
      { originX: 'center', originY: above ? 'top' : 'bottom', overlayX: 'center', overlayY: above ? 'bottom' : 'top', offsetY: above ? -8 : 8 },
      { originX: 'center', originY: above ? 'bottom' : 'top', overlayX: 'center', overlayY: above ? 'top' : 'bottom', offsetY: above ? 8 : -8 },
    ] as const;
    const strategy = this.overlay
      .position()
      .flexibleConnectedTo(this.host.nativeElement)
      .withPositions([...positions])
      .withPush(true)
      .withViewportMargin(8);
    this.overlayRef ??= this.overlay.create({
      positionStrategy: strategy,
      scrollStrategy: this.overlay.scrollStrategies.close(),
      panelClass: 'kanta-tooltip-pane',
    });
    const ref = this.overlayRef.attach(new ComponentPortal(TooltipBubble));
    ref.instance.text.set(this.appTooltip());
    this.bubble = ref.instance;
  }
}
