/**
 * Text that never ends in "…".
 *
 * One line (the default) runs to its edge and, when it doesn't fit, fades
 * there and slides to show the rest: on its own for what's playing (`auto`:
 * a pause, across, a pause, back) or while its row or card is hovered
 * (`hover`; that element carries `fit-host`). Two lines (`lines={2}`) wrap,
 * balanced, and fade the end of the second line instead of cutting it.
 * Text that fits sits still. Reduce animation stills every slide, and
 * whenever any of the text is hidden — or the title was shortened (`full`) —
 * the whole of it is the hover tooltip.
 */
import { useFullMotion } from "../lib/fullMotion";
import { FitText as FullFitText } from "./full/FitText";
import { useLayoutEffect, useRef } from "react";
import { motionResting, onMotionRest } from "../lib/motionRest";

/** Reading pace for a slide, in px per second. */
const SPEED = 40;
/** Width of the fade at the far edge (matches .fit-text's mask). */
const FADE = 24;
/** Passes an `auto` marquee makes before it rests at the start: a new title, reopening, or the
    pointer over it plays it again. Looping for a whole song kept WebKitGTK drawing every frame,
    and a second pass was ten more seconds of that after every song started. */
const AUTO_PASSES = 1;

const stilled = (): boolean =>
  document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// Every FitText measures in two steps — read its sizes, then write — and they
// run together, so a list of hundreds measures in one layout pass, not one each.
type Measure = () => () => void;
const runAll = (list: Iterable<Measure | undefined>): void => {
  const writes = [...list].map((m) => m?.());
  for (const w of writes) w?.();
};
const measures = new Map<Element, Measure>();
let observer: ResizeObserver | null = null;
function watch(els: Element[], measure: Measure): () => void {
  observer ??= new ResizeObserver((entries) => runAll(new Set(entries.map((e) => measures.get(e.target)))));
  for (const el of els) {
    measures.set(el, measure);
    observer.observe(el);
  }
  return () => {
    for (const el of els) {
      measures.delete(el);
      observer?.unobserve(el);
    }
  };
}
// New text whose box keeps its size (two clamped lines) gets no resize call.
const pending = new Set<Measure>();
let frame = 0;
function schedule(measure: Measure): void {
  pending.add(measure);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const list = [...pending];
    pending.clear();
    runAll(list);
  });
}
// Web fonts can land after the first measure and change every width.
if (typeof document !== "undefined") {
  document.fonts?.addEventListener?.("loadingdone", () => runAll(new Set(measures.values())));
}

function LiteFitText({
  text,
  full,
  className = "",
  lines = 1,
  mode = "hover",
  followsPlayback = false,
}: {
  text: string;
  /** The title before shortening; when it differs, it's the hover tooltip. */
  full?: string;
  className?: string;
  lines?: 1 | 2;
  mode?: "hover" | "auto";
  /** What's playing (player bar, Now Playing): the marquee also holds still while nothing plays. */
  followsPlayback?: boolean;
}) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = outer.current;
    const body = inner.current;
    if (!el || !body) return;
    let running: Animation[] = [];
    let slidingBy = 0;
    const stop = (): void => {
      for (const a of running) a.cancel();
      running = [];
      slidingBy = 0;
    };
    const measure: Measure = () => {
      const over = lines === 1 ? body.offsetWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
      return () => {
        const hidden = over > 1;
        el.toggleAttribute("data-over", hidden);
        const tip = hidden ? (full ?? text) : full && full !== text ? full : "";
        if (tip) el.setAttribute("title", tip);
        else el.removeAttribute("title");
        if (lines !== 1) return;
        const shift = hidden ? Math.round(over + FADE) : 0;
        el.style.setProperty("--fit-shift", `${-shift}px`);
        el.style.setProperty("--fit-time", `${Math.max(1, shift / SPEED).toFixed(2)}s`);
        const auto = mode === "auto" && hidden && !stilled();
        if (auto && slidingBy === shift) return;
        stop();
        if (!auto) return;
        // What's playing: rest, slide to the end, rest, slide back — and again.
        const slide = Math.max(1.2, shift / SPEED);
        const rest = 2.4;
        const total = 2 * (rest + slide);
        const at = (t: number): number => t / total;
        slidingBy = shift;
        running = [
          body.animate(
            [
              { transform: "translateX(0)", offset: 0 },
              { transform: "translateX(0)", offset: at(rest), easing: "ease-in-out" },
              { transform: `translateX(${-shift}px)`, offset: at(rest + slide) },
              { transform: `translateX(${-shift}px)`, offset: at(2 * rest + slide), easing: "ease-in-out" },
              { transform: "translateX(0)", offset: 1 },
            ],
            { duration: total * 1000, iterations: AUTO_PASSES }
          ),
          // The near edge fades only while the start of the line is out of view. It switches in
          // one step each way: easing the mask repainted the line through it on every frame.
          el.animate(
            [
              { "--fit-fade": "0px", offset: 0, easing: "step-end" },
              { "--fit-fade": "14px", offset: at(rest + 0.2), easing: "step-end" },
              { "--fit-fade": "0px", offset: at(2 * rest + 2 * slide - 0.2), easing: "step-end" },
              { "--fit-fade": "0px", offset: 1 },
            ],
            { duration: total * 1000, iterations: AUTO_PASSES }
          ),
        ];
        // The marquee dresses what's playing: paused, or with the window away, it holds where it is.
        if (motionResting(followsPlayback)) for (const a of running) a.pause();
      };
    };
    const unrest = mode === "auto" ? onMotionRest(() => {
      const rest = motionResting(followsPlayback);
      for (const a of running) {
        if (rest) a.pause();
        else if (a.playState === "paused") a.play(); // resumes; a marquee that finished stays at rest
      }
    }) : () => undefined;
    // Pointing at a rested marquee plays its passes again.
    const replay = (): void => {
      if (mode !== "auto" || !running.length || motionResting(followsPlayback)) return;
      if (running.every((a) => a.playState === "finished")) for (const a of running) a.play();
    };
    el.addEventListener("pointerenter", replay);
    const unwatch = watch(lines === 1 ? [el, body] : [el], measure);
    schedule(measure);
    return () => {
      el.removeEventListener("pointerenter", replay);
      unrest();
      unwatch();
      pending.delete(measure);
      stop();
    };
  }, [text, full, lines, mode, followsPlayback]);

  if (lines === 2) {
    return (
      <span ref={outer} className={`fit-lines ${className}`}>
        <span ref={inner}>{text}</span>
      </span>
    );
  }
  return (
    <span ref={outer} className={`fit-text ${className}`} data-mode={mode}>
      <span ref={inner} className="fit-in">
        {text}
      </span>
    </span>
  );
}

/** The original marquee (looping) where full animations are on (lib/fullMotion), else the lighter one. */
export function FitText(props: React.ComponentProps<typeof LiteFitText>) {
  const { followsPlayback, ...rest } = props;
  return useFullMotion() ? <FullFitText {...rest} /> : <LiteFitText {...props} followsPlayback={followsPlayback} />;
}
