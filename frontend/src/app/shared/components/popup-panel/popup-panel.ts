import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  TemplateRef,
  ViewContainerRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { PopupStateService } from '../../services/popup-state.service';

const LEAVE_MS = 160;

@Component({
  selector: 'app-popup-panel',
  templateUrl: './popup-panel.html',
  styleUrl: './popup-panel.scss',
  encapsulation: ViewEncapsulation.None,
})
export class PopupPanel {
  private readonly popupState = inject(PopupStateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlay = inject(Overlay);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly panel = viewChild.required<TemplateRef<unknown>>('panel');

  readonly popupId = input.required<string>();
  readonly group = input('player');
  readonly label = input('Options');
  readonly placement = input<'above' | 'below'>('above');
  readonly closeOnContentClick = input(false);
  readonly isOpen = computed(() => this.popupState.isOpen(this.group(), this.popupId()));
  readonly leaving = signal(false);

  private overlayRef: OverlayRef | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const open = this.isOpen();
      this.host.nativeElement
        .querySelector('[popup-trigger]')
        ?.setAttribute('aria-expanded', String(open));
      open ? this.attach() : this.detach();
    });
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  @HostListener('click', ['$event'])
  onHostClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target;
    if (target instanceof Element && target.closest('[popup-trigger]')) {
      this.popupState.toggle(this.group(), this.popupId());
    }
  }

  onContentClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target;
    if (
      this.closeOnContentClick() &&
      target instanceof Element &&
      target.closest('button,[role="menuitem"]')
    ) {
      this.popupState.close(this.group(), this.popupId());
    }
  }

  @HostListener('document:click', ['$event'])
  onOutsideClick(event: MouseEvent): void {
    const target = event.target as Node;
    if (!this.host.nativeElement.contains(target) && !this.overlayRef?.overlayElement.contains(target)) {
      this.popupState.close(this.group(), this.popupId());
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.popupState.close(this.group(), this.popupId());
  }

  private attach(): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    this.leaving.set(false);
    if (this.overlayRef?.hasAttached()) {
      return;
    }
    const above = this.placement() === 'above';
    const anchor = this.host.nativeElement.querySelector('.popup-anchor') ?? this.host.nativeElement;
    const strategy = this.overlay
      .position()
      .flexibleConnectedTo(anchor as HTMLElement)
      .withFlexibleDimensions(false)
      .withPush(true)
      .withViewportMargin(12)
      .withPositions([
        { originX: 'end', originY: above ? 'top' : 'bottom', overlayX: 'end', overlayY: above ? 'bottom' : 'top', offsetY: above ? -10 : 10 },
        { originX: 'end', originY: above ? 'bottom' : 'top', overlayX: 'end', overlayY: above ? 'top' : 'bottom', offsetY: above ? 10 : -10 },
        { originX: 'start', originY: above ? 'top' : 'bottom', overlayX: 'start', overlayY: above ? 'bottom' : 'top', offsetY: above ? -10 : 10 },
        { originX: 'start', originY: above ? 'bottom' : 'top', overlayX: 'start', overlayY: above ? 'top' : 'bottom', offsetY: above ? 10 : -10 },
      ]);
    this.overlayRef ??= this.overlay.create({
      positionStrategy: strategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: 'kanta-popup-pane',
    });
    this.overlayRef.updatePositionStrategy(strategy);
    this.overlayRef.attach(new TemplatePortal(this.panel(), this.viewContainer));
  }

  private detach(): void {
    if (!this.overlayRef?.hasAttached() || this.leaveTimer) {
      return;
    }
    this.leaving.set(true);
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      this.overlayRef?.detach();
      this.leaving.set(false);
    }, LEAVE_MS);
  }

  private dispose(): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer);
    }
    this.overlayRef?.dispose();
    this.overlayRef = null;
  }
}
