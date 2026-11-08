import { afterEach, describe, expect, it, vi } from 'vitest';
import { stabilizeLyricsLayout } from '../src/app/features/now-playing/ui/lyrics-stage/lyrics-layout.ts';

describe('lyrics layout stabilization', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('repositions without animation while resizing and restores normal scrolling', () => {
    vi.useFakeTimers();
    let resize;
    let frame;
    const view = {
      requestAnimationFrame: vi.fn((callback) => { frame = callback; return 1; }),
      cancelAnimationFrame: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const observer = { observe: vi.fn(), disconnect: vi.fn() };
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resize = callback; }
      observe = observer.observe;
      disconnect = observer.disconnect;
    });
    const ticks = [];
    const element = {
      ownerDocument: { defaultView: view },
      isConnected: true,
      tickOptions: { lyricOffset: 2 },
      get currentTime() { return 73; },
      set currentTime(value) { ticks.push({ value, smooth: this.tickOptions.smoothScroll }); },
    };
    const stop = stabilizeLyricsLayout(element);
    resize();
    expect(element.tickOptions.smoothScroll).toBe(false);
    frame();
    expect(ticks).toEqual([{ value: 73, smooth: false }]);
    vi.advanceTimersByTime(100);
    resize();
    vi.advanceTimersByTime(100);
    expect(element.tickOptions.smoothScroll).toBe(false);
    frame();
    vi.advanceTimersByTime(50);
    expect(element.tickOptions).toEqual({ lyricOffset: 2 });
    stop();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(view.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function), true);
  });

  it('restores explicit options and cancels pending work on destruction', () => {
    vi.useFakeTimers();
    let resize;
    const view = {
      requestAnimationFrame: vi.fn(() => 4),
      cancelAnimationFrame: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const element = {
      ownerDocument: { defaultView: view },
      tickOptions: { smoothScroll: true, lyricOffset: 1 },
    };
    const stop = stabilizeLyricsLayout(element);
    resize();
    stop();
    expect(element.tickOptions).toEqual({ smoothScroll: true, lyricOffset: 1 });
    expect(view.cancelAnimationFrame).toHaveBeenCalledWith(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
