/**
 * The light on ByTune's song lists: made of the cover of the row under the pointer, blurred and
 * stretched across it, it glides from row to row; the playing song keeps a softer one of its own.
 * Moved by hand rather than through state, so a long list doesn't re-render for every row the
 * pointer crosses. Paint and motion: index.css (.tl-light, .tl-playing, .tl-row).
 */
import { useRef, type CSSProperties, type ReactNode } from "react";
import { artworkFor } from "../lib/artwork";

/** The row's own cover URL (already loaded for the row's 52px thumbnail, components/TrackList): the
    light needs no download of its own, and blurred 30px it needs no more detail than that. */
const lightOf = (thumb: string): string => `url(${JSON.stringify(artworkFor(thumb, 52))})`;

/** The playing row's own light, inside that row (a .tl-row). */
export function PlayingLight({ thumb }: { thumb?: string | null }) {
  return thumb ? <span aria-hidden className="tl-playing" style={{ "--light": lightOf(thumb) } as CSSProperties} /> : null;
}

/**
 * A list's moving light. `light` goes in a relative container that also holds the rows; each row's
 * mouseenter calls `hover`, the container's mouseleave calls `leave`.
 */
export function useRowLight(): {
  light: ReactNode;
  hover: (row: HTMLElement, thumb: string | null | undefined) => void;
  leave: () => void;
} {
  const ref = useRef<HTMLSpanElement | null>(null);
  const hover = (row: HTMLElement, thumb: string | null | undefined): void => {
    const el = ref.current;
    const box = el?.parentElement?.getBoundingClientRect();
    if (!el || !box) return;
    const r = row.getBoundingClientRect();
    const place = (): void => {
      el.style.transform = `translateY(${r.top - box.top}px)`;
      el.style.height = `${r.height}px`;
    };
    // From off, it appears on its row instead of gliding in from wherever it last was.
    if (el.classList.contains("is-on")) place();
    else {
      el.style.transition = "none";
      place();
      void el.offsetHeight;
      el.style.transition = "";
    }
    if (thumb) el.style.setProperty("--light", lightOf(thumb));
    el.classList.toggle("is-on", !!thumb);
  };
  const leave = (): void => ref.current?.classList.remove("is-on");
  return { light: <span ref={ref} aria-hidden className="tl-light" />, hover, leave };
}
