/**
 * YouTube's rule for a full-screen view's controls: true once the pointer has rested `delay` ms
 * while `enabled`. A real move, a press or a wheel turn wakes it and starts the wait over. It never
 * goes idle while a button is held (a slider drag) or keyboard focus sits in a `keep` element, and
 * Tab reaching one wakes it. Turning `enabled` off wakes it in the same render.
 */
import { useEffect, useRef, useState } from "react";

/** `resetKey`: a change (a new song) counts as a wake, like a move. */
export function useIdle(enabled: boolean, delay: number, keep: string, resetKey?: unknown): boolean {
  const [idle, setIdle] = useState(false);
  // Where the pointer last was. Chromium re-checks hover after a repaint with a "move" to the spot
  // the pointer already holds; that is not the user and must not wake the view.
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setIdle(false);
    if (!enabled) return;
    let timer = 0;
    let held = false;
    const keyboardInKeep = (): boolean => {
      const el = document.activeElement;
      return !!el?.closest(keep) && el.matches(":focus-visible");
    };
    const rest = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!held && !keyboardInKeep()) setIdle(true);
      }, delay);
    };
    const wake = (): void => {
      setIdle(false);
      rest();
    };
    const move = (e: PointerEvent): void => {
      const was = last.current;
      last.current = { x: e.clientX, y: e.clientY };
      if (was?.x !== e.clientX || was?.y !== e.clientY) wake();
    };
    const press = (e: PointerEvent): void => {
      held = true;
      last.current = { x: e.clientX, y: e.clientY };
      wake();
    };
    const release = (): void => {
      held = false;
      wake();
    };
    const focusIn = (): void => {
      if (keyboardInKeep()) wake();
    };
    // A press can end outside the window (Alt+Tab mid-drag) with no pointerup reaching it.
    const blur = (): void => {
      held = false;
      rest();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("wheel", wake, { passive: true });
    window.addEventListener("blur", blur);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", rest);
    rest();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("wheel", wake);
      window.removeEventListener("blur", blur);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", rest);
    };
  }, [enabled, delay, keep, resetKey]);

  return enabled && idle;
}
