/**
 * Two-finger trackpad swipes walk the view history, as in Chrome: a sideways
 * swipe that nothing under the pointer can scroll any further brings out an
 * arrow at the panel's edge that follows the fingers. Letting go past the
 * line (see `swipeLine`) goes back (fingers moving right) or forward (fingers
 * moving left); letting go short of it, or sliding back under it first, puts
 * the arrow away. One step per gesture, and only where there is history to
 * walk.
 *
 * The page never sees the fingers leave the pad, so that is read off the
 * wheel: the deltas going quiet, or settling into momentum's smooth decay
 * (the scroll that coasts on after the fingers lift). Coasting never counts
 * toward the line: only the fingers' own travel does, as in Chrome.
 */

/** Chrome makes a touchpad swipe travel this share of the window's width... */
const CHROME_SHARE = 0.3;
/** ...and never less than this, on a narrow window. */
const CHROME_MIN_PX = 180;
/** ByTune's first swipe stepped after only this much, so slight drags went back and forward. */
const FIRST_PX = 150;
/** Quiet this long after the last delta: the fingers have stopped or lifted. */
export const SWIPE_LIFT_MS = 140;
/** Quiet this long ends the gesture, its momentum included. */
export const SWIPE_GAP_MS = 300;
/** Travel, in px, after which a gesture's axis is decided. */
const AXIS_PX = 8;
/** Momentum shrinks every frame by a steady few percent; this many such deltas in a row is coasting. */
const COAST_RUN = 5;

export type SwipeDir = "back" | "forward";

/** What the arrow should do: follow at `progress` (1 = on the line), go and take the step, or go away. */
export type SwipeUpdate =
  | { kind: "track"; dir: SwipeDir; progress: number }
  | { kind: "commit"; dir: SwipeDir }
  | { kind: "cancel" };

interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  timeStamp: number;
}

/**
 * Sideways travel, in px, that takes a step in a window this wide: halfway
 * between Chrome's line and ByTune's first one (the user's pick), a real
 * swipe without Chrome's long reach. 315 px in a window 1600 px wide.
 */
export const swipeLine = (width: number): number => (FIRST_PX + Math.max(CHROME_MIN_PX, width * CHROME_SHARE)) / 2;

/**
 * The gesture, fed every wheel event. `scrolls(dx)` says whether something
 * under the pointer would scroll sideways by `dx`: a gesture that does
 * belongs to that scroller for the rest of it, as Chrome latches it, and
 * never navigates. `can(dir)` says whether there is history that way.
 * `quiet(now)` is called once the wheel has gone quiet, to settle it.
 */
export function createSwipeNav(): {
  wheel(e: WheelLike, scrolls: (dx: number) => boolean, can: (dir: SwipeDir) => boolean, width: number): SwipeUpdate | null;
  quiet(now: number): SwipeUpdate | null;
} {
  let last = -Infinity;
  let x = 0;
  let y = 0;
  let sideways = false;
  let spent = false; // scrolled something, went vertical, or already stepped
  let tracking = false; // the arrow is out
  let armed = false; // the arrow is past the line
  let dir: SwipeDir = "back";
  // Coasting: a run of smoothly shrinking deltas, and where x stood before it.
  let run = 0;
  let prev = 0;
  let runFrom = 0;
  let coasting = false;

  const reset = (): void => {
    x = y = 0;
    sideways = spent = tracking = armed = coasting = false;
    run = prev = 0;
  };

  return {
    wheel(e, scrolls, can, width) {
      if (e.ctrlKey) return null; // a pinch zoom
      if (e.timeStamp - last > SWIPE_GAP_MS) reset();
      last = e.timeStamp;
      if (spent) return null;
      const line = e.deltaMode === 1 ? 16 : 1;
      const dx = e.deltaX * line;
      if (!tracking && dx !== 0 && scrolls(dx)) {
        spent = true;
        return null;
      }

      const size = Math.abs(dx);
      const along = dx !== 0 && Math.sign(dx) === Math.sign(x);
      if (coasting) {
        // Fingers back on the pad: a delta that grows again, or turns round.
        if (!along || size > prev * 1.15) {
          coasting = false;
          run = 0;
        }
      } else if (along && size < prev * 0.995 && size > prev * 0.75) {
        if (run++ === 0) runFrom = x;
        if (run >= COAST_RUN) {
          coasting = true;
          x = runFrom; // the run was momentum all along: take its travel back
        }
      } else {
        run = 0;
      }
      prev = size;
      if (!coasting) {
        x += dx;
        y += e.deltaY * line;
      }

      if (!sideways) {
        if (Math.abs(x) + Math.abs(y) < AXIS_PX) return null;
        sideways = Math.abs(x) > Math.abs(y) * 1.5;
        if (!sideways) {
          spent = true;
          return null;
        }
      }

      dir = x < 0 ? "back" : "forward";
      // While deltas shrink smoothly it may be momentum: the arrow holds where
      // the fingers were before the shrink began, so coasting never moves it,
      // let alone turns it white. White always means letting go takes the step.
      const held = run >= 2 && !coasting ? runFrom : x;
      const progress = can(dir) ? Math.abs(held) / swipeLine(width) : 0;
      armed = progress >= 1;
      if (coasting) {
        // The fingers have left the pad: past the line that is the step, short of it the end.
        if (armed) {
          spent = true;
          tracking = false;
          return { kind: "commit", dir };
        }
        if (!tracking) return null;
        tracking = false;
        return { kind: "cancel" };
      }
      tracking = true;
      return { kind: "track", dir, progress };
    },

    quiet(now) {
      if (!tracking || spent || now - last < SWIPE_LIFT_MS) return null;
      tracking = false;
      if (!armed) return { kind: "cancel" }; // a pause, not the end: going on brings the arrow back
      spent = true;
      return { kind: "commit", dir };
    },
  };
}

/** Whether `target` or an ancestor can still scroll sideways by `dx`. */
export function scrollsSideways(target: EventTarget | null, dx: number): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflow = getComputedStyle(el).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}
