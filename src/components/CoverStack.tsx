/**
 * A collection as a small stack of its covers (a folder's playlists, Local Music's folders, an
 * album): up to three sleeves, the first on top and the others peeking out behind it. Hovering fans
 * them out and lights the stack from below with its top cover. Motion lives in index.css (.stack-*).
 */
import type { HTMLAttributes } from "react";
import { AlertTriangle, MoreHorizontal, Music2, type LucideIcon } from "lucide-react";
import { FitText } from "./FitText";
import { PlayOverlay } from "./primitives";
import { upgradeArtwork } from "../lib/artwork";

/** At the same size as everywhere else a cover shows, so it downloads once. */
const bg = (src: string): string => `url(${JSON.stringify(upgradeArtwork(src))})`;

export function CoverStack({
  covers,
  title,
  subtitle,
  onOpen,
  onPlay,
  onMenu,
  lit,
  warn,
  fallback: Fallback = Music2,
  rootProps,
}: {
  covers: ReadonlyArray<string | null | undefined>;
  title: string;
  subtitle: string;
  onOpen: () => void;
  onPlay?: () => void;
  /** its options, from a round … button on the stack */
  onMenu?: (x: number, y: number) => void;
  /** something is being dragged over it that it would take */
  lit?: boolean;
  /** it needs attention (a local folder that can't be reached): an amber mark, the subtitle in amber */
  warn?: boolean;
  /** drawn on the sleeve when there's no cover */
  fallback?: LucideIcon;
  /** the root's drag source / drop target / context-menu handlers */
  rootProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const shown = [...new Set(covers.filter((c): c is string => !!c))].slice(0, 3);
  return (
    <div {...rootProps} className={`stack-card group ${lit ? "is-lit" : ""}`}>
      <div className="stack-art">
        {shown[0] && <span aria-hidden className="stack-light" style={{ backgroundImage: bg(shown[0]) }} />}
        <button type="button" onClick={onOpen} aria-label={`Open ${title}`} className="stack-open">
          {shown.length ? (
            shown.map((src, i) => <span key={src} className={`stack-sleeve s${i}`} style={{ backgroundImage: bg(src), zIndex: 3 - i }} />)
          ) : (
            <span className="stack-sleeve s0 grid place-items-center">
              <Fallback className="w-8 h-8 text-ink-hi/25" />
            </span>
          )}
        </button>
        {warn && (
          <span className="stack-warn" aria-hidden>
            <AlertTriangle className="w-3.5 h-3.5" />
          </span>
        )}
        {onMenu && (
          <button
            type="button"
            aria-label={`Options for ${title}`}
            title="More options"
            className="stack-menu"
            onClick={(e) => {
              e.stopPropagation();
              onMenu(e.clientX, e.clientY);
            }}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        )}
        {onPlay && (
          <span className="stack-play">
            <PlayOverlay title={`Play ${title}`} onClick={onPlay} />
          </span>
        )}
      </div>
      <button type="button" tabIndex={-1} onClick={onOpen} className="block w-full min-w-0 text-left mt-3">
        <FitText text={title} className="text-[15px] font-semibold text-ink-hi" />
        <span className={`block text-[13px] mt-0.5 ${warn ? "text-amber-400/90" : "text-ink-dim"}`}>{subtitle}</span>
      </button>
    </div>
  );
}
