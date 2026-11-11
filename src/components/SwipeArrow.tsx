import { memo, useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { SwipeDir } from "../lib/swipeNav";

/** The bubble's position, in px in from the panel's edge: out of sight, on the line, and the most it stretches past it. */
const HIDDEN = -60;
const REST = 22;
const STRETCH = 16;

interface ArrowControl {
  track(dir: SwipeDir, progress: number): void;
  commit(): void;
  cancel(): void;
}

let live: ArrowControl | null = null;

/** The trackpad swipe drives the arrow through this; until the arrow is mounted nothing happens. */
export const swipeArrow: ArrowControl = {
  track: (dir, progress) => live?.track(dir, progress),
  commit: () => live?.commit(),
  cancel: () => live?.cancel(),
};

const still = (): boolean =>
  document.documentElement.classList.contains("reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** In step with the fingers up to the line, then a rubber band that gives a little more. */
function offsetFor(progress: number): number {
  if (progress <= 1) return HIDDEN + (REST - HIDDEN) * progress;
  return REST + STRETCH * (1 - Math.exp(-(progress - 1) * 2));
}

/**
 * Chrome's history arrow, in ByTune's colours: it slides out of the panel's
 * left edge for back (the right edge for forward) in step with the swipe,
 * fills white with a ripple when the swipe crosses the line, then either
 * carries on and fades as the step is taken or slides back out of sight.
 * Driven imperatively by the wheel handler, so a swipe never re-renders React.
 */
export const SwipeArrow = memo(function SwipeArrow() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let dir: SwipeDir = "back";
    let at = HIDDEN; // where the bubble is
    let to = HIDDEN; // where it is heading
    let mode: "idle" | "track" | "leave" | "go" = "idle";
    let raf = 0;
    let lastFrame = 0;
    let fade = 0;

    const paint = (): void => {
      el.style.transform = `translate3d(${dir === "back" ? at : -at}px, 0, 0)`;
      el.style.opacity = String(Math.min(1, Math.max(0, (at - HIDDEN) / 36)));
    };
    const hide = (): void => {
      window.cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
      mode = "idle";
      at = to = HIDDEN;
      paint();
      el.classList.remove("is-on", "is-armed", "is-go");
    };
    // An eased follow on every frame: the wheel's uneven deltas arrive as one smooth slide.
    const frame = (now: number): void => {
      const dt = Math.min(64, lastFrame ? now - lastFrame : 16.7);
      lastFrame = now;
      const k = still() ? 1 : 1 - Math.pow(mode === "leave" ? 0.8 : 0.64, dt / 16.7);
      at += (to - at) * k;
      if (Math.abs(to - at) < 0.1) at = to;
      paint();
      if (at !== to) {
        raf = window.requestAnimationFrame(frame);
        return;
      }
      raf = 0;
      lastFrame = 0;
      if (mode === "leave") hide();
    };
    const run = (): void => {
      if (!raf) raf = window.requestAnimationFrame(frame);
    };

    live = {
      track(d, progress) {
        if (mode === "go") hide(); // a new swipe while the last step still fades
        if (d !== dir) {
          dir = d;
          el.dataset.dir = d;
          at = HIDDEN;
        }
        mode = "track";
        to = progress > 0 ? offsetFor(progress) : HIDDEN;
        el.classList.add("is-on");
        el.classList.toggle("is-armed", progress >= 1);
        run();
      },
      commit() {
        if (mode === "idle") return;
        mode = "go";
        to = Math.max(at, REST) + 18; // carries on inwards while it fades
        el.classList.add("is-on", "is-armed", "is-go");
        run();
        window.clearTimeout(fade);
        fade = window.setTimeout(hide, 340);
      },
      cancel() {
        if (mode !== "track") return;
        mode = "leave";
        to = HIDDEN;
        el.classList.remove("is-armed");
        run();
      },
    };

    return () => {
      live = null;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(fade);
    };
  }, []);

  return (
    <div ref={ref} className="swipe-arrow" data-dir="back" aria-hidden="true">
      <span className="swipe-arrow__ring" />
      <span className="swipe-arrow__bubble">
        <ArrowLeft className="swipe-arrow__icon swipe-arrow__icon--back" />
        <ArrowRight className="swipe-arrow__icon swipe-arrow__icon--forward" />
      </span>
    </div>
  );
});
