import { Component, input } from '@angular/core';

@Component({
  selector: 'app-settings-section',
  template: `
    <section class="settings-section">
      <header>
        <h2>{{ title() }}</h2>
        <p>{{ description() }}</p>
      </header>
      <div class="section-content"><ng-content /></div>
    </section>
  `,
  styles: `
    :host { display: block; }
    .settings-section { display: grid; gap: 1.25rem; padding: 1.5rem; border: 1px solid rgba(255,255,255,.09); border-radius: 1.25rem; background: rgba(0,0,0,.28); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); }
    header { display: grid; gap: .3rem; max-width: 36rem; }
    h2 { margin: 0; color: #fff; font-size: 1.15rem; font-weight: 600; }
    p { margin: 0; color: rgba(255,255,255,.58); font-size: .88rem; line-height: 1.5; }
    .section-content { display: grid; gap: 1rem; min-width: 0; }
    @media (max-width: 620px) { .settings-section { padding: 1.1rem; border-radius: 1rem; } }
  `,
})
export class SettingsSection {
  readonly title = input.required<string>();
  readonly description = input.required<string>();
}
