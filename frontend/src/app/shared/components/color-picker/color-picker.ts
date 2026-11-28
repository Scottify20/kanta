import { Component, computed, input, output } from '@angular/core';
import { PROFILE_COLOR_PRESETS } from '../../services/party-session.models';

@Component({
  selector: 'app-color-picker',
  templateUrl: `color-picker.html`,
  styleUrl: `color-picker.scss`,
})
export class ColorPicker {
  readonly label = input('Accent color');
  readonly value = input('#4a8f8c');
  readonly presets = input<readonly string[]>(PROFILE_COLOR_PRESETS);
  readonly valueChange = output<string>();

  readonly isCustom = computed(
    () => !this.presets().some((c) => c.toLowerCase() === this.value().toLowerCase()),
  );

  isSelected(color: string): boolean {
    return color.toLowerCase() === this.value().toLowerCase();
  }
}