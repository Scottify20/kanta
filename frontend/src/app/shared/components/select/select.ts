import { Component, computed, input, model } from '@angular/core';
import { LucideCheck, LucideChevronDown } from '@lucide/angular';

import { PopupPanel } from '../popup-panel/popup-panel';

export interface SelectOption {
  value: string;
  label: string;
}

let nextId = 0;

@Component({
  selector: 'app-select',
  imports: [PopupPanel, LucideCheck, LucideChevronDown],
  templateUrl: './select.html',
  styleUrl: './select.scss',
})
export class Select {
  readonly options = input.required<SelectOption[]>();
  readonly value = model('');
  readonly label = input('Select');
  readonly popupId = `select-${nextId++}`;
  readonly selectedLabel = computed(
    () => this.options().find((option) => option.value === this.value())?.label ?? '',
  );
}
