/**
 * Album page — BitChord mobile's DetailScreen for a release: full-bleed cover
 * hero with the artist credit in the accent colour and the "SINGLE • 2023 •
 * 2 TRACKS" metadata line, shuffle + play controls, the "About the album"
 * blurb, then the release's own numbered track rows (the sleeve's running
 * order, like Apple Music's numbering on mobile).
 */
import { useEffect, useState } from "react";
import { Disc3, ListPlus, MoreHorizontal, Play, Shuffle, User } from "lucide-react";
import { Artwork, EqBars, ErrorState, ExplicitBadge, HeroSkeleton, ListSkeleton } from "../components/primitives";
import { trackMenuItems } from "../lib/trackActions";
import { downloadAll } from "../lib/downloads";
import { copyLink, youtubeAlbumLink } from "../lib/playlistShare";
import { useDrag } from "../lib/dnd";
import { fmtTime, PAGE_TITLE_SIZE, shortTitle, titleSource, titleStep } from "../lib/format";
import { FitText } from "../components/FitText";
import { pageColors, useArtworkPalette } from "../lib/palette";
import { upgradeArtwork } from "../lib/artwork";
import { queueAlbum } from "../lib/album";
import { usePlayer, useTrackPlayback } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Album, Track } from "../types";

interface AlbumData {
  album: Album;
  tracks: Track[];
}

