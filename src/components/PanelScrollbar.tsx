/**
 * The middle panel's scrollbar, drawn over the page. The native one takes a 14px strip of its own,
 * which cut every full-bleed cover short of the panel's right edge; so the scroller hides it
 * (no-scrollbar) and this thumb floats over the page in its place, sized and moved the native way.
 * It drags the page and lets the wheel through. The track takes no clicks: it lies over the page.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** However long the page, the thumb stays big enough to grab. */
const MIN_THUMB = 40;

const thumbSize = (view: number, page: number): number => Math.min(view, Math.max(MIN_THUMB, (view * view) / page));

export function PanelScrollbar({ target }: { target: RefObject<HTMLElement | null> }) {
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = target.current;
    const thumb = thumbRef.current;
    if (!el || !thumb) return;
    let frame = 0;
    const paint = (): void => {
      frame = 0;
      const { clientHeight, scrollHeight, scrollTop } = el;
      const range = scrollHeight - clientHeight;
      thumb.hidden = range < 1;
      if (thumb.hidden) return;
      const size = thumbSize(clientHeight, scrollHeight);
      const at = Math.min(Math.max(scrollTop, 0), range) / range;
      thumb.style.height = `${size}px`;
      thumb.style.transform = `translateY(${(clientHeight - size) * at}px)`;
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    // The panel's size, and the page's height: a new page, or one whose images came in.
    const sizes = new ResizeObserver(schedule);
    const watch = (): void => {
      sizes.disconnect();
      sizes.observe(el);
      for (const page of Array.from(el.children)) sizes.observe(page);
      schedule();
    };
    const pages = new MutationObserver(watch);
    pages.observe(el, { childList: true });
    watch();
    // Scrolling; and a page that settles without changing size, when an animation (a view's rise-in
    // starts it 10px low) or a transition ends.
    const moves = ["scroll", "animationend", "transitionend"];
    for (const type of moves) el.addEventListener(type, schedule, { passive: true });
    return () => {
      for (const type of moves) el.removeEventListener(type, schedule);
      pages.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [target]);

  const drag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = target.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const thumb = e.currentTarget;
    const startY = e.clientY;
    const startTop = el.scrollTop;
    // Page to scroll per pixel of drag: the page's range over the track the thumb can travel.
    const travel = el.clientHeight - thumbSize(el.clientHeight, el.scrollHeight);
    const perPx = (el.scrollHeight - el.clientHeight) / Math.max(1, travel);
    thumb.setPointerCapture(e.pointerId);
    thumb.dataset.dragging = "";
    const move = (ev: PointerEvent): void => {
      el.scrollTop = startTop + (ev.clientY - startY) * perPx;
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      delete thumb.dataset.dragging;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <div aria-hidden className="panel-scrollbar">
      <div
        ref={thumbRef}
        hidden
        className="panel-scrollbar-thumb"
        onPointerDown={drag}
        // The thumb isn't inside the scroller, so the wheel over it is passed on by hand.
        onWheel={(e) => target.current?.scrollBy({ top: e.deltaY })}
      />
    </div>
  );
}
