import { Component, inject, signal } from '@angular/core';

import { LyricsProviderInfo, SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-settings-lyrics',
  template: `
    <div class="rows" role="group" aria-label="Lyrics providers">
      @for (provider of providers(); track provider.id) {
        <label class="row">
          <span class="text">
            <strong>{{ provider.label }}</strong>
            <small>{{ provider.description }}</small>
          </span>
          <input type="checkbox" role="switch" [checked]="provider.enabled" (change)="setProvider(provider, $any($event.target).checked)" />
        </label>
      }
      <label class="row">
        <span class="text">
          <strong>Fetch lyrics automatically</strong>
          <small>When a song is added to the karaoke queue or about to play without word-level lyrics, look for better ones.</small>
        </span>
        <input type="checkbox" role="switch" [checked]="autoFetch()" (change)="setAutoFetch($any($event.target).checked)" />
      </label>
    </div>
    @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
  `,
  styles: `
    :host { display: block; }
    .rows { display: grid; gap: .5rem; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .8rem 1rem; border: 1px solid rgba(255,255,255,.09); border-radius: .9rem; background: rgba(255,255,255,.04); cursor: pointer; }
    .text { display: grid; gap: .2rem; min-width: 0; }
    strong { color: #fff; font-size: .92rem; font-weight: 600; }
    small { color: rgba(255,255,255,.58); font-size: .8rem; line-height: 1.4; }
    input { flex: none; width: 2.6rem; height: 1.4rem; margin: 0; appearance: none; border-radius: 999px; background: rgba(255,255,255,.2); cursor: pointer; position: relative; transition: background .15s; }
    input::after { content: ''; position: absolute; top: .15rem; left: .15rem; width: 1.1rem; height: 1.1rem; border-radius: 50%; background: #fff; transition: transform .15s; }
    input:checked { background: #4caf7a; }
    input:checked::after { transform: translateX(1.2rem); }
    .error { margin: .5rem 0 0; color: #ff8a80; font-size: .85rem; }
  `,
})
export class SettingsLyrics {
  private readonly settings = inject(SettingsService);
  readonly providers = signal<LyricsProviderInfo[]>([]);
  readonly autoFetch = signal(true);
  readonly error = signal('');

  constructor() {
    this.settings.getLyricsSettings().subscribe({
      next: (value) => this.apply(value),
      error: () => this.error.set('Could not load lyrics settings.'),
    });
  }

  setProvider(provider: LyricsProviderInfo, enabled: boolean): void {
    this.save({ providers: { [provider.id]: enabled } });
  }

  setAutoFetch(enabled: boolean): void {
    this.save({ auto_fetch: enabled });
  }

  private save(update: { providers?: Record<string, boolean>; auto_fetch?: boolean }): void {
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

  private apply(value: { providers: LyricsProviderInfo[]; auto_fetch: boolean }): void {
    this.providers.set(value.providers);
    this.autoFetch.set(value.auto_fetch);
  }
}
