import {
  Component,
  ViewEncapsulation,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { LucideChevronLeft } from '@lucide/angular';

export interface SubmenuNav {
  id: string;
  title: string;
}

@Component({
  selector: 'app-context-menu',
  imports: [LucideChevronLeft],
  templateUrl: './context-menu.html',
  styleUrl: './context-menu.scss',
  encapsulation: ViewEncapsulation.None,
  exportAs: 'contextMenu',
})
export class ContextMenu {
  readonly x = input<number | null>(null);
  readonly y = input<number | null>(null);
  readonly minWidth = input('11rem');
  readonly maxWidth = input<string | null>(null);
  readonly ariaLabel = input('Context options');
  readonly background = input<string | null>(null);

  readonly viewChange = output<string>();

  readonly isFloating = computed(() => this.x() !== null && this.y() !== null);

  private readonly navStack = signal<SubmenuNav[]>([]);
  readonly currentView = computed(() => {
    const stack = this.navStack();
    return stack.length > 0 ? stack[stack.length - 1].id : 'root';
  });
  readonly currentTitle = computed(() => {
    const stack = this.navStack();
    return stack.length > 0 ? stack[stack.length - 1].title : '';
  });
  readonly isSubmenu = computed(() => this.navStack().length > 0);

  openSubmenu(viewId: string, title = 'Back'): void {
    this.navStack.update((stack) => [...stack, { id: viewId, title }]);
    this.viewChange.emit(viewId);
  }

  back(): void {
    this.navStack.update((stack) => stack.slice(0, -1));
    this.viewChange.emit(this.currentView());
  }

  reset(): void {
    this.navStack.set([]);
    this.viewChange.emit('root');
  }

  isView(id: string): boolean {
    return this.currentView() === id;
  }

  onMouseDown(event: MouseEvent): void {
    if (this.isFloating()) {
      event.preventDefault();
    }
  }

  onClick(event: MouseEvent): void {
    if (this.isFloating()) {
      event.stopPropagation();
    }
  }
}