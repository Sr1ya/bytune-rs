import { Fragment } from "react";
import { AlertCircle, Check, Heart, Loader2, MoreHorizontal, Pause, Play } from "lucide-react";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI, type MenuItem } from "../stores/ui";
import { trackMenuItems } from "../lib/trackActions";
import { useDrag } from "../lib/dnd";
import { fmtTime, shortTitle } from "../lib/format";
import { Artwork, EqBars, EmptyState, ExplicitBadge } from "./primitives";
import { PlayingLight, useRowLight } from "./RowLight";
import { FitText } from "./FitText";
import type { Track } from "../types";

/** Download state glyph for a track row — spinner / green check / red fail. */
export function DownloadBadge({ id }: { id: string }) {
  const dl = useLibrary((s) => s.downloads[id]);
  if (!dl) return null;
  if (dl.status === "downloading") {
    return (
      <span className="p-1.5 rounded-md text-ink-hi" title="Downloading…">
        <Loader2 className="w-4 h-4 animate-spin" />
      </span>
    );
  }
  if (dl.status === "done") {
    return (
      <span className="p-1.5 rounded-md text-emerald-400" title="Downloaded">
        <Check className="w-4 h-4" />
      </span>
    );
  }
  return (
    <span className="p-1.5 rounded-md text-red-400" title="Download failed">
      <AlertCircle className="w-4 h-4" />
    </span>
  );
}

interface TrackRowProps {
  track: Track;
  index: number;
  isCurrent: boolean;
  isPlaying: boolean;
  onPlay: (index: number) => void;
  menuFor: (track: Track) => MenuItem[];
  showAlbum: boolean;
  /** the pointer came onto this row: the list's light moves to it */
  onHover: (row: HTMLElement, thumb: string) => void;
}

