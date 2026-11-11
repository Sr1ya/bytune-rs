/**
 * The header of a collection page (Liked Songs, a folder of playlists): a wall of the collection's own
 * covers, edge to edge, its rows sliding slowly past each other and sinking into the page as it
 * scrolls; the title big over its lower left, the facts under it, the page's buttons below. It has no
 * colour of its own: the covers light it. A service's page (Spotify) leads with the service's own mark
 * and may add a light of its colour. Motion and shading live in index.css (.collection-hero).
 */
import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { wallCovers } from "../lib/collection";
import { upgradeArtwork } from "../lib/artwork";
import { titleStep } from "../lib/format";

const ROWS = 4;
/** Tiles per row, drawn twice so a row can slide by one length and start over unseen. */
const PER_ROW = 14;
/** By name length (titleStep): a short name goes big. */
const TITLE_SIZE = ["text-[clamp(44px,5vw,76px)]", "text-[clamp(36px,3.8vw,56px)]", "text-[clamp(28px,2.8vw,40px)]"] as const;

/** The Play pill on a collection header; the round buttons beside it are PlaylistHero's HERO_ROUND. */
export const HERO_PLAY =
  "inline-flex items-center gap-2 h-12 pl-5 pr-6 rounded-full bg-white text-black text-[15px] font-semibold shadow-[0_10px_30px_rgba(0,0,0,0.35)] hover:scale-[1.03] active:scale-[0.98] transition-transform disabled:opacity-40 disabled:hover:scale-100";

export function CollectionHero({
  icon: Icon,
  mark,
  light,
  kind,
  title,
  covers,
  facts,
  children,
}: {
  icon?: LucideIcon;
  /** drawn in place of the icon's chip: a service's own mark, as the service draws it */
  mark?: ReactNode;
  /** a light of this colour rising from the lower left, behind the words (a service's own colour) */
  light?: string;
  /** what the page is, over its title ("Folder", "Liked by you"; a link back to Local Music) */
  kind: ReactNode;
  title: string;
  /** the collection's covers in order; repeats and blanks are fine, none gives empty tiles */
  covers: ReadonlyArray<string | null | undefined>;
  facts: ReactNode;
  /** the page's buttons */
  children: ReactNode;
}) {
  const tiles = wallCovers(covers, ROWS * PER_ROW);
  return (
    <header className="collection-hero -mx-10 -mt-5">
      <div aria-hidden className="cover-wall">
        <div className="cover-wall-rows">
          {Array.from({ length: ROWS }, (_, r) => {
            const row = Array.from({ length: PER_ROW }, (_, i) => tiles[r * PER_ROW + i] ?? null);
            return (
              <div
                key={r}
                className="cover-wall-row"
                style={{ animationDuration: `${150 + r * 25}s`, animationDirection: r % 2 ? "reverse" : "normal" }}
              >
                {[...row, ...row].map((src, i) => (
                  <span
                    key={i}
                    className="cover-wall-tile"
                    // The rows' own cover URL: one download fills both, so the wall comes in with the list.
                    style={src ? { backgroundImage: `url(${JSON.stringify(upgradeArtwork(src))})` } : undefined}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div aria-hidden className="cover-wall-shade" />
      {light && <div aria-hidden className="collection-light" style={{ "--collection-light": light } as CSSProperties} />}
      <div aria-hidden className="cover-glow-grain" />
      <div className="collection-hero-text relative px-10 pt-[184px] pb-8">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-white/80">
          {mark ??
            (Icon && (
              <span className="w-6 h-6 rounded-full bg-white/[0.14] grid place-items-center">
                <Icon className="w-3.5 h-3.5" />
              </span>
            ))}
          {kind}
        </div>
        <h1
          className={`mt-2 font-display ${TITLE_SIZE[titleStep(title)]} font-extrabold leading-[0.98] tracking-[-0.045em] text-white break-words max-w-[18ch]`}
        >
          {title}
        </h1>
        <div className="mt-3 text-[14.5px] text-white/75">{facts}</div>
        <div className="mt-6 flex items-center gap-2.5">{children}</div>
      </div>
    </header>
  );
}
