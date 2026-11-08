import { Injectable, computed, signal } from '@angular/core';

interface ActivePopup {
  group: string;
  id: string;
}

@Injectable({ providedIn: 'root' })
export class PopupStateService {
  private readonly active = signal<ActivePopup[]>([]);
  readonly anyOpen = computed(() => this.active().length > 0);

  isOpen(group: string, id: string): boolean {
    return this.active().some((active) => active.group === group && active.id === id);
  }

  toggle(group: string, id: string): void {
    this.active.update((activePopups) => {
      if (activePopups.some((active) => active.group === group && active.id === id)) {
        return activePopups.filter((active) => active.group !== group);
      }
      return [...activePopups.filter((active) => active.group !== group), { group, id }];
    });
  }

  open(group: string, id: string): void {
    this.active.update((active) => [...active.filter((popup) => popup.group !== group), { group, id }]);
  }

  closeAll(): void {
    this.active.set([]);
  }

  closeGroup(group: string): void {
    this.active.update((active) => active.filter((popup) => popup.group !== group));
  }

  close(group: string, id: string): void {
    if (this.isOpen(group, id)) {
      this.active.update((activePopups) =>
        activePopups.filter((active) => !(active.group === group && active.id === id)),
      );
    }
  }
}
