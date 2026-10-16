import { Component, input, output } from '@angular/core';

export interface SettingsOption {
  value: string;
  label: string;
  description: string;
  note?: string;
  disabled?: boolean;
}

@Component({
  selector: 'app-settings-option-group',
  template: `
    <div class="option-grid" [class.compact-grid]="columns() === 3" role="group" [attr.aria-label]="label()">
      @for (option of options(); track option.value) {
        <button
          class="option-card"
          type="button"
          [class.selected]="selected() === option.value"
          [disabled]="option.disabled"
          [attr.aria-pressed]="selected() === option.value"
          (click)="selectedChange.emit(option.value)"
        >
          <span class="card-heading">
            <strong>{{ option.label }}</strong>
            @if (selected() === option.value) { <span class="selected-mark" aria-hidden="true">✓</span> }
          </span>
          <span class="card-description">{{ option.description }}</span>
          @if (option.note) { <span class="card-note">{{ option.note }}</span> }
        </button>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .option-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
    .option-grid.compact-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .option-card { display: grid; align-content: start; gap: .5rem; min-height: 5.5rem; padding: 1.1rem 1.25rem; border: 1px solid rgba(255,255,255,.1); border-radius: 1rem; color: rgba(255,255,255,.65); background: rgba(255,255,255,.04); text-align: left; cursor: pointer; transition: border-color var(--motion-fast), background var(--motion-fast), color var(--motion-fast); }
    .option-card:hover:not(:disabled) { border-color: rgba(255,255,255,.25); background: var(--surface-hover, rgba(255,255,255,.09)); }
    .option-card.selected { border-color: rgba(255,255,255,.7); color: #fff; background: rgba(255,255,255,.13); }
    .option-card:disabled { cursor: not-allowed; opacity: .45; }
    .card-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: #fff; font-size: .98rem; font-weight: 600; }
    .selected-mark { color: #fff; font-size: 1rem; }
    .card-description, .card-note { font-size: .82rem; line-height: 1.45; }
    .card-note { color: rgba(255,255,255,.5); }
    @media (max-width: 640px) { .option-grid, .option-grid.compact-grid { grid-template-columns: 1fr; } .option-card { min-height: 0; } }
  `,
})
export class SettingsOptionGroup {
  readonly label = input.required<string>();
  readonly options = input.required<SettingsOption[]>();
  readonly selected = input.required<string>();
  readonly columns = input(2);
  readonly selectedChange = output<string>();
}
