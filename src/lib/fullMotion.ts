/**
 * Full animations: ByTune's original motion, or the lighter set WebKitGTK needs.
 *
 * WebKitGTK (Linux) composites nothing on its own: every frame of every running animation redraws
 * the page on the main thread. The original's loops and filters (the cover breathing, the backdrop
 * drift, the visualizer, blurred and scaled lyric lines, the always-burning streak flame) held
 * full-screen Now Playing at ~3 fps there. WebView2 (Windows) and WKWebView (macOS) run them on the
 * compositor, so there they always play as the original has them. On Linux they're a setting
 * (Settings > Appearance > Full animations), off by default.
 *
 * Components with two versions keep the original under components/full/ and pick one with
 * useFullMotion(); CSS picks with `html.full-motion` (set in App's useAppearance).
 */
import { platform } from "./platform";
import { useSettings } from "../stores/settings";

/** True where the original animations cost too much to be on by default (WebKitGTK). */
export const motionCostly = platform === "linux";

export function useFullMotion(): boolean {
  const on = useSettings((s) => s.fullAnimations);
  return !motionCostly || on;
}

export function fullMotion(): boolean {
  return !motionCostly || useSettings.getState().fullAnimations;
}
