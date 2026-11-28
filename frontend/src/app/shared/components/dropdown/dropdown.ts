import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

export interface DropdownOption<T = string> {
  value: T;
  label: string;
  badge?: string;
}

@Component({
  selector: 'app-dropdown',
  templateUrl: `dropdown.html`,
  styleUrl: `dropdown.scss`,
})
export class Dropdown<T = string> {
  readonly options = input.required<readonly DropdownOption<T>[]>();
  readonly value = input<T | null>(null);
  readonly placeholder = input('Select…');
  readonly disabled = input(false);
  readonly valueChange = output<T>();

  readonly open = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly selectedOption = computed(
    () => this.options().find((o) => o.value === this.value()) ?? null,
  );

  toggle(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.disabled()) this.open.update((v) => !v);
  }

  pick(val: T, event: MouseEvent): void {
    event.stopPropagation();
    this.valueChange.emit(val);
    this.open.set(false);
  }

  @HostListener('document:pointerdown', ['$event'])
  onOutside(event: PointerEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.open.set(false);
  }
}