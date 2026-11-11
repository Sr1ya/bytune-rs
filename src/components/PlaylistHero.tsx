/**
 * The header of a playlist page that isn't one of the listener's own (a YouTube playlist, a
 * Spotify or imported one): the cover full-bleed, its title, credit and metadata lines over it,
 * and the page's buttons below.
 */
import type { ReactNode } from "react";
import { ListMusic } from "lucide-react";
import { FitText } from "./FitText";
import { PAGE_TITLE_SIZE, titleStep } from "../lib/format";
import { upgradeArtwork } from "../lib/artwork";

/** A round button and the Play pill, as the header draws them. */
export const HERO_ROUND =
  "w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40";
export const HERO_PILL =
  "inline-flex items-center gap-2 h-11 px-6 rounded-full bg-black/45 border border-white/10 text-[14.5px] font-semibold text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40";

export function PlaylistHero({
  thumb,
  title,
  credit,
  meta,
  children,
}: {
  thumb?: string;
  title: string;
  credit?: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative -mx-10 overflow-hidden">
      <div className="absolute inset-0">
        {thumb ? (
          <img src={upgradeArtwork(thumb, 1200)} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-ink-hi/[0.04] grid place-items-center">
            <ListMusic className="w-12 h-12 text-ink-hi/30" />
          </div>
        )}
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(to bottom,
              rgb(var(--page-bg) / 0.20) 0%,
              rgb(var(--page-bg) / 0.45) 50%,
              rgb(var(--page-bg) / 0.90) 80%,
              rgb(var(--page-bg)) 100%)`,
          }}
        />
      </div>

      <div className="relative flex flex-col items-center text-center px-8 pt-[244px] pb-5">
        <h1
          className={`font-display ${PAGE_TITLE_SIZE[titleStep(title)]} leading-[1.2] font-extrabold tracking-[-0.03em] text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] break-words max-w-3xl`}
        >
          {title}
        </h1>
        {credit && (
          <div className="text-[15px] font-medium text-accent mt-2 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)] min-w-0 max-w-full">
            <FitText text={credit} />
          </div>
        )}
        {meta && (
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/70 mt-1.5 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">
            {meta}
          </div>
        )}
        <div className="flex items-center justify-center gap-2.5 mt-4">{children}</div>
      </div>
    </div>
  );
}
