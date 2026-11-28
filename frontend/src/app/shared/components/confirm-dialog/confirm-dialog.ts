import { Component, HostListener, input, output } from '@angular/core';

@Component({
  selector: 'app-confirm-dialog',
  templateUrl: `confirm-dialog.html`,
  styleUrl: `confirm-dialog.scss`,
})
export class ConfirmDialog {
  readonly title = input('Confirm');
  readonly message = input('');
  readonly confirmLabel = input('Delete');

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }
}