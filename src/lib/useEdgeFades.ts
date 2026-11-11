/**
 * Fades a scrolling list's top and bottom edges while there's more to scroll that way, so rows
 * don't look cut off under a header or at the panel's edge. Sets the two sizes the `edge-fades`
 * class (index.css) reads.
 */
import { useEffect, type RefObject } from "react";

export function useEdgeFades(ref: RefObject<HTMLElement | null>, size = 32): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      el.style.setProperty("--fade-top", el.scrollTop > 1 ? `${size}px` : "0px");
      el.style.setProperty("--fade-bottom", el.scrollTop + el.clientHeight < el.scrollHeight - 1 ? `${size}px` : "0px");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // Rows coming and going (a folder opened, a playlist added) change what lies past either edge.
    const resized = new ResizeObserver(update);
    resized.observe(el);
    const changed = new MutationObserver(update);
    changed.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      resized.disconnect();
      changed.disconnect();
    };
  }, [ref, size]);
}
