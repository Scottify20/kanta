import type { BraccatoLyricsElement } from '@braccato/core/element';

const RESIZE_SETTLE_MS = 150;

export function stabilizeLyricsLayout(element: BraccatoLyricsElement): () => void {
  const view = element.ownerDocument.defaultView;
  if (!view) return () => undefined;
  let originalSmooth: boolean | undefined;
  let settling = false;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const restore = (): void => {
    if (!settling) return;
    const options = { ...element.tickOptions };
    if (originalSmooth === undefined) delete options.smoothScroll;
    else options.smoothScroll = originalSmooth;
    element.tickOptions = options;
    settling = false;
  };
  const reposition = (): void => {
    if (!settling) {
      originalSmooth = element.tickOptions.smoothScroll;
      settling = true;
    }
    element.tickOptions = { ...element.tickOptions, smoothScroll: false };
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (element.isConnected) element.currentTime = element.currentTime;
    });
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      restore();
    }, RESIZE_SETTLE_MS);
  };

  const observer = new ResizeObserver(reposition);
  observer.observe(element);
  view.addEventListener('resize', reposition, true);
  return () => {
    observer.disconnect();
    view.removeEventListener('resize', reposition, true);
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    restore();
  };
}
