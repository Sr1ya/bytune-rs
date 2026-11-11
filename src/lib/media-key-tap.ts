/**
 * Double-press recognition for the physical media play/pause button.
 *
 * Windows delivers a headset's middle/media button as the SMTC play/pause
 * toggle: one press = one `play` or `pause` media-session action (Chromium
 * picks which, from the player's state at press time). There is no native
 * double-press or NEXT_TRACK event for this hardware — so a headset that
 * means "double press = next track" (e.g. Apple's wired earphone middle
 * button) only ever produces TWO play/pause actions in quick succession.
 *
 * This recognizer sits at that exact input layer and counts play/pause
 * actions separated by at most MEDIA_KEY_DOUBLE_TAP_MS:
 *
 *   one press    → the pressed command, applied once the window expires
 *                  (single-press play/pause keeps working, just deferred)
 *   two presses  → next track, exactly once — the pending play/pause is
 *                  cancelled and never applied
 *   three presses → still next track exactly once; extra presses inside the
 *                  window never compound into extra skips
 *
 * It only ever sees media-session transport events — hardware buttons, BT
 * AVRCP, the Windows media flyout. Keyboard (Space), mouse and in-app
 * buttons act on the player store directly and never pass through here,
 * and genuine `nexttrack`/`previoustrack` actions stay immediate.
 *
 * The window is trailing-edge (press-to-press, like the OS double-click
 * time) so a held button cannot machine-gun it: key repeats only push the
 * window out, and the hold collapses into ONE action when it ends.
 */

/**
 * Press-to-press recognition window, in ms. 500 is Windows' default
 * double-click time (GetDoubleClickTime), so the gesture times like every
 * other double-press on the platform. The cost is that a single media-key
 * press lands one window late — that delay IS the recognition.
 */
export const MEDIA_KEY_DOUBLE_TAP_MS = 500;

export type MediaPlayPauseKind = "play" | "pause";

export interface MediaKeyTapDeps {
  /** One-shot timer; returns its cancel function. (Injected for tests.) */
  schedule(fn: () => void, ms: number): () => void;
}

export interface MediaKeyTapHandlers {
  /** Exactly one press arrived: apply the pressed command after the window. */
  single(kind: MediaPlayPauseKind): void;
  /** Two or more presses arrived inside the window: advance exactly once. */
  multi(): void;
}

export interface MediaKeyTap {
  press(kind: MediaPlayPauseKind): void;
  /**
   * A different transport action (next/previous/seek) arrived. A pending
   * single press belonged to the pre-skip context — applying a stale pause
   * after the user moved to another track would stop what they just chose.
   */
  cancelPending(): void;
}

export function createMediaKeyTap(deps: MediaKeyTapDeps, handlers: MediaKeyTapHandlers): MediaKeyTap {
  let count = 0;
  let lastKind: MediaPlayPauseKind = "pause";
  let cancel: (() => void) | null = null;

  const settle = (): void => {
    cancel = null;
    const n = count;
    count = 0;
    if (n === 1) handlers.single(lastKind);
    else if (n > 1) handlers.multi();
  };

  return {
    press(kind) {
      count += 1;
      lastKind = kind;
      cancel?.();
      cancel = deps.schedule(settle, MEDIA_KEY_DOUBLE_TAP_MS);
    },
    cancelPending() {
      if (cancel) {
        cancel();
        cancel = null;
        count = 0;
      }
    },
  };
}
