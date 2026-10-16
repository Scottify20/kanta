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
    .settings-section { display: grid; gap: 1.15rem; }
    header { display: grid; gap: 0.35rem; }
    h2 { margin: 0; color: #fff; font-size: 1.12rem; font-weight: 650; letter-spacing: -0.02em; }
    p { margin: 0; color: rgba(255,255,255,.58); font-size: .88rem; line-height: 1.5; }
    .section-content { min-width: 0; }
  `,
})
export class SettingsSection {
  readonly title = input.required<string>();
  readonly description = input.required<string>();
}