function TrackRow({ track, index, isCurrent, isPlaying, onPlay, menuFor, showAlbum, onHover }: TrackRowProps) {
  const liked = useLibrary((s) => s.liked.some((t) => t.id === track.id));
  const toggleLike = useLibrary((s) => s.toggleLike);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const navigate = useUI((s) => s.navigate);
  const drag = useDrag({ track });
  const tint = tintHoverHandlers(track.thumb);

  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, menuFor(track));
  };

  return (
    <div
      {...drag.props}
      onMouseEnter={(e) => {
        tint.onMouseEnter();
        onHover(e.currentTarget, track.thumb);
      }}
      onMouseLeave={tint.onMouseLeave}
      onClick={() => onPlay(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }}
      className={`tl-row fit-host group flex items-center gap-3.5 h-[60px] px-3 rounded-lg cursor-pointer select-none ${
        isCurrent ? "bg-ink-hi/[0.06]" : "hover:bg-ink-hi/[0.04]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      {/* The playing song keeps a soft light of its own cover. */}
      {isCurrent && <PlayingLight thumb={track.thumb} />}
      {/* index / hover play / eq */}
      <div className="w-7 shrink-0 grid place-items-center text-[13px] text-ink-faint tabular-nums">
        {isCurrent && isPlaying ? (
          <EqBars />
        ) : (
          <>
            <span className={`group-hover:hidden ${isCurrent ? "text-ink-hi font-medium" : ""}`}>{index + 1}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isCurrent) {
                  // clicking play on the current row toggles playback
                  usePlayer.getState().toggle();
                } else {
                  onPlay(index);
                }
              }}
              className="hidden group-hover:block text-ink-hi hover:text-ink-hi transition-colors"
              title={isCurrent && isPlaying ? "Pause" : "Play"}
              aria-label={isCurrent && isPlaying ? "Pause" : `Play ${track.title}`}
            >
              {isCurrent && isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            </button>
          </>
        )}
      </div>

      <Artwork
        src={track.thumb}
        className="w-[52px] h-[52px] rounded-lg shrink-0"
        iconClassName="w-4 h-4"
        alt=""
      />

      {/* min-w floor: with showAlbum the fixed columns (index · artwork · album ·
          controls · time) can exceed a narrow list and, because the title's flex
          basis is 0, it would collapse to zero width before anything else gives.
          The floor keeps the title visible; the album column shrinks instead. */}
      <div className="flex-1 min-w-[120px]">
        <div className={`flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.2px] ${isCurrent ? "text-ink-hi" : "text-ink-hi"}`}>
          {track.explicit && <ExplicitBadge />}
          <FitText text={shortTitle(track.title)} full={track.title} />
        </div>
        <FitText text={track.artist} className="text-[14px] text-ink-dim mt-0.5" />
      </div>

      {showAlbum && (
        <div className="tl-album w-52 min-w-0 text-xs text-ink-faint">
          {track.albumId ? (
            <button
              className="block max-w-full hover:text-ink hover:underline text-left transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                navigate({ name: "album", param: track.albumId });
              }}
            >
              <FitText text={track.album ? shortTitle(track.album) : "Single"} full={track.album} />
            </button>
          ) : (
            <FitText text={track.album ? shortTitle(track.album) : ""} full={track.album} />
          )}
        </div>
      )}

      <div className="w-[88px] shrink-0 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleLike(track);
          }}
          title={liked ? "Remove from Liked" : "Add to Liked"}
          aria-label={liked ? "Remove from Liked" : "Add to Liked"}
          className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
        >
          <Heart key={liked ? "liked" : "unliked"} className={`w-4 h-4 animate-icon-pop ${liked ? "fill-ink-hi text-ink-hi" : ""}`} />
        </button>
        <span className="opacity-80">
          <DownloadBadge id={track.id} />
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            openMenu(e.clientX, e.clientY);
          }}
          title="More options"
          aria-label="More options"
          className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      <div className="w-11 shrink-0 text-right text-xs text-ink-faint tabular-nums">
        {track.duration > 0 ? fmtTime(track.duration) : "—"}
      </div>
    </div>
  );
}

interface TrackListProps {
  tracks: Track[];
  onPlay?: (index: number) => void;
  /** The sidebar row these songs play from (the player's playingFrom). */
  from?: string;
  showAlbum?: boolean;
  showHeader?: boolean;
  menuFor?: (track: Track) => MenuItem[];
  emptyLabel?: string;
  emptyTitle?: string;
}

export function TrackList({
  tracks,
  onPlay,
  from,
  showAlbum = true,
  showHeader = true,
  menuFor = trackMenuItems,
  emptyLabel,
  emptyTitle = "Nothing here yet",
}: TrackListProps) {
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const playing = usePlayer((s) => s.playing);
  const playQueue = usePlayer((s) => s.playQueue);
  const play = onPlay ?? ((i: number) => playQueue(tracks, i, from));
  const rowLight = useRowLight();

  if (!tracks.length) {
    return <EmptyState icon={Play} title={emptyTitle} body={emptyLabel ?? "Tracks will appear here."} />;
  }

  return (
    <div className="tl">
      {showHeader && (
        <div className="flex items-center gap-3 px-3 pb-2.5 mb-1 border-b border-ink-hi/[0.06] text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">
          <div className="w-7 shrink-0">#</div>
          <div className="w-[52px] shrink-0" />
          <div className="flex-1 min-w-0">Title</div>
          {showAlbum && <div className="tl-album w-52 shrink-0">Album</div>}
          <div className="w-[88px] shrink-0" />
          <div className="w-11 shrink-0 text-right">Time</div>
        </div>
      )}
      <div className="relative" onMouseLeave={rowLight.leave}>
        {rowLight.light}
        {tracks.map((track, i) => (
          <Fragment key={`${track.id}-${i}`}>
            <TrackRow
              track={track}
              index={i}
              isCurrent={track.id === currentId}
              isPlaying={playing}
              onPlay={play}
              menuFor={menuFor}
              showAlbum={showAlbum}
              onHover={rowLight.hover}
            />
            {/* Hairline divider, inset to the title column — mobile's
                ROW_DIVIDER_INSET clears the 52dp artwork the same way. */}
            {i < tracks.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[120px] mr-3" />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
