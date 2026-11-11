/**
 * When decorative motion may rest.
 *
 * WebKitGTK runs no animation on the compositor: every frame of every running animation, however
 * small, redraws the page on the main thread and recomposites the window, glass blurs included. So
 * loops that only decorate stop when nobody is served by them:
 *
 *   html.app-asleep      the page is hidden, or the window is minimized or hidden (backend
 *                        `window:asleep`). Every CSS animation pauses (index.css).
 *   html.playback-idle   nothing is playing: the loops that dress the playing song (the playing
 *                        row's glow, the title marquee) rest.
 *
 * JS-driven animations (Web Animations, rAF loops) read `motionResting()` and `onMotionRest()`.
 */
import { usePlayer } from "../stores/player";

let windowAsleep = false;
const listeners = new Set<() => void>();

function apply(): void {
  const html = document.documentElement;
  const asleep = windowAsleep || document.visibilityState === "hidden";
  const idle = !usePlayer.getState().playing;
  const changed = html.classList.contains("app-asleep") !== asleep || html.classList.contains("playback-idle") !== idle;
  html.classList.toggle("app-asleep", asleep);
  html.classList.toggle("playback-idle", idle);
  if (changed) for (const cb of listeners) cb();
}

/** True while decorative motion should hold still: always when the window is away, and when nothing
    plays for motion that dresses the playing song (`followsPlayback`). */
export function motionResting(followsPlayback = false): boolean {
  const c = document.documentElement.classList;
  return c.contains("app-asleep") || (followsPlayback && c.contains("playback-idle"));
}

/** Called whenever motionResting() may have changed; returns the unsubscribe. */
export function onMotionRest(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let installed = false;
export function installMotionRest(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", apply);
  window.bytune?.onWindowAsleep?.((asleep) => {
    windowAsleep = asleep;
    apply();
  });
  let wasPlaying = usePlayer.getState().playing;
  usePlayer.subscribe((s) => {
    if (s.playing === wasPlaying) return;
    wasPlaying = s.playing;
    apply();
  });
  apply();
}
