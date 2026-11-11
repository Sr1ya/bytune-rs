/**
 * Recommendation card treatments — the visual vocabulary of the personalized
 * Home feed, matching the reference layouts:
 *   - mixes: square artwork with a colored name band across the lower third
 *   - sides: a cover collage with a record label naming the side
 *   - song lists: rows four deep with a note each (heavy rotation, dust off)
 *   - stations/radio: pastel tile, "RADIO" tag, centered circular photo seal
 *   - artist-anchored sections: the eyebrow header ("More like / The Weeknd")
 * Colors are picked by a stable hash of the card id — same card, same color,
 * every visit (no lottery between renders).
 */
import { EyeOff, Radio } from "lucide-react";
import { useDrag } from "../lib/dnd";
import { playSource } from "../lib/recs/playback";
import { pastelFor, type HomeSection } from "../lib/recs/sections";
import { trackMenuItems } from "../lib/trackActions";
import { useHomeEngagement } from "../stores/homeEngagement";
import { usePlayer, useTrackPlayback } from "../stores/player";
import { tintHoverHandlers, useUI, type MenuItem } from "../stores/ui";
import type { Track } from "../types";
import { Artwork, EqBars, PlayOverlay, ShelfScroller } from "./primitives";
import { FitText } from "./FitText";
import { shortTitle } from "../lib/format";

/* Same hover-only tile as the Cards.tsx shelf cards (keep the two in sync):
   transparent at rest, translucent box fades in on hover, 8px inset —
   artwork keeps 168px. */
const CARD =
  "fit-host group w-[184px] shrink-0 text-left cursor-pointer active:scale-[0.98] rounded-xl p-2 transition-colors duration-200 hover:bg-ink-hi/[0.08]";
const CARD_TITLE = "text-[15px] font-semibold text-ink-hi leading-snug";
const CARD_SUB = "text-[13px] text-ink-dim mt-0.5";

type MixItem = Extract<HomeSection["items"][number], { style: "mix" }>;
type RadioItem = Extract<HomeSection["items"][number], { style: "radio" }>;
type SideItem = Extract<HomeSection["items"][number], { style: "side" }>;
type TrackItem = Extract<HomeSection["items"][number], { style: "track" }>;

/** A Home song's menu: the usual song actions, then "Not interested" — off Home, and its artist steps back. */
export function homeTrackMenu(track: Track): MenuItem[] {
  return [
    ...trackMenuItems(track),
    {
      label: "Not interested",
      icon: EyeOff,
      separatorBefore: true,
      action: () => {
        useHomeEngagement.getState().hide(track);
        useUI.getState().toast(`Hidden from Home: ${shortTitle(track.title)}`);
      },
    },
  ];
}

/**
 * One side of your taste as a mix: a collage of its songs' covers, with a
 * record label peeking from the corner that names the side. Static — the
 * crate above is Home's one moving piece.
 */
export function SideCard({ item }: { item: SideItem }) {
  const [c1, c2] = pastelFor(item.id);
  const play = (): void => void playSource(item.source);
  const covers = item.thumbs.length >= 4 ? item.thumbs.slice(0, 4) : item.thumbs.slice(0, 1);
  return (
    <button onClick={play} {...tintHoverHandlers(item.thumbs[0] ?? null)} className={CARD} aria-label={`Play Side ${item.letter}`}>
      <div className="relative overflow-hidden rounded-xl">
        <div className={`grid aspect-square w-full overflow-hidden rounded-xl ${covers.length === 4 ? "grid-cols-2 grid-rows-2" : ""}`}>
          {covers.map((src) => (
            <Artwork key={src} src={src} className="h-full w-full rounded-none" iconClassName="w-5 h-5" />
          ))}
        </div>
        <span className="side-disc" aria-hidden>
          <span className="side-disc-label font-display" style={{ background: `linear-gradient(140deg, ${c1}, ${c2})` }}>
            {item.letter}
          </span>
        </span>
        <PlayOverlay onClick={play} title={`Play Side ${item.letter}`} />
      </div>
      <div className="mt-2.5">
        <FitText lines={2} text={`Side ${item.letter}`} className={CARD_TITLE} />
        <FitText text={item.caption} className={CARD_SUB} />
        <div className="text-[12px] text-ink-faint mt-0.5 tabular-nums">
          {item.count} songs{item.fresh ? ` · ${item.fresh} new` : ""}
        </div>
      </div>
    </button>
  );
}

