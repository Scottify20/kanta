// @vitest-environment jsdom
import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { Injector, createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/app.ts';
import { OverlayScrollbarService } from '../src/app/shared/services/overlay-scrollbar.service.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('overlay scrollbar dragging', () => {
  it('keeps queue panels open, maps thumb movement to scrolling, and handles lost capture', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const injector = createEnvironmentInjector([{ provide: DOCUMENT, useValue: document }], Injector.NULL);
    const scrollbar = runInInjectionContext(injector, () => new OverlayScrollbarService());
    const panel = document.createElement('aside');
    panel.className = 'panel';
    const scroller = document.createElement('article');
    scroller.style.overflowY = 'auto';
    Object.defineProperties(scroller, {
      clientHeight: { value: 200, configurable: true },
      clientWidth: { value: 100 },
      clientTop: { value: 1 },
      clientLeft: { value: 0 },
      scrollHeight: { value: 1000, configurable: true },
    });
    scroller.getBoundingClientRect = () => ({
      top: 50, bottom: 252, left: 20, right: 120, width: 100, height: 202,
    });
    panel.appendChild(scroller);
    document.body.appendChild(panel);
    const thumb = document.querySelector('.kanta-overlay-scrollbar-thumb');
    Object.defineProperty(thumb, 'offsetHeight', { get: () => parseFloat(thumb.style.height) });
    let captured = null;
    thumb.setPointerCapture = (id) => { captured = id; };
    thumb.hasPointerCapture = (id) => captured === id;
    thumb.releasePointerCapture = () => { captured = null; };
    const pointer = (element, type, id, y, button = 0) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button });
      Object.defineProperty(event, 'pointerId', { value: id });
      element.dispatchEvent(event);
    };

    pointer(scroller, 'pointerover', 1, 0);
    expect(thumb.style.height).toBe('40px');
    expect(thumb.style.transform).toBe('translate(106px, 51px)');
    expect(scrollbar.isScrollbarInside(thumb, '.panel')).toBe(true);

    const app = Object.create(App.prototype);
    app.overlayScrollbar = scrollbar;
    app.layout = {
      sidebarOpen: () => false, queueOpen: () => true, dragActive: () => false,
      closeSidebar: vi.fn(), closeQueue: vi.fn(),
    };
    app.onOutsidePointer({ target: thumb, button: 0 });
    expect(app.layout.closeQueue).not.toHaveBeenCalled();
    app.onOutsidePointer({ target: document.body, button: 0 });
    expect(app.layout.closeQueue).toHaveBeenCalledOnce();

    pointer(thumb, 'pointerdown', 1, 60);
    expect(captured).toBe(1);
    pointer(thumb, 'pointermove', 2, 140);
    expect(scroller.scrollTop).toBe(0);
    pointer(thumb, 'pointermove', 1, 140);
    expect(scroller.scrollTop).toBe(400);
    pointer(thumb, 'lostpointercapture', 1, 140);
    expect(thumb.classList.contains('dragging')).toBe(false);
    expect(captured).toBeNull();
    pointer(thumb, 'pointermove', 1, 200);
    expect(scroller.scrollTop).toBe(400);

    pointer(thumb, 'pointerdown', 3, 140);
    Object.defineProperty(scroller, 'scrollHeight', { value: 200 });
    scroller.dispatchEvent(new Event('scroll'));
    expect(thumb.classList.contains('visible')).toBe(false);
    expect(thumb.classList.contains('dragging')).toBe(false);
    expect(captured).toBeNull();
    injector.destroy();
  });
});
