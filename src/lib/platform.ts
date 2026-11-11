/**
 * Platform surface for the renderer.
 *
 * The preload bridge reports the real process.platform; a plain-browser dev
 * run (no bridge) assumes the platform this project targets — macOS — so
 * the layout still previews correctly outside Electron on a Mac.
 */
export const platform: string =
  (typeof window !== "undefined" && window.bytune?.platform) || "darwin";

export const isMac = platform === "darwin";
export const isWindows = platform === "win32";

// One class on <html> drives the platform CSS (font stack; caption-button
// visibility is handled in React). Runs at module import, before first paint.
if (typeof document !== "undefined") {
  document.documentElement.classList.toggle("platform-mac", isMac);
  document.documentElement.classList.toggle("platform-windows", platform === "win32");
}
