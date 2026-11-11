/**
 * Right rail — the always-on song-details panel, Spotify-style.
 *
 * Default mode ("details"): a sharp artwork tile over the track title and an
 * About-the-artist card in Spotify's shape — photo header, verified name,
 * monthly listeners beside a View profile pill, and the editorial blurb — clicking
 * it opens that artist's page. The queue button in the player bar swaps the
 * body to the queue sheet ("Queue" / "Recently played" text tabs with the
 * underline treatment, X returns to details). Lyrics live in the centre pane
 * (see LyricsCenter.tsx), not here.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BadgeCheck, Heart, Music2, Play, ThumbsDown, X } from "lucide-react";
import { autoplayTail, isRadioSeed, shownTrack, usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI, type MenuItem } from "../stores/ui";
import { dontPlay, useAutoplayInfo } from "../lib/autoplay";
import { confirmClearHistory, historyMenuItems, trackMenuItems } from "../lib/trackActions";
import { Artwork, Btn, EqBars, IconBtn, Switch } from "./primitives";
import { RoomPanel } from "./RoomPanel";
import { useRoom } from "../stores/room";
import { upgradeArtwork, wideArtwork } from "../lib/artwork";
import { useDrag, useTrackDrop } from "../lib/dnd";
import { useSortable, type SortableRowProps } from "../lib/useSortable";
import { fmtTime, shortTitle, titleSource } from "../lib/format";
import { FitText } from "./FitText";
import { useArtistImage } from "../lib/artistImage";
import { monthlyListenersLabel, useArtistAbout } from "../lib/artistAbout";
import { useLibrary } from "../stores/library";
import type { Track } from "../types";
import { playSource } from "../lib/recs/playback";

/** The queue's "Now playing" row — draggable like every other song row. */
function QueueCurrentRow({ track }: { track: Track }) {
  const drag = useDrag({ track });
  // Read here, not in QueuePanel: play/pause then doesn't re-render every queue row.
  const playing = usePlayer((s) => s.playing);
  return (
    <div
      {...drag.props}
      onContextMenu={(e) => {
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, trackMenuItems(track));
      }}
      className={`fit-host flex items-center gap-3 h-14 px-2 rounded-lg bg-ink-hi/[0.14] ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork src={track.thumb} className="w-11 h-11 rounded-md shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-ink-hi flex items-center gap-2">
          <FitText text={shortTitle(track.title)} full={track.title} />
          {playing && <EqBars />}
        </div>
        <FitText text={track.artist} className="text-[12px] text-ink-hi/55 mt-0.5" />
      </div>
    </div>
  );
}

function TrackRow({
  track,
  isCurrent,
  isPlaying,
  onPlay,
  onRemove,
  actions,
  menu = () => trackMenuItems(track),
  sortable,
  style,
}: {
  track: Track;
  isCurrent?: boolean;
  isPlaying?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
  /** hover-only buttons shown before the duration */
  actions?: ReactNode;
  /** right-click menu */
  menu?: () => MenuItem[];
  /** an upcoming queue row: grabbing it reorders the queue (instead of dragging it out) */
  sortable?: SortableRowProps;
  style?: CSSProperties;
}) {
  const drag = useDrag({ track });
  return (
    <div
      {...(sortable ?? drag.props)}
      style={style}
      tabIndex={sortable ? 0 : undefined}
      onKeyDown={
        sortable
          ? (e) => {
              if (e.key === "Enter" && e.target === e.currentTarget) {
                e.preventDefault();
                onPlay();
              } else sortable.onKeyDown(e);
            }
          : undefined
      }
      onClick={onPlay}
      onContextMenu={(e) => {
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, menu());
      }}
      className={`fit-host group relative flex items-center gap-3 h-12 px-2 rounded-lg cursor-pointer select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
        isCurrent ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging ? "opacity-40" : ""} ${
        // Long queues: off-screen rows skip layout and paint. 3rem is the row's own height (h-12),
        // so rows never drawn still measure right for drag-to-reorder.
        sortable ? "[content-visibility:auto] [contain-intrinsic-size:auto_3rem]" : ""
      }`}
    >
      <Artwork src={track.thumb} className="w-9 h-9 rounded-md shrink-0" iconClassName="w-3.5 h-3.5" alt="" />
      <div className="flex-1 min-w-0">
        <FitText text={shortTitle(track.title)} full={track.title} className="text-[13px] font-semibold text-ink-hi" />
        <FitText text={track.artist} className="text-[11.5px] text-ink-hi/55 mt-0.5" />
      </div>
      {isCurrent && isPlaying && <EqBars />}
      {/* Hover buttons sit before the duration on every row, so durations line up. */}
      {(actions || onRemove) && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
          {actions}
          {onRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              title="Remove from queue"
              aria-label="Remove from queue"
              className="p-1 rounded-md text-ink-hi/45 hover:text-red-400 hover:bg-ink-hi/[0.06] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
      {track.duration > 0 && (
        <div className="w-9 text-right text-[11px] text-ink-hi/45 tabular-nums shrink-0">{fmtTime(track.duration)}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ queue sheet */

/** A queue row's height plus the list's gap, and how many rows past the view stay built. */
const ROW_PX = 50;
const OVERSCAN = 10;

/** Exported for the fullscreen player's Queue view — the same sheet, data
    and behavior as the right-rail queue; only the mount point differs. */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"queue" | "recent">("queue");
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const repeat = usePlayer((s) => s.repeat);
  const jumpTo = usePlayer((s) => s.jumpTo);
  const removeAt = usePlayer((s) => s.removeAt);
  const tail = usePlayer(autoplayTail);
  const history = useLibrary((s) => s.history);
  const playTrack = usePlayer((s) => s.playTrack);
  const autoplay = useSettings((s) => s.autoplay);
  const setAutoplay = useSettings((s) => s.setAutoplay);
  /** In a room the queue is everyone's, and AutoPlay sits out. */
  const inRoom = useRoom((s) => s.view.state !== null);
  const { seedTitle, loading } = useAutoplayInfo();
  const liked = useLibrary((s) => s.liked);
  const toggleLike = useLibrary((s) => s.toggleLike);
  const likedIds = useMemo(() => new Set(liked.map((l) => l.id)), [liked]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Songs dragged onto the queue join it (after your own upcoming songs).
  const queueDrop = useTrackDrop((track) => {
    const s = usePlayer.getState();
    if (track.id === s.queue[s.index]?.id) return; // e.g. the Now playing row dropped back on its own panel
    const added = s.addToQueue([track]);
    const name = shortTitle(track.title);
    useUI.getState().toast(added ? `Added "${name}" to the queue` : `"${name}" is already in your queue`);
  });

  const current = queue[index] ?? null;
  // One list: your upcoming songs, the AutoPlay line, then AutoPlay's suggestions.
  const suggestionsAt = queue.length - tail;
  const own = queue.slice(index + 1, suggestionsAt);
  const suggestions = queue.slice(suggestionsAt);
  const line = own.length; // the AutoPlay line's place in the list
  const queueIndexOf = (p: number): number => (p < line ? index + 1 + p : suggestionsAt + p - line - 1);
  const sortable = useSortable({
    signature: `${index}:${tail}:${queue
      .slice(index)
      .map((t) => t.id)
      .join(",")}`,
    listRef,
    scrollRef,
    // Your songs and AutoPlay's suggestions each reorder on their own side of the line.
    clamp: (from, target) => (from < line ? Math.min(target, line - 1) : Math.max(target, line + 1)),
    canDrag: (p) => (p < line ? line > 1 : p > line && suggestions.length > 1),
    onCommit: (from, to) => usePlayer.getState().moveUpcoming(queueIndexOf(from), queueIndexOf(to)),
  });
  // Long queues: only the rows near the view are built (art, scrolling titles, drag
  // handlers); the rest are plain row-high stand-ins, so a 3,000-song queue opens and
  // moves on as fast as a short one. Every row stays in the list for drag-to-reorder
  // to measure, and the row being dragged stays built while auto-scroll carries it.
  const [inView, setInView] = useState({ first: 0, last: 40 });
  const hasCurrent = !!current;
  useEffect(() => {
    const scroll = scrollRef.current;
    const list = listRef.current;
    if (!scroll || !list) return;
    const update = (): void => {
      const top = scroll.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const first = Math.max(0, Math.floor(top / ROW_PX) - OVERSCAN);
      const last = Math.ceil((top + scroll.clientHeight) / ROW_PX) + OVERSCAN;
      setInView((v) => (v.first === first && v.last === last ? v : { first, last }));
    };
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [tab, hasCurrent]);
  const built = (p: number): boolean => (p >= inView.first && p <= inView.last) || p === sortable.dragging;
  const standIn = (key: string, p: number) => <div key={key} aria-hidden className="h-12" style={sortable.styleFor(p)} />;
  const note = inRoom
    ? "Everyone in the room hears this queue"
    : suggestions.length
    ? `Suggested by AutoPlay${seedTitle ? ` \u00b7 similar to ${seedTitle}` : ""}`
    : !autoplay
      ? "AutoPlay is off: the music stops after your last song"
      : repeat !== "off"
        ? "AutoPlay is paused while repeat is on"
        : !isRadioSeed(queue[queue.length - 1]?.id)
          ? "AutoPlay isn't available after local files"
          : queue[queue.length - 1]?.episode
            ? "AutoPlay doesn't continue after podcast episodes"
            : loading
              ? "AutoPlay is finding similar songs\u2026"
              : "AutoPlay keeps the music going with similar songs";
  // Row keys must not depend on the current queue index: embedding `index`
  // shifted every key on each track advance, remounting the whole upcoming
  // list (new drag state, new <img> decode) per track. Key by id plus its
  // occurrence number within the queue — stable across playback. One array
  // for the whole list, so a suggestion that becomes yours moves, not remounts.
  const occurrence = new Map<string, number>();
  const stableKey = (id: string): string => {
    const n = occurrence.get(id) ?? 0;
    occurrence.set(id, n + 1);
    return `${id}#${n}`;
  };
  const rows = [
    ...own.map((t, p) => {
      if (!built(p)) return standIn(stableKey(t.id), p);
      return (
        <TrackRow
          key={stableKey(t.id)}
          track={t}
          style={sortable.styleFor(p)}
          sortable={sortable.rowProps(p)}
          onPlay={() => jumpTo(index + 1 + p)}
          onRemove={() => {
            // Removing a row shifts the list up under a stationary
            // pointer — the row now under it never fires mouseenter,
            // so clear the hover wash here (navigate() does the same
            // for view changes).
            useUI.getState().setTintThumb(null);
            removeAt(index + 1 + p);
          }}
        />
      );
    }),
    <div
      key="autoplay-line"
      style={sortable.styleFor(line)}
      className="px-2 pt-2.5 pb-1 text-[12px] leading-snug font-semibold text-ink-hi/50"
    >
      {note}
    </div>,
    ...suggestions.map((t, k) => {
      if (!built(line + 1 + k)) return standIn(stableKey(t.id), line + 1 + k);
      const isLiked = likedIds.has(t.id);
      return (
        <TrackRow
          key={stableKey(t.id)}
          track={t}
          style={sortable.styleFor(line + 1 + k)}
          sortable={sortable.rowProps(line + 1 + k)}
          onPlay={() => jumpTo(suggestionsAt + k)}
          actions={
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLike(t);
                }}
                title={isLiked ? "Remove from Liked Songs" : "Add to Liked Songs"}
                aria-label="Like"
                aria-pressed={isLiked}
                className="p-1 rounded-md text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.06] transition-colors"
              >
                <Heart className={`w-3.5 h-3.5 ${isLiked ? "fill-current" : ""}`} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  useUI.getState().setTintThumb(null);
                  dontPlay(suggestionsAt + k);
                }}
                title="Don't play this"
                aria-label="Don't play this"
                className="p-1 rounded-md text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.06] transition-colors"
              >
                <ThumbsDown className="w-3.5 h-3.5" />
              </button>
            </>
          }
        />
      );
    }),
  ];

  const TabBtn = ({
    id,
    label,
  }: {
    id: "queue" | "recent";
    label: string;
  }) => (
    <button
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={`relative h-full px-1 text-[14px] font-bold tracking-[-0.2px] transition-colors ${
        tab === id ? "text-ink-hi" : "text-ink-hi/55 hover:text-ink-hi/85"
      }`}
    >
      {label}
      {/* Spotify's underline treatment — ours is white on the black canvas. */}
      <span
        className={`absolute left-0 right-0 bottom-0 h-[3px] rounded-full transition-opacity ${
          tab === id ? "bg-ink-hi opacity-100" : "opacity-0"
        }`}
      />
    </button>
  );

  return (
    <>
      {/* Header — Queue / Recently played tabs + close back to details. */}
      <div className="h-14 shrink-0 flex items-center gap-5 px-5 border-b border-ink-hi/[0.08]">
        <TabBtn id="queue" label="Queue" />
        <TabBtn id="recent" label="Recently played" />
        <div className="ml-auto">
          <IconBtn
            icon={X}
            title="Close queue"
            onClick={onClose}
            className="rounded-full text-ink-hi/55 hover:text-ink-hi"
          />
        </div>
      </div>

      {tab === "queue" ? (
        <div
          {...queueDrop.props}
          className={`flex-1 min-h-0 flex flex-col rounded-xl transition-shadow ${
            queueDrop.hovering ? "ring-2 ring-inset ring-primary/60" : ""
          }`}
        >
          <div className="px-4 pt-3 pb-2">
            <span className="micro-label text-ink-hi/55">Now playing</span>
          </div>
          <div className="px-2 pb-2">
            {current ? (
              <QueueCurrentRow track={current} />
            ) : (
              <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">
                Nothing playing — start a track to see your queue here.
              </div>
            )}
          </div>

          {current && (
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
              <div className="flex items-center gap-3 px-2 pt-2 pb-1.5">
                <h2 className="flex-1 text-[15px] font-bold tracking-[-0.2px] text-ink-hi">{inRoom ? "Up next in the room" : "Up next"}</h2>
                {own.length > 0 && (
                  <button
                    onClick={() => usePlayer.getState().clearUpcoming()}
                    className="text-[13px] font-semibold text-ink-hi/75 hover:text-ink-hi transition-colors"
                    title="Clear your upcoming songs (AutoPlay's stay)"
                  >
                    Clear
                  </button>
                )}
                {!inRoom && (
                  <>
                    <span aria-hidden className="text-[12.5px] font-semibold text-ink-hi/70">
                      AutoPlay
                    </span>
                    <Switch checked={autoplay} onChange={setAutoplay} label="AutoPlay" />
                  </>
                )}
              </div>
              {own.length === 0 && suggestions.length === 0 && (
                <div className="px-2 pb-1 text-[13px] text-ink-hi/45">Your queue is empty.</div>
              )}
              <div ref={listRef} className="space-y-0.5">
                {rows}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-0.5">
          {history.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">
              Nothing here yet — tracks you play land in Recently played.
            </div>
          ) : (
            <>
              <div className="flex justify-end px-2 pb-1">
                <button
                  onClick={confirmClearHistory}
                  className="text-[12px] text-ink-hi/55 hover:text-ink-hi transition-colors"
                >
                  Clear recently played
                </button>
              </div>
              {history.slice(0, 50).map((t, i) => (
                <TrackRow
                  key={`${t.id}-${i}`}
                  track={t}
                  onPlay={() => playTrack(t)}
                  menu={() => historyMenuItems(t)}
                  actions={
                    <IconBtn
                      icon={X}
                      size="sm"
                      danger
                      onClick={(e) => {
                        e.stopPropagation();
                        useLibrary.getState().removeFromHistory(t.id);
                      }}
                      title="Remove from Recently played"
                    />
                  }
                />
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- song details */

function DetailsBody() {
  const track = usePlayer(shownTrack);
  const { artistImage } = useArtistImage(track);
  const detailsDrag = useDrag({ track: track ?? { id: "", title: "", artist: "", duration: 0, thumb: "" } });

  if (!track) return <StartHere />;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
      {/* Full-width square artwork, Spotify-panel style — everything scrolls.
          The cover + title block is a drag source: drop it on a sidebar
          playlist. The whole header (art, title, artist) shares one drag
          origin so every pixel behaves the same. */}
      <div {...detailsDrag.props} className={detailsDrag.dragging ? "opacity-40" : ""}>
        <Artwork
          key={track.id}
          src={track.thumb}
          className="w-full aspect-square rounded-xl shadow-elev animate-art-in"
          iconClassName="w-10 h-10"
          alt=""
        />

        {/* Title + artist directly under the art. */}
        <div className="px-0.5 mt-2.5 animate-meta-in" key={`rrmeta-${track.id}`}>
          <div className="text-[24px] font-extrabold tracking-[-0.5px] text-ink-hi leading-tight [overflow-wrap:anywhere]" title={track.title}>
            {shortTitle(track.title)}
          </div>
          <div className="text-[14px] text-ink-hi/70 mt-1 [overflow-wrap:anywhere]">{track.artist}</div>
          {titleSource(track.title) && <div className="text-[12.5px] text-ink-hi/45 mt-1">From {titleSource(track.title)}</div>}
        </div>
      </div>

      <AboutArtistCard track={track} fallbackImage={artistImage ?? track.thumb ?? null} />
    </div>
  );
}

/** The song the panel offers before anything has played: the same for everyone, every time (the user's pick). */
const START_SONG: Track = {
  id: "Kr4EQDVETuA",
  title: "Billie Jean",
  artist: "Michael Jackson",
  artistId: "UCoIOOL7QKuBhQHVKL8y7BEQ",
  album: "Thriller",
  albumId: "MPREb_dqWTncCjkSp",
  duration: 0,
  thumb: "https://yt3.googleusercontent.com/URvHCfI2iyGAlAwqqBFeaFhU9DeKk_iuX40OIIIj8Zp0wIT3BVsJ2JRMwLLbUB9EZS7t7oDlMrI2S3OvGA=w544-h544-l90-rj",
};

/**
 * Nothing has played yet (a new listener, guest or account): instead of an
 * empty panel, Billie Jean, ready to play, with Michael Jackson's About card
 * under it, laid out like the panel's own Now playing.
 */
function StartHere() {
  const track = START_SONG;
  const play = (): void => void playSource({ type: "tracks", tracks: [track], label: track.title });
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
      <p className="px-0.5 text-[12.5px] font-semibold text-ink-hi/55 animate-meta-in">Nothing playing yet</p>
      <div>
        <Artwork src={track.thumb} className="w-full aspect-square rounded-xl shadow-elev animate-art-in" iconClassName="w-10 h-10" alt="" />
        <div className="px-0.5 mt-2.5 animate-meta-in">
          <div className="text-[24px] font-extrabold tracking-[-0.5px] text-ink-hi leading-tight">{track.title}</div>
          <div className="text-[14px] text-ink-hi/70 mt-1">{track.artist}</div>
        </div>
        <div className="flex items-center gap-2 px-0.5 mt-3">
          <Btn variant="white" icon={Play} onClick={play}>
            Play
          </Btn>
        </div>
      </div>
      <AboutArtistCard track={track} fallbackImage={track.thumb} />
    </div>
  );
}

/**
 * About the artist, Spotify-panel style: photo header with the section label
 * over its top edge, the artist's name with their verified seal, monthly
 * listeners beside a View profile pill, and the editorial blurb — the same
 * "About the artist" writing the artist page shows. Clicking it opens that
 * artist page; the whole card is also an artist drag source (the home page's
 * artist cards carry the identical payload), so dropping it on Your Library
 * follows the artist.
 */
function AboutArtistCard({
  track,
  fallbackImage,
}: {
  track: Track;
  fallbackImage: string | null;
}) {
  const about = useArtistAbout(track);
  const navigate = useUI((s) => s.navigate);
  const listeners = monthlyListenersLabel(about);
  const photo = about?.thumb ?? fallbackImage;
  // Hooks rule: called before the early return. The card renders only when
  // `about` exists, so the empty fallback payload can never begin a drag.
  const drag = useDrag({
    artist: { id: about?.artistId ?? "", name: about?.name ?? "", thumb: photo ?? undefined },
  });

  if (!about) return null;

  const open = (): void => navigate({ name: "artist", param: about.artistId });
  // A focusable box rather than a <button>: the View profile button sits inside it, and a button can't hold one.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        open();
      }}
      title={`Open ${about.name} — or drag into Your Library`}
      aria-label={`About the artist — open ${about.name}`}
      {...drag.props}
      className={`fit-host group block w-full rounded-xl bg-ink-hi/[0.04] overflow-hidden text-left cursor-pointer hover:bg-ink-hi/[0.06] transition-colors animate-fade-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      {/* Photo header with the label over its top edge, Spotify-style — a tall
          3:2 frame showing the whole artist shot, not a cropped strip. */}
      <div className="relative aspect-[3/2] bg-ink-hi/[0.06]">
        {photo ? (
          <img src={wideArtwork(photo)} alt="" className="w-full h-full object-cover object-top art-hairline" />
        ) : (
          <div className="w-full h-full art-hairline" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/10 to-transparent" />
        <div className="absolute top-2.5 left-3.5 text-[15px] font-bold text-ink-hi">About the artist</div>
      </div>

      <div className="p-3.5 pt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <FitText text={about.name} className="text-[15px] font-bold text-ink-hi" />
          <BadgeCheck className="w-[18px] h-[18px] shrink-0 text-[#4cb3ff]" fill="#4cb3ff" stroke="#0a0a0a" />
        </div>

        <div className="flex items-center justify-between gap-3 mt-2.5">
          <FitText text={listeners ?? about.subscriberCount ?? "Artist"} className="text-[13px] text-ink-hi/70" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate({ name: "artist", param: about.artistId });
            }}
            className="shrink-0 h-8 px-4 rounded-full border border-ink-hi/30 text-[13px] font-bold text-ink-hi hover:border-ink-hi/60 hover:bg-ink-hi/[0.06] transition-all active:scale-[0.98]"
          >
            View profile
          </button>
        </div>

        {about.description && (
          <p
            className="mt-2.5 text-[13px] leading-relaxed text-ink-hi/70"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {about.description}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ root */

export function RightRail() {
  const mode = useUI((s) => s.rightPanel);
  const closeQueue = () => useUI.setState({ rightPanel: "details" });

  return (
    <aside
      className="w-[328px] shrink-0 flex flex-col glass-pill rounded-2xl overflow-hidden"
      aria-label="Now playing panel"
    >
      {mode === "queue" ? <QueuePanel onClose={closeQueue} /> : mode === "room" ? <RoomPanel onClose={closeQueue} /> : <DetailsBody />}
    </aside>
  );
}
