import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import {
  Component,
  TemplateRef,
  ViewContainerRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  OnDestroy,
} from '@angular/core';
import { LucideExternalLink, LucideGripVertical, LucideKeyRound, LucideListOrdered, LucideX } from '@lucide/angular';

import { LyricsProviderInfo, LyricsSettings, SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-settings-lyrics',
  imports: [DragDropModule, LucideExternalLink, LucideGripVertical, LucideKeyRound, LucideListOrdered, LucideX],
  templateUrl: './settings-lyrics.html',
  styleUrl: './settings-lyrics.scss',
})
export class SettingsLyrics implements OnDestroy {
  private readonly overlay = inject(Overlay);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly modalTpl = viewChild.required<TemplateRef<unknown>>('modalTpl');
  private overlayRef: OverlayRef | null = null;
  private readonly settings = inject(SettingsService);
  readonly providers = signal<LyricsProviderInfo[]>([]);
  readonly autoFetch = signal(true);
  readonly error = signal('');
  readonly open = signal(false);
  readonly expanded = signal<string | null>(null);
  readonly enabledCount = computed(() => this.providers().filter((provider) => provider.enabled).length);

  constructor() {
    // The modal is rendered in a body-level overlay so scroll containers and transformed ancestors can't anchor it.
    effect(() => {
      if (this.open()) {
        if (this.overlayRef) return;
        this.overlayRef = this.overlay.create({
          positionStrategy: this.overlay.position().global(),
          scrollStrategy: this.overlay.scrollStrategies.block(),
        });
        this.overlayRef.keydownEvents().subscribe((e) => e.key === 'Escape' && this.open.set(false));
        this.overlayRef.attach(new TemplatePortal(this.modalTpl(), this.viewContainer));
      } else {
        this.overlayRef?.dispose();
        this.overlayRef = null;
      }
    });
    this.settings.getLyricsSettings().subscribe({
      next: (value) => this.apply(value),
      error: () => this.error.set('Could not load lyrics settings.'),
    });
  }

  setProvider(provider: LyricsProviderInfo, enabled: boolean): void {
    this.providers.update((list) => list.map((entry) => (entry.id === provider.id ? { ...entry, enabled } : entry)));
    this.save({ providers: { [provider.id]: enabled } });
  }

  setAutoFetch(enabled: boolean): void {
    this.autoFetch.set(enabled);
    this.save({ auto_fetch: enabled });
  }

  drop(event: CdkDragDrop<LyricsProviderInfo[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    const list = [...this.providers()];
    moveItemInArray(list, event.previousIndex, event.currentIndex);
    this.providers.set(list);
    this.save({ order: list.map((provider) => provider.id) });
  }

  toggleKeys(id: string): void {
    this.expanded.update((current) => (current === id ? null : id));
  }

  hasKeys(provider: LyricsProviderInfo): boolean {
    return provider.key_fields.filter((field) => field.id !== 'storefront').every((field) => !!field.value.trim());
  }

  setKey(provider: LyricsProviderInfo, fieldId: string, value: string): void {
    const fields = provider.key_fields.map((field) => (field.id === fieldId ? { ...field, value } : field));
    this.providers.update((list) =>
      list.map((entry) => (entry.id === provider.id ? { ...entry, key_fields: fields } : entry)),
    );
    this.save({ keys: { [provider.id]: Object.fromEntries(fields.map((field) => [field.id, field.value])) } });
  }

  private save(update: Parameters<SettingsService['updateLyricsSettings']>[0]): void {
    this.settings.updateLyricsSettings(update).subscribe({
      next: (value) => {
        this.error.set('');
        this.apply(value);
      },
      error: () => {
        this.error.set('Could not save lyrics settings.');
        this.settings.getLyricsSettings().subscribe((value) => this.apply(value));
      },
    });
  }

  private apply(value: LyricsSettings): void {
    this.providers.set(value.providers);
    this.autoFetch.set(value.auto_fetch);
  }

  ngOnDestroy(): void {
    this.overlayRef?.dispose();
  }
}
