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
    .option-card { display: grid; align-content: start; gap: .6rem; min-height: 6.7rem; padding: 1rem 1.05rem; border: 1px solid rgba(255,255,255,.12); border-radius: var(--radius-md, .75rem); color: rgba(255,255,255,.7); background: rgba(255,255,255,.045); text-align: left; cursor: pointer; transition: border-color var(--motion-fast, 160ms), background var(--motion-fast, 160ms), transform var(--motion-fast, 160ms); }
    .option-card:hover:not(:disabled) { border-color: rgba(255,255,255,.3); background: var(--surface-hover, rgba(255,255,255,.1)); transform: translateY(-1px); }
    .option-card.selected { border-color: rgba(244,178,151,.8); color: #fff; background: rgba(244,178,151,.11); box-shadow: inset 0 0 0 1px rgba(244,178,151,.14); }
    .option-card:disabled { cursor: not-allowed; opacity: .45; }
    .card-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: #fff; font-size: .95rem; }
    .selected-mark { color: #f4b297; font-size: 1rem; }
    .card-description, .card-note { font-size: .78rem; line-height: 1.45; }
    .card-note { color: #efb69e; }
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
