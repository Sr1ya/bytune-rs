/**
 * Artist page — BitChord mobile's artist screen: a full-bleed photo header
 * with the artist's name, subscriber / monthly-listener chips and the
 * shuffle + play controls, the "About the artist" blurb, "Top songs", then
 * YouTube's own section carousels (Albums, Singles & EPs, Featured on,
 * Playlists by X, Fans might also like) in the order the page ships them.
 */
import { useEffect, useRef, useState } from "react";
import { Heart, ListPlus, MoreHorizontal, MoreVertical, Play, Shuffle, User } from "lucide-react";
import { Artwork, EqBars, ErrorState, ExplicitBadge, HeroSkeleton, ListSkeleton, ShelfScroller } from "../components/primitives";
import { trackMenuItems } from "../lib/trackActions";
import { useDrag } from "../lib/dnd";
import { fmtTime, shortTitle, titleStep } from "../lib/format";
import { FitText } from "../components/FitText";
import { pageColors, useArtworkPalette } from "../lib/palette";
import { upgradeArtwork } from "../lib/artwork";
import { useLibrary } from "../stores/library";
import { usePlayer, useTrackPlayback } from "../stores/player";
import { useUI } from "../stores/ui";
import type { ArtistPageData, HomeItem, Track } from "../types";

/** Mobile's MAX_ARTIST_SONGS — the "Top songs" shelf stops at twenty. */
const MAX_ARTIST_SONGS = 20;

/** Mobile SectionCard — square art, title, subtitle, one per shelf slot. */
function SectionCard({ item }: { item: HomeItem }) {
  const navigate = useUI((s) => s.navigate);
  const thumb = item.track?.thumb ?? item.album?.thumb ?? item.artist?.thumb ?? item.playlist?.thumb;
  const title = item.track?.title ?? item.album?.title ?? item.artist?.name ?? item.playlist?.title ?? "";
  const subtitle =
    item.artist?.subtitle ??
    item.album?.artist ??
    (item.playlist?.subtitle || (item.playlist ? "Playlist" : "")) ??
    "";
  const round = item.kind === "artist";
  void round;

  const onOpen = (): void => {
    if (item.kind === "album" && item.album) navigate({ name: "album", param: item.album.id });
    else if (item.kind === "artist" && item.artist) navigate({ name: "artist", param: item.artist.id });
    else if (item.kind === "playlist" && item.playlist) navigate({ name: "ytplaylist", param: item.playlist.id });
    else if (item.kind === "track" && item.track) usePlayer.getState().playTrack(item.track);
  };

  return (
    <button onClick={onOpen} className="fit-host group w-[172px] shrink-0 text-left cursor-pointer">
      <Artwork
        src={thumb}
        className={round ? "w-[172px] h-[172px] rounded-full" : "w-[172px] h-[172px] rounded-[10px]"}
        iconClassName="w-7 h-7"
        alt=""
      />
      <FitText lines={2} text={shortTitle(title)} full={title} className="mt-2 text-[14px] font-semibold text-ink-hi leading-snug" />
      <FitText text={subtitle} className="text-[12.5px] text-ink-dim mt-0.5" />
    </button>
  );
}

