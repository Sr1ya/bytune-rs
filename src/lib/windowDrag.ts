/**
 * Dragging the frameless window by its top bar.
 *
 * ByTune's markup marks the drag surface with `.app-drag` and the controls inside it with
 * `.app-no-drag` (Electron's `-webkit-app-region`). Tauri's webviews ignore that CSS on Windows and
 * macOS, so a press on the surface hands the drag to the window manager here instead, and a
 * double-click toggles maximize, as a native title bar does.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

const INTERACTIVE = ".app-no-drag, button, a, input, textarea, select, [role='button'], [contenteditable='true']";

function onDragSurface(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return !!el?.closest(".app-drag") && !el.closest(INTERACTIVE);
}

export function installWindowDrag({ maximizable }: { maximizable: boolean }): void {
  if (!("__TAURI_INTERNALS__" in window)) return; // a plain browser preview
  const win = getCurrentWindow();
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !onDragSurface(e.target)) return;
    if (e.detail === 2) {
      if (maximizable) window.bytune?.windowMaximizeToggle();
      return;
    }
    void win.startDragging().catch(() => undefined);
  });
}
