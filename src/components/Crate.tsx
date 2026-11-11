import { useState } from "react";
import { ShelfScroller } from "./primitives";
import { FitText } from "./FitText";
import { browseMenuItems } from "../lib/trackActions";
import { useUI } from "../stores/ui";
import type { PlaylistCard } from "../types";

/**
 * Playlists as a record crate (Home's "Playlists for you", a category's page):
 * sleeves lean back in a row, and hovering (or tabbing) to one stands it up
 * with its name below; a click opens it. At rest, and once the pointer or
 * focus leaves the row, every sleeve leans back. The motion lives in
 * index.css (.crate-*).
 */
export function Crate({ title, playlists, className = "" }: { title: string; playlists: PlaylistCard[]; className?: string }) {
  const navigate = useUI((s) => s.navigate);
  // -1: no sleeve up.
  const [lifted, setLifted] = useState(-1);
  const shown = lifted >= 0 ? playlists[lifted] : undefined;
  return (
    <section className={className}>
      <h2 className="section-title text-[21px] mb-1 flex items-baseline gap-2">
        {title} <span className="text-[14px] font-medium text-ink-faint tabular-nums">{playlists.length}</span>
      </h2>
      <div
        onMouseLeave={() => setLifted(-1)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLifted(-1);
        }}
      >
        <ShelfScroller arrowTop="top-[126px]">
          {playlists.map((p, i) => (
            <button
              key={p.id}
              className={`crate-sleeve ${
                lifted < 0 ? "" : i === lifted ? "is-lifted" : i < lifted ? "is-before" : i === lifted + 1 ? "is-after is-next" : "is-after"
              }`}
              style={{ animationDelay: `${Math.min(i, 14) * 35}ms` }}
              onMouseEnter={() => setLifted(i)}
              onFocus={() => setLifted(i)}
              onClick={() => navigate({ name: "ytplaylist", param: p.id })}
              onContextMenu={(e) => {
                const items = browseMenuItems({ browseId: p.id, title: p.title, subtitle: p.subtitle ?? "", thumb: p.thumb, type: "playlist" });
                if (!items.length) return;
                e.preventDefault();
                useUI.getState().openContextMenu(e.clientX, e.clientY, items);
              }}
              aria-label={p.title}
            >
              <img src={p.thumb} alt="" draggable={false} />
            </button>
          ))}
          <span className="crate-end" aria-hidden />
        </ShelfScroller>
      </div>
      {/* Keyed by the lifted playlist, so each new name slides in; empty at rest, its height kept so nothing below jumps. */}
      <div key={shown?.id ?? "rest"} className="crate-caption">
        {shown && (
          <>
            <FitText mode="auto" text={shown.title} className="text-[15px] font-semibold text-ink-hi" />
            <FitText mode="auto" text={shown.subtitle ?? ""} className="text-[13px] text-ink-dim" />
          </>
        )}
      </div>
    </section>
  );
}