export function AlbumView({ albumId }: { albumId: string }) {
  const [data, setData] = useState<AlbumData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [aboutExpanded, setAboutExpanded] = useState(false);
  const [aboutClipped, setAboutClipped] = useState(false);
  const playQueue = usePlayer((s) => s.playQueue);
  const navigate = useUI((s) => s.navigate);

  // The whole page wears the artwork's colour: page-tint paints the host with
  // the per-page ArtworkPalette CSS variables, then the hero gradients read
  // from the same wash + accent.
  const pagePalette = useArtworkPalette(data?.album.thumb ?? null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setAboutExpanded(false);
    setAboutClipped(false);
    window.bytune
      ?.getAlbum(albumId)
      .then((res) => {
        if (!cancelled) setData(res as AlbumData);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [albumId, nonce]);

  if (error) {
    return (
      <ErrorState
        title="Couldn't load this album"
        body="Check your connection and try again — the album page will be right here."
        onRetry={() => setNonce((n) => n + 1)}
        className="pt-10"
      />
    );
  }

  if (!data) {
    return (
      <div className="px-8 pt-6">
        <HeroSkeleton />
        <ListSkeletonInline />
      </div>
    );
  }

  const { album, tracks } = data;
  const meta = [
    album.releaseType ?? "Album",
    album.year,
    tracks.length ? `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}` : "",
  ]
    .filter(Boolean)
    .join(" • ")
    .toUpperCase();

  const play = (shuffle: boolean): void => {
    if (!tracks.length) return;
    if (shuffle) {
      usePlayer.setState({ shuffle: true });
      playQueue(tracks, Math.floor(Math.random() * tracks.length));
    } else {
      playQueue(tracks, 0);
    }
  };

  return (
    <div className="page-tint -mt-5" style={pageColors(pagePalette)}>
      {/* Hero — the cover full-bleed, credit + metadata over its lower edge. */}
      <div className="relative -mx-10 overflow-hidden">
        <div className="absolute inset-0">
          {album.thumb ? (
            <img src={upgradeArtwork(album.thumb, 1200)} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-ink-hi/[0.04] grid place-items-center">
              <Disc3 className="w-12 h-12 text-ink-hi/30" />
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

        <div className="relative flex flex-col items-center text-center px-8 pt-[240px] pb-2">
          <h1
            className={`font-display ${PAGE_TITLE_SIZE[titleStep(shortTitle(album.title))]} leading-[1.2] font-extrabold tracking-[-0.03em] text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] break-words max-w-3xl`}
            title={shortTitle(album.title) !== album.title ? album.title : undefined}
          >
            {shortTitle(album.title)}
          </h1>
          {titleSource(album.title) && (
            <div className="text-[13px] text-white/60 mt-1 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">From {titleSource(album.title)}</div>
          )}
          {album.artistId ? (
            <button
              onClick={() => navigate({ name: "artist", param: album.artistId! })}
              className="text-[15px] font-medium text-accent mt-2 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)] hover:brightness-110 transition-all"
            >
              {album.artist}
            </button>
          ) : (
            <div className="text-[15px] font-medium text-accent mt-2 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">
              {album.artist}
            </div>
          )}
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/70 mt-1.5 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">
            {meta}
          </div>

          <div className="flex items-center justify-center gap-2.5 mt-4">
            <button
              onClick={() => play(true)}
              disabled={!tracks.length}
              title="Shuffle"
              aria-label="Shuffle"
              className="w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40"
            >
              <Shuffle className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={() => play(false)}
              disabled={!tracks.length}
              className="inline-flex items-center gap-2 h-11 px-6 rounded-full bg-black/45 border border-white/10 text-[14.5px] font-semibold text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98] disabled:opacity-40"
            >
              <Play className="w-[18px] h-[18px] fill-current" />
              Play
            </button>
            <button
              onClick={(e) =>
                useUI.getState().openContextMenu(e.clientX, e.clientY, [
                  {
                    label: "Go to artist",
                    icon: User,
                    disabled: !album.artistId,
                    action: () => navigate({ name: "artist", param: album.artistId! }),
                  },
                  {
                    label: "Add all to queue",
                    icon: ListPlus,
                    disabled: !tracks.length,
                    action: () => void queueAlbum(albumId, false),
                  },
                  {
                    label: "Download all",
                    disabled: !tracks.length,
                    action: () => downloadAll(tracks, `"${album.title}"`),
                  },
                  { label: "Copy link", action: () => copyLink(youtubeAlbumLink(albumId)) },
                ])
              }
              title="More options"
              aria-label="More options"
              className="w-11 h-11 grid place-items-center rounded-full bg-black/45 border border-white/10 text-white backdrop-blur-sm hover:bg-black/60 transition-all active:scale-[0.98]"
            >
              <MoreHorizontal className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>

      <div className="px-8 pb-12 pt-2 space-y-7">
        {album.description && (
          <section>
            <h2 className="section-title text-[17px] mb-2">About the album</h2>
            <p
              onClick={() => aboutClipped && setAboutExpanded((v) => !v)}
              className={`text-[14.5px] leading-relaxed text-ink-dim ${aboutClipped || aboutExpanded ? "cursor-pointer" : ""}`}
              style={
                aboutExpanded
                  ? undefined
                  : {
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }
              }
              ref={(el) => {
                if (el && !aboutClipped) setAboutClipped(el.scrollHeight > el.clientHeight + 2);
              }}
            >
              {album.description}
            </p>
            {(aboutClipped || aboutExpanded) && (
              <button
                onClick={() => setAboutExpanded((v) => !v)}
                className="mt-1 text-[13px] font-semibold text-accent hover:brightness-110 transition-all"
              >
                {aboutExpanded ? "Less" : "More"}
              </button>
            )}
          </section>
        )}

        <section>
          <div>
            {tracks.map((song, i) => (
              <div key={`${song.id}-${i}`}>
                <AlbumTrackRow song={song} index={i} tracks={tracks} />
                {i < tracks.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[112px] mr-3" />}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function AlbumTrackRow({ song, index, tracks }: { song: Track; index: number; tracks: Track[] }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const drag = useDrag({ track: song });
  const state = useTrackPlayback(song.id);
  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, trackMenuItems(song));
  };
  return (
    <div
      {...drag.props}
      onClick={() => playQueue(tracks, index)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      className={`fit-host group flex items-center gap-3.5 h-[64px] px-3 rounded-lg cursor-pointer select-none ${
        currentId === song.id ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      {/* An album's numbers are the sleeve's own — numbered rows, like mobile. */}
      <div className="w-7 shrink-0 grid place-items-center text-[13px] text-ink-faint tabular-nums">
        {currentId === song.id ? (
          state === "playing" ? <EqBars /> : <span className="text-accent">▸</span>
        ) : (
          <>
            <span className="group-hover:hidden">{index + 1}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                playQueue(tracks, index);
              }}
              className="hidden group-hover:block text-ink-hi hover:text-ink-hi transition-colors"
              title={`Play ${song.title}`}
              aria-label={`Play ${song.title}`}
            >
              <Play className="w-3.5 h-3.5 fill-current" />
            </button>
          </>
        )}
      </div>
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
        <MoreHorizontal className="w-4 h-4" />
      </button>
    </div>
  );
}

function ListSkeletonInline() {
  return (
    <div className="space-y-0.5">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 h-[52px] px-3">
          <div className="skeleton w-10 h-10 rounded-lg" />
          <div className="flex-1">
            <div className="skeleton h-3.5 rounded-md w-[36%]" />
            <div className="skeleton h-3 rounded-md w-[20%] mt-2" />
          </div>
        </div>
      ))}
    </div>
  );
}