function SongRow({ song, songs, index, from }: { song: Track; songs: Track[]; index: number; from: string }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const drag = useDrag({ track: song });
  const state = useTrackPlayback(song.id);
  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, trackMenuItems(song));
  };
  return (
    <div
      {...drag.props}
      onClick={() => playQueue(songs, index, from)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      className={`fit-host group flex items-center gap-3.5 h-[64px] px-3 rounded-lg cursor-pointer select-none ${
        state ? "bg-ink-hi/[0.08]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      <span className="relative shrink-0">
        <Artwork src={song.thumb} className="w-[52px] h-[52px] rounded-lg" iconClassName="w-4 h-4" alt="" />
        {state === "playing" && (
          <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/50">
            <EqBars />
          </span>
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.2px] text-ink-hi">
          {song.explicit && <ExplicitBadge />}
          <FitText text={shortTitle(song.title)} full={song.title} />
        </div>
        <FitText text={song.artist} className="text-[14px] text-ink-dim mt-0.5" />
      </div>
      <div className="shrink-0 text-[13px] text-ink-faint tabular-nums">
        {song.duration > 0 ? fmtTime(song.duration) : ""}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          openMenu(e.clientX, e.clientY);
        }}
        title="More options"
        aria-label={`More options for ${song.title}`}
        className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
    </div>
  );
}

/** "About the artist" — three lines, then a More/Less toggle (mobile AboutSection). */
function AboutSection({ title, text }: { title: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);

  const measure = (): void => {
    const el = ref.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 2);
  };
  useEffect(() => {
    setExpanded(false);
    setClipped(false);
    const t = window.setTimeout(measure, 50);
    return () => window.clearTimeout(t);
  }, [text]);

  return (
    <section className="animate-fade-in">
      <h2 className="section-title text-[17px] mb-2">{title}</h2>
      <p
        ref={ref}
        onClick={() => clipped && setExpanded((v) => !v)}
        className={`text-[14.5px] leading-relaxed text-ink-dim whitespace-pre-line ${clipped || expanded ? "cursor-pointer" : ""}`}
        style={
          expanded
            ? undefined
            : {
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
        }
      >
        {text}
      </p>
      {(clipped || expanded) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[13px] font-semibold text-accent hover:brightness-110 transition-all"
        >
          {expanded ? "Less" : "More"}
        </button>
      )}
    </section>
  );
}

export function ArtistView({ artistId }: { artistId: string }) {
  const [state, setState] = useState<ArtistPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const playQueue = usePlayer((s) => s.playQueue);

  const pagePalette = useArtworkPalette(state?.artist.thumb ?? null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    window.bytune
      ?.getArtist(artistId)
      .then((res) => {
        if (!cancelled) setState(res as ArtistPageData);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [artistId, nonce]);

  if (error) {
    return (
      <ErrorState
        title="Couldn't load this artist"
        body="This is usually a connection hiccup. Give it another try."
        onRetry={() => setNonce((n) => n + 1)}
      />
    );
  }
  if (!state) {
    return (
      <div className="px-8 pt-6">
        <HeroSkeleton />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  const { artist, description, subscriberCount, monthlyListeners, songs, shelves } = state;
  const top = songs.slice(0, MAX_ARTIST_SONGS);

  const shuffle = (): void => {
    if (!top.length) return;
    usePlayer.setState({ shuffle: true });
    playQueue(top, Math.floor(Math.random() * top.length), artistId);
  };

  const openMore = (x: number, y: number): void => {
    const followed = useLibrary.getState().followedArtists.some((a) => a.id === artist.id);
    useUI.getState().openContextMenu(x, y, [
      {
        label: "Add all top songs to queue",
        icon: ListPlus,
        disabled: !top.length,
        action: () => {
          usePlayer.getState().addToQueue(top);
          useUI
            .getState()
            .toast(`Added ${top.length === 1 ? "1 song" : `${top.length} songs`} to queue`);
        },
      },
      {
        label: followed ? "Unfollow artist" : "Follow artist",
        icon: Heart,
        separatorBefore: true,
        action: () => {
          if (followed) {
            useLibrary.getState().unfollowArtist(artist.id);
            useUI.getState().toast("Removed from your library", "info");
          } else {
            useLibrary.getState().followArtist({ id: artist.id, name: artist.name, thumb: artist.thumb });
            useUI.getState().toast("Added to your library", "info");
          }
        },
      },
    ]);
  };

  return (
    <div className="page-tint -mt-5" style={pageColors(pagePalette)}>
      {/* Hero — full-bleed photo, scrim dissolving into the page, name and
          stat chips over the lower edge, exactly the mobile artist header. */}
      <div className="relative -mx-10 overflow-hidden">
        <div className="absolute inset-0">
          {artist.thumb ? (
            <img src={upgradeArtwork(artist.thumb, 1200)} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-ink-hi/[0.04]" />
          )}
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(to bottom,
                rgb(var(--page-bg) / 0.25) 0%,
                rgb(var(--page-bg) / 0.45) 55%,
                rgb(var(--page-bg) / 0.88) 82%,
                rgb(var(--page-bg)) 100%)`,
            }}
          />
        </div>

        <div className="relative flex flex-col items-center text-center px-8 pt-[300px] pb-2">
          <h1
            className={`font-display ${["text-[40px]", "text-[32px]", "text-[26px]"][titleStep(artist.name)]} leading-[1.1] font-extrabold tracking-[-0.03em] text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] break-words max-w-3xl`}
          >
            {artist.name}
          </h1>

          {(subscriberCount || monthlyListeners) && (
            <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
              {subscriberCount && (
                <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-black/45 border border-white/10 text-[12px] font-medium text-white/85 backdrop-blur-sm">
                  <User className="w-3.5 h-3.5" />
                  {subscriberCount.split(" ")[0]} subscribers
                </span>
              )}
              {monthlyListeners && (
                <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-black/45 border border-white/10 text-[12px] font-medium text-white/85 backdrop-blur-sm">
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M4 10v4M9 6v12M14 9v6M19 4v16" strokeLinecap="round" />
                  </svg>
                  {/* YouTube says "monthly audience"; the chip says listeners,
                      the number kept and the label re-said, as on mobile. */}
                  {monthlyListeners.split(" ")[0]} monthly listeners
                </span>
              )}
            </div>
          )}

          <div className="flex items-center justify-center gap-2.5 mt-4">
            <button
              onClick={shuffle}
              disabled={!top.length}
              title="Shuffle"
              aria-label="Shuffle"
              className="w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40"
            >
              <Shuffle className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => top.length && playQueue(top, 0, artistId)}
              disabled={!top.length}
              className="inline-flex items-center gap-2 h-11 px-6 rounded-full bg-black/45 border border-white/10 text-[14.5px] font-semibold text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40"
            >
              <Play className="w-[18px] h-[18px] fill-current" />
              Play
            </button>
            <button
              onClick={(e) => openMore(e.clientX, e.clientY)}
              title="More options"
              aria-label="More options"
              className="w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98]"
            >
              <MoreHorizontal className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>

      <div className="px-8 pb-12 space-y-7">
        {description && <AboutSection title="About the artist" text={description} />}

        {top.length > 0 && (
          <section className="animate-fade-in">
            <h2 className="section-title text-[21px] mb-3">Top songs</h2>
            <div>
              {top.map((song, i) => (
                <div key={`${song.id}-${i}`}>
                  <SongRow song={song} songs={top} index={i} from={artistId} />
                  {i < top.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[80px] mr-3" />}
                </div>
              ))}
            </div>
          </section>
        )}

        {shelves.map((shelf) => (
          <section key={shelf.title} className="animate-fade-in">
            <h2 className="section-title text-[21px] mb-3">{shelf.title}</h2>
            <ShelfScroller arrowTop="top-[68px]">
              {shelf.items.map((item, i) => (
                <SectionCard key={`${shelf.title}-${i}`} item={item} />
              ))}
            </ShelfScroller>
          </section>
        ))}
      </div>
    </div>
  );
}
