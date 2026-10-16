const EDGE_PX = 64;
const MAX_STEP_PX = 22;

// Native drags don't scroll containers on their own; call this from dragover (which keeps firing while the
// pointer is held still) to scroll any listed container whose edge the pointer is near or just beyond.
export function autoScrollDuringDrag(event: DragEvent, containers: Iterable<HTMLElement>): void {
  for (const el of containers) {
    const rect = el.getBoundingClientRect();
    if (event.clientX < rect.left - EDGE_PX || event.clientX > rect.right + EDGE_PX) continue;
    const fromTop = event.clientY - rect.top;
    const fromBottom = rect.bottom - event.clientY;
    let step = 0;
    if (fromTop > -EDGE_PX && fromTop < EDGE_PX) step = -MAX_STEP_PX * Math.min(1, (EDGE_PX - fromTop) / (EDGE_PX * 1.5));
    else if (fromBottom > -EDGE_PX && fromBottom < EDGE_PX) step = MAX_STEP_PX * Math.min(1, (EDGE_PX - fromBottom) / (EDGE_PX * 1.5));
    if (!step) continue;
    const before = el.scrollTop;
    el.scrollTop += step;
    if (el.scrollTop !== before) return;
  }
}