/** One row of a song list: cover, title and artist, and the row's note on the right. */
function ListRow({ track, note, onPlay }: { track: Track; note?: string; onPlay: () => void }) {
  const state = useTrackPlayback(track.id);
  const drag = useDrag({ track });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPlay();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, homeTrackMenu(track));
      }}
      {...tintHoverHandlers(track.thumb)}
      {...drag.props}
      className={`fit-host group flex h-[60px] items-center gap-3 rounded-lg px-2 text-left cursor-pointer select-none transition-colors duration-150 hover:bg-ink-hi/[0.06] ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <span className="relative shrink-0">
        <Artwork src={track.thumb} className="h-12 w-12 rounded-md" iconClassName="w-4 h-4" />
        {state === "playing" && (
          <span className="absolute inset-0 grid place-items-center rounded-md bg-black/55">
            <EqBars />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <FitText text={shortTitle(track.title)} full={track.title} className={`text-[14px] font-semibold leading-snug ${state ? "text-accent" : "text-ink-hi"}`} />
        <FitText text={track.artist} className="text-[13px] text-ink-dim" />
      </span>
      {note && <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{note}</span>}
    </div>
  );
}

/** A song list four rows deep, its columns scrolling sideways; a row plays the list from there. */
export function TrackColumns({ items }: { items: TrackItem[] }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const tracks = items.map((i) => i.track);
  return (
    <ShelfScroller arrowTop="top-[112px]">
      <div className="grid grid-flow-col grid-rows-4 gap-x-6 gap-y-1 [grid-auto-columns:360px]">
        {items.map((item, i) => (
          <ListRow key={item.track.id} track={item.track} note={item.note} onPlay={() => playQueue(tracks, i)} />
        ))}
      </div>
    </ShelfScroller>
  );
}

export function MixCard({ item }: { item: MixItem }) {
  const [c1, c2] = pastelFor(item.id);
  return (
    <button
      onClick={() => void playSource(item.source)}
      {...tintHoverHandlers(item.thumb ?? null)}
      className={CARD}
      aria-label={`Play ${item.name}`}
    >
      <div className="relative overflow-hidden rounded-xl">
        <Artwork
          src={item.thumb ?? undefined}
          className="w-full aspect-square rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.04]"
          iconClassName="w-7 h-7"
        />
        {/* The mix-name band — full width, low on the art, dark text on pastel. */}
        <div
          className="absolute left-0 right-0 bottom-[13%] flex h-[21%] items-center px-2.5"
          style={{ background: `linear-gradient(90deg, ${c1}, ${c2})` }}
        >
          <FitText text={item.name} className="text-[14px] font-extrabold tracking-[-0.01em] text-black/[0.82]" />
        </div>
        <PlayOverlay onClick={() => void playSource(item.source)} title={`Play ${item.name}`} />
      </div>
      <div className="mt-2.5">
        <FitText lines={2} text={item.name} className={CARD_TITLE} />
        <FitText text={item.caption} className={CARD_SUB} />
      </div>
    </button>
  );
}

export function RadioCard({ item }: { item: RadioItem }) {
  const [c1, c2] = pastelFor(item.id);
  return (
    <button
      onClick={() => void playSource(item.source)}
      {...tintHoverHandlers(item.thumb ?? null)}
      className={CARD}
      aria-label={`Play the ${item.name} radio`}
    >
      <div
        className="relative aspect-square overflow-hidden rounded-xl"
        style={{ background: `linear-gradient(155deg, ${c1} 20%, ${c2})` }}
      >
        <Radio className="absolute left-3 top-3 w-4 h-4 text-black/65" aria-hidden />
        <span className="absolute right-3 top-3 text-[10.5px] font-extrabold tracking-[0.2em] text-black/70">RADIO</span>
        <Artwork
          src={item.thumb ?? undefined}
          className="absolute left-1/2 top-[45%] w-[56%] aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full shadow-float transition-transform duration-300 ease-out group-hover:scale-[1.04]"
          rounded="rounded-full"
          iconClassName="w-8 h-8"
        />
        <div className="absolute bottom-0 left-0 right-0 px-3 pb-2.5">
          <FitText text={item.name} className="text-[15.5px] font-extrabold tracking-[-0.01em] text-black/[0.82]" />
        </div>
        <PlayOverlay onClick={() => void playSource(item.source)} title={`Play the ${item.name} radio`} />
      </div>
      <div className="mt-2.5">
        <FitText text={item.caption} className={CARD_SUB} />
      </div>
    </button>
  );
}

/** "More like / The Weeknd" — avatar beside the eyebrow + big artist name. */
export function EyebrowHeader({
  eyebrow,
  onOpen,
}: {
  eyebrow: NonNullable<HomeSection["eyebrow"]>;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div className="flex min-w-0 items-center gap-3.5">
        <button onClick={onOpen} title={`Open ${eyebrow.name}`} className="shrink-0 cursor-pointer">
          <Artwork src={eyebrow.thumb ?? undefined} className="w-14 h-14" rounded="rounded-full" iconClassName="w-5 h-5" alt="" />
        </button>
        <div className="min-w-0">
          <div className="text-[13px] text-ink-faint leading-tight">{eyebrow.label}</div>
          <button
            onClick={onOpen}
            className="fit-host block max-w-full cursor-pointer font-display text-[24px] font-extrabold tracking-[-0.02em] text-ink-hi leading-tight hover:text-ink-hi/85 transition-colors"
          >
            <FitText text={eyebrow.name} />
          </button>
        </div>
      </div>
      <button
        onClick={onOpen}
        className="shrink-0 text-[13px] font-bold text-ink-faint hover:text-ink-hi transition-colors cursor-pointer"
      >
        Show all
      </button>
    </div>
  );
}
