import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';

import { PopupStateService } from '../../services/popup-state.service';

@Component({
  selector: 'app-popup-panel',
  templateUrl: './popup-panel.html',
  styleUrl: './popup-panel.scss',
})
export class PopupPanel {
  private readonly popupState = inject(PopupStateService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly popupId = input.required<string>();
  readonly group = input('player');
  readonly label = input('Options');
  readonly placement = input<'above' | 'below'>('above');
  readonly closeOnContentClick = input(false);
  readonly isOpen = computed(() => this.popupState.isOpen(this.group(), this.popupId()));

  constructor() {
    effect(() => {
      this.host.nativeElement
        .querySelector('[popup-trigger]')
        ?.setAttribute('aria-expanded', String(this.isOpen()));
    });
  }

  @HostListener('click', ['$event'])
  onHostClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const trigger = target.closest('[popup-trigger]');
    if (trigger && this.host.nativeElement.contains(trigger)) {
      this.popupState.toggle(this.group(), this.popupId());
      return;
    }
    const content = target.closest('[popup-content]');
    if (content && this.host.nativeElement.contains(content)) {
      if (this.closeOnContentClick() && target.closest('button,[role="menuitem"]')) {
        this.popupState.close(this.group(), this.popupId());
      }
      return;
    }
    this.popupState.close(this.group(), this.popupId());
  }

  @HostListener('document:click', ['$event'])
  onOutsideClick(event: MouseEvent): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.popupState.close(this.group(), this.popupId());
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.popupState.close(this.group(), this.popupId());
  }
}
