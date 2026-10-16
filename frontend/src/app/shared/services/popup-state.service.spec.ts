import { TestBed } from '@angular/core/testing';

import { PopupStateService } from './popup-state.service';

describe('PopupStateService', () => {
  let service: PopupStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PopupStateService);
  });

  it('replaces an open popup only within the same group', () => {
    service.toggle('player', 'volume');
    service.toggle('player', 'timing');
    service.toggle('settings', 'folder-menu');

    expect(service.isOpen('player', 'volume')).toBe(false);
    expect(service.isOpen('player', 'timing')).toBe(true);
    expect(service.isOpen('settings', 'folder-menu')).toBe(true);
  });

  it('closes only the requested popup', () => {
    service.toggle('player', 'volume');
    service.toggle('settings', 'folder-menu');

    service.close('player', 'volume');

    expect(service.isOpen('player', 'volume')).toBe(false);
    expect(service.isOpen('settings', 'folder-menu')).toBe(true);
  });
});
