import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { AppSettings, SettingsService } from '../../shared/services/settings.service';
import { Settings } from './settings';

describe('Settings', () => {
  it('adds output roots and saves the chosen default and model directory', () => {
    const savedSettings: AppSettings = {
      output_dir: '/library/main',
      output_dirs: ['/library/main', '/library/archive'],
      default_output_dir: '/library/archive',
      model_dir: '/models/custom',
    };
    const updateSettings = vi.fn(() => of(savedSettings));
    TestBed.configureTestingModule({
      imports: [Settings],
      providers: [
        provideRouter([]),
        {
          provide: SettingsService,
          useValue: {
            getSettings: () =>
              of({
                output_dir: '/library/main',
                output_dirs: ['/library/main'],
                default_output_dir: '/library/main',
                model_dir: '/models/default',
              }),
            updateSettings,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(Settings);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    component.newOutputDir.set('/library/archive');
    component.addOutputDir();
    component.defaultOutputDir.set('/library/archive');
    component.modelDir.set('/models/custom');

    component.save();

    expect(updateSettings).toHaveBeenCalledWith({
      output_dirs: ['/library/main', '/library/archive'],
      default_output_dir: '/library/archive',
      model_dir: '/models/custom',
    });
    expect(component.saved()).toBe(true);
  });
});
