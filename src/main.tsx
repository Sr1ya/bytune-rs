import "./bridge-init";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PipApp } from "./pip/PipApp";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { endIntro } from "./intro";
import { installWindowDrag } from "./lib/windowDrag";
import "./lib/platform";
import "./index.css";

endIntro();

/**
 * One bundle, two windows: the main app shell, and — when this renderer was
 * loaded with ?window=pip — the compact native miniplayer. The PiP window
 * renders no app shell and boots no audio engine; it is a pure view onto the
 * main window's playback state (see src/pip/).
 */
const isPipWindow = new URLSearchParams(window.location.search).get("window") === "pip";

installWindowDrag({ maximizable: !isPipWindow });

/* Quitting (window close, tray Quit): the backend has already hidden the windows. Go quiet, bank the
   listening time, hand over every coalesced write and wait until it is on disk, then let the backend
   exit. pagehide/beforeunload never fire when the process ends, so this is the only flush a close gets.
   The backend quits on its own after a couple of seconds if this never answers. */
if (!isPipWindow) {
  window.bytune?.onQuitRequest(() => {
    void (async () => {
      try {
        (await import("./lib/audio")).quitAudio();
      } catch {
        /* the engine may not be up yet */
      }
      try {
        const { flushPendingWrites } = await import("./lib/persist");
        const { playEventsDelivered } = await import("./lib/playEvents");
        await Promise.race([
          Promise.all([flushPendingWrites(), playEventsDelivered()]),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } catch {
        /* quit anyway */
      }
      window.bytune?.quitReady();
    })();
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  isPipWindow ? (
    <ErrorBoundary>
      <PipApp />
    </ErrorBoundary>
  ) : (
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
);
