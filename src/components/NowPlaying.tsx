/**
 * NowPlaying — the fullscreen cinematic mode.
 *
 * A pure presentation layer around the app's existing machinery: it holds no
 * playback, queue, lyrics or audio state of its own.
 *
 *   bottom   the exact PlayerBar the shell uses — the same component instance
 *            shape, unchanged; fullscreen adds no second transport.
 *   left     the artwork as the hero (deep shadow, a whisper of ambient glow),
 *            song information and the favourite action underneath.
 *   right    the existing synced-lyrics view (LyricsView, `hero` scale) and
 *            the existing queue sheet (QueuePanel), switched by a
 *            Lyrics | Queue control.
 *   behind   the artwork's own colours — an ArtworkPalette floor plus a
 *            heavily blurred cover — crossfaded per track and held dark.
 *   idle     while music plays and the pointer rests, the controls and the
 *            cursor go (useIdle and the .fs-idle rules in index.css).
 *
 * Nothing here runs on a loop: WebKitGTK redraws the whole full-screen window
 * for every frame of any running animation, so the room only moves when
 * something happens (see the fullscreen notes in index.css).
 *
 * Entering releases the shell into a true OS fullscreen; the mount/exit
 * choreography below is the same state machine the previous fullscreen mode
 * used, kept verbatim so the window behavior (Esc, rapid toggles, reduced
 * motion) is untouched.
 */
import { useFullMotion } from "../lib/fullMotion";
import { NowPlaying as FullNowPlaying } from "./full/NowPlaying";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChevronDown, Heart, Music2 } from "lucide-react";
import { PlayerBar } from "./PlayerBar";
import { QueuePanel } from "./RightRail";
import { LyricsView } from "./SyncedLyrics";
import { requestLyrics } from "./LyricsCenter";
import { usePlayer, shownTrack } from "../stores/player";
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { useArtworkPalette, type ArtworkPalette } from "../lib/palette";
import { upgradeArtwork } from "../lib/artwork";
import { useSoftArtwork } from "../lib/softArt";
import { useDrag } from "../lib/dnd";
import { shortTitle, titleSource } from "../lib/format";
import { FitText } from "./FitText";
import { playFragmented, useCanvas } from "../lib/canvas";
import { useLyricsOffset } from "../lib/lyricsOffset";
import { useIdle } from "../lib/useIdle";
import type { LyricsResult } from "../types";

/** How long the pointer rests before the controls and the cursor go (YouTube's wait). */
const IDLE_MS = 3000;

/* ================================================================ backdrop */

/**
 * One track's atmosphere: an ArtworkPalette floor, a heavily blurred
 * over-scaled cover (the artwork "lighting the room"), two palette
 * glows, and a scrim that keeps every word readable on any sleeve. Each
 * layer freezes its own artwork at mount, so a song change fades whole
 * layers over each other instead of repainting one in place.
 */
function FsBackdropLayer({
  artwork,
  boost,
  legacy,
  enter,
}: {
  artwork: string | null;
  boost: boolean;
  legacy: boolean;
  enter: boolean;
}) {
  const palette = useArtworkPalette(artwork);
  // The cover "lighting the room", blurred once rather than every frame (lib/softArt): what
  // `blur(100px) brightness(0.78) saturate(1.25)` drew, cover-fitted to the window and grown 40%.
  const room = useSoftArtwork(legacy ? null : artwork, { blurPx: 100, shownW: 1800, shownH: 1800, saturate: 1.25, brightness: 0.78 });
  return (
    <div className={`absolute inset-0 ${enter ? "fs-bg-in" : ""}`}>
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(180deg, rgb(${palette.background}) 0%, #0a0a0d 88%)` }}
      />
      {room && (
        <img
          src={room}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: "scale(1.4)", opacity: boost ? 0.65 : 0.48 }}
        />
      )}
      <div
        className="fs-drift absolute -inset-[20%]"
        style={{
          background: `radial-gradient(42% 44% at 22% 22%, rgb(${palette.accent} / ${boost ? 0.24 : 0.15}), transparent 66%),
                       radial-gradient(38% 40% at 80% 74%, rgb(${palette.wash} / ${boost ? 0.28 : 0.18}), transparent 64%)`,
        }}
      />
      {/* Legibility scrim — lightened so the artwork's own colours carry the
          room; just enough black left to keep every word readable. */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/[0.04] to-black/25" />
    </div>
  );
}

/**
 * The fullscreen background. Keeps the previous track's layer mounted
 * underneath while the new one fades in (1.3s), so a song change never
 * flashes or dips to black.
 */
function FsBackdrop({
  artwork,
  boost,
  legacy,
}: {
  artwork: string | null;
  boost: boolean;
  legacy: boolean;
}) {
  const id = artwork ?? "none";
  const [layers, setLayers] = useState<string[]>([id]);

  useEffect(() => {
    setLayers((prev) => (prev[prev.length - 1] === id ? prev : [...prev.slice(-2), id]));
    const timer = window.setTimeout(() => {
      setLayers((prev) => (prev.length > 1 ? prev.filter((x) => x === id) : prev));
    }, 1300);
    return () => window.clearTimeout(timer);
  }, [id]);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
      {layers.map((layerId, i) => (
        <FsBackdropLayer
          key={`${layerId}-${i}`}
          artwork={layerId === "none" ? null : layerId}
          boost={boost}
          legacy={legacy}
          enter={i === layers.length - 1}
        />
      ))}
    </div>
  );
}

/* ============================================================ mode switch */

function FsModeSwitch({
  mode,
  onChange,
}: {
  mode: "lyrics" | "queue";
  onChange: (m: "lyrics" | "queue") => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] p-1">
      {(["lyrics", "queue"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={`h-8 rounded-full px-4 text-[13px] font-semibold transition-all active:scale-[0.97] ${
            mode === m ? "bg-white/[0.14] text-white" : "text-white/55 hover:text-white/90"
          }`}
        >
          {m === "lyrics" ? "Lyrics" : "Queue"}
        </button>
      ))}
    </div>
  );
}

/* ================================================================== lyrics */

/**
 * The lyrics panel. Its live line rests at the album cover's centre height:
 * the panel is measured against the artwork tile (boxes move with the
 * viewport and with maximize/restore), so the anchor is a fraction re-derived
 * whenever either box changes size. The artwork row's entrance settles inside
 * the first ~400ms, hence the two timed re-measures.
 */
function FsLyrics({
  artRef,
  trackId,
  lyrics,
  loading,
  offset,
}: {
  artRef: RefObject<HTMLDivElement | null>;
  trackId: string;
  lyrics: LyricsResult | null;
  loading: boolean;
  offset: number;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState(0.5);
  useLayoutEffect(() => {
    const measure = (): void => {
      const art = artRef.current;
      const panel = panelRef.current;
      if (!art || !panel) return;
      const a = art.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      if (p.height < 40) return;
      const next = Math.min(0.6, Math.max(0.08, (a.top + a.height / 2 - p.top) / p.height));
      // Half a pixel, so a glide moves the line every frame instead of in steps.
      setAnchor((prev) => (Math.abs(prev - next) * p.height > 0.5 ? next : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (artRef.current) ro.observe(artRef.current);
    if (panelRef.current) ro.observe(panelRef.current);
    window.addEventListener("resize", measure);
    const settles = [60, 400].map((ms) => window.setTimeout(measure, ms));
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      settles.forEach((t) => window.clearTimeout(t));
    };
  }, [artRef, trackId]);

  return (
    <div ref={panelRef} className="group relative flex-1 min-h-0 flex">
      {/* Same LyricsView the centre pane uses, hero scale — keyed per track
          so the scroll position resets with the song, exactly like
          LyricsCenter. */}
      <LyricsView key={trackId} trackKey={trackId} lyrics={lyrics} loading={loading} hero anchor={anchor} offset={offset} />
    </div>
  );
}

/* ================================================================ the view */

function LiteNowPlaying() {
  const open = useUI((s) => s.nowPlayingOpen);
  const close = useUI((s) => s.toggleNowPlaying);

  /**
   * Fullscreen transition state machine — enter/exit choreography without
   * touching layout or functionality:
   * - open → mount and replay the entrance (fresh mounts animate on their
   *   own); reopening mid-exit cancels the exit timer and snaps back with
   *   no remount, so rapid toggling never storms effects or media.
   * - close intent → play the 210ms exit on the still-mounted overlay while
   *   the OS leaves fullscreen underneath, then unmount. One timer, no
   *   stacking, always cleaned up.
   * - reduced motion → no exit delay at all, mount/unmount instantly.
   */
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  const mountedRef = useRef(open);
  const exitTimer = useRef<number | null>(null);
  /** True when THIS view put the window into fullscreen — an F11 fullscreen
      the user already had must survive closing the view. */
  const enteredFsRef = useRef(false);
  useEffect(() => {
    if (open) {
      // Reopening mid-exit: cancel the exit and snap back — no remount, so
      // rapid toggling never storms effects or media. A fresh mount needs
      // nothing: newly inserted nodes play the entrance on their own.
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
      mountedRef.current = true;
      setMounted(true);
      setExiting(false);
      enteredFsRef.current = !useUI.getState().osFullscreen;
      void window.bytune?.setFullScreen(true);
      return undefined;
    }
    if (!mountedRef.current) return undefined;
    // OS leaves fullscreen in parallel with the fade — but only when this
    // view entered it; an F11 fullscreen predating the view stays.
    if (enteredFsRef.current) {
      enteredFsRef.current = false;
      void window.bytune?.setFullScreen(false);
    }
    if (
      document.documentElement.classList.contains("reduce-motion") ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      mountedRef.current = false;
      setMounted(false);
      return undefined;
    }
    setExiting(true);
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      mountedRef.current = false;
      setMounted(false);
      setExiting(false);
    }, 210);
    return () => {
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, [open]);

  const track = usePlayer((s) => s.queue[s.index] ?? null);
  // What the screen shows: switches to the incoming song half way through a
  // blend. Lyrics stay on `track`, whose clock they follow.
  const shown = usePlayer(shownTrack);
  const playing = usePlayer((s) => s.playing);

  const liked = useLibrary((s) => (shown ? s.liked.some((t) => t.id === shown.id) : false));
  const toggleLike = useLibrary((s) => s.toggleLike);

  // Appearance switches that shape this view: full-bleed art strengthens the
  // room's artwork presence (the atmosphere is always artwork-driven now),
  // legacy mesh drops the blurred-cover layer, animated canvas swaps the
  // sleeve for its looping video when one exists.
  const boost = useSettings((st) => st.fullBleedArtwork);
  const legacyMesh = useSettings((st) => st.legacyMeshGradient);
  const animatedCanvas = useSettings((st) => st.animatedCanvas);
  const canvas = useCanvas(shown ?? null);
  const canvasUrl = canvas?.url ?? null;
  const canvasFragmented = canvas?.source === "apple";
  const canvasVideoRef = useRef<HTMLVideoElement | null>(null);
  // Apple's clips loop through Media Source (lib/canvas); their src is set here, before play or pause.
  useEffect(() => {
    const v = canvasVideoRef.current;
    if (!v || !canvasUrl || !canvasFragmented) return;
    return playFragmented(v, canvasUrl);
  }, [canvasUrl, canvasFragmented, animatedCanvas]);
  useEffect(() => {
    const v = canvasVideoRef.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, canvasUrl]);

  const palette: ArtworkPalette = useArtworkPalette(shown?.thumb ?? null);

  // Lyrics — the same cached lookup the centre-pane lyrics view uses (warmed
  // by prefetchLyrics the moment a track starts). No second lyrics pipeline.
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  useEffect(() => {
    if (!open || !track) {
      setLyrics(null);
      return;
    }
    let cancelled = false;
    setLyrics(null);
    setLyricsLoading(true);
    void requestLyrics(track).then((r) => {
      if (cancelled) return;
      setLyrics(r ?? null);
      setLyricsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [track?.id, open]);

  // This song's nudge plus this device's lyrics timing; nothing automatic.
  const lyricsOffset = useLyricsOffset(track?.id);

  const [mode, setMode] = useState<"lyrics" | "queue">("lyrics");

  // The artwork tile the lyrics panel (FsLyrics) measures its anchor against.
  const artRef = useRef<HTMLDivElement | null>(null);

  // YouTube's rule: while music plays and the pointer rests, the controls
  // and the cursor go (the .fs-idle rules in index.css); a move brings them
  // back. Paused, or under a menu or dialog, the controls stay. It holds
  // through the exit fade, so leaving never replays it.
  const menuOpen = useUI((s) => !!(s.contextMenu || s.dialog || s.playlistPicker));
  const idle = useIdle(mounted && playing && !menuOpen, IDLE_MS, ".fs-chrome");

  // While this view covers the window, the shell underneath is not painted
  // (html.np-open in index.css): it would otherwise be laid out and drawn
  // again, at full-screen size, under an opaque overlay.
  useLayoutEffect(() => {
    const on = mounted && !exiting;
    document.documentElement.classList.toggle("np-open", on);
    return () => document.documentElement.classList.remove("np-open");
  }, [mounted, exiting]);

  // Spotify's entry hint: "To exit full screen, press Esc" — fades in with the
  // view, lingers ~3s, fades back out.
  const [escToastShown, setEscToastShown] = useState(false);
  useEffect(() => {
    if (!open) return;
    setEscToastShown(true);
    const t = window.setTimeout(() => setEscToastShown(false), 3000);
    return () => window.clearTimeout(t);
  }, [open]);

  const heroDrag = useDrag({ track: shown ?? { id: "", title: "", artist: "", duration: 0, thumb: "" } });

  if (!mounted) return null;

  return (
    <div
      className={`np-root fixed inset-0 z-[100] overflow-hidden bg-black animate-fade-in ${exiting ? "fs-exiting" : ""} ${
        idle ? "fs-idle" : ""
      }`}
    >
      <FsBackdrop artwork={shown?.thumb ?? null} boost={boost} legacy={legacyMesh} />

      <div className="relative h-full flex flex-col">
        {/* Fullscreen entry hint — Spotify's "To exit full screen, press Esc".
            Parked inside the header band so it never covers the mode switch
            that sits at the top of the lyrics column. */}
        <div
          aria-live="polite"
          className={`absolute left-1/2 top-2 z-30 -translate-x-1/2 pointer-events-none transition-all duration-300 ${
            escToastShown ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3"
          }`}
        >
          <div className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-[#1c1c1e]/95 px-4 py-3 shadow-float">
            <span className="text-[14.5px] text-white">To exit full screen, press</span>
            <kbd className="grid h-7 min-w-[36px] place-items-center rounded-[5px] border border-white/40 px-2 text-[13px] text-white">
              Esc
            </kbd>
          </div>
        </div>

        {/* Header — close. Idle, it fades. */}
        <div className="fs-chrome fs-head relative h-14 shrink-0 flex items-center px-3">
          <button
            onClick={close}
            title="Close (Esc)"
            aria-label="Close Now Playing"
            className="relative z-10 p-2 -ml-1 rounded-full text-white/75 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <ChevronDown className="w-5 h-5" />
          </button>
        </div>

        {!track || !shown ? (
          <div className="flex-1 grid place-items-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-[18px] glass grid place-items-center mx-auto mb-5">
                <Music2 className="w-7 h-7 text-white/55" />
              </div>
              <p className="text-sm text-white/85">Nothing playing yet</p>
              <p className="text-[13px] text-white/55 mt-1">Play something and it will show up here.</p>
            </div>
          </div>
        ) : (
          /* Body — artwork column and lyrics column share the space between
             the header and the play bar. Percent-based widths + min() sizing,
             so the composition holds from 16:9 laptops to ultrawides. */
          <div className="fs-body flex-1 min-h-0 min-w-0 flex flex-col lg:flex-row items-stretch justify-center gap-8 lg:gap-12 xl:gap-20 px-8 lg:px-14 pb-4">
            {/* LEFT — the artwork is the hero; info and visualizer stay compact. */}
            <div className="flex-1 lg:flex-none lg:w-[44%] xl:w-[42%] max-w-[640px] min-w-0 min-h-0 flex flex-col items-center justify-center">
              <div className="relative w-full flex justify-center fs-enter">
                {/* Ambient glow — the sleeve's own accent, spilling behind it. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 aspect-square w-[min(52vh,44vw,660px)] rounded-full"
                  style={{
                    background: `radial-gradient(50% 50% at 50% 52%, rgb(${palette.accent} / 0.13), transparent 70%)`,
                    filter: "blur(48px)",
                  }}
                />
                {/* Breathing (index.css .fs-breathe): a scale on a layer of its own, so the GPU
                    scales the drawn cover and nothing is repainted. */}
                <div className={`fs-breathe ${playing ? "is-breathing" : ""}`}>
                  <div
                    ref={artRef}
                    {...heroDrag.props}
                    className={`fs-art relative rounded-[20px] overflow-hidden shadow-art art-hairline aspect-square grid place-items-center bg-white/[0.04] ${
                      heroDrag.dragging ? "opacity-60" : ""
                    }`}
                    title="Drag to a playlist to add this song"
                  >
                    {canvasUrl && animatedCanvas ? (
                      <>
                        {/* Still art underneath: if the video stalls, the cover stands. */}
                        <img src={upgradeArtwork(shown.thumb, 1200)} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        <video
                          key={canvasUrl}
                          ref={canvasVideoRef}
                          src={canvasFragmented ? undefined : canvasUrl}
                          autoPlay
                          loop={!canvasFragmented}
                          muted
                          playsInline
                          className="relative w-full h-full object-cover animate-fade-in"
                        />
                      </>
                    ) : shown.thumb ? (
                      <img
                        key={shown.id}
                        src={upgradeArtwork(shown.thumb, 1200)}
                        alt=""
                        className="w-full h-full object-cover animate-art-in"
                      />
                    ) : (
                      <Music2 className="w-16 h-16 text-white/35" />
                    )}
                  </div>
                </div>
              </div>

              {/* Song information — keyed per track so a song change replays
                  the small fade instead of hard-swapping the words. */}
              <div
                key={`fsmeta-${shown.id}`}
                className="mt-7 flex flex-col items-center text-center max-w-full animate-meta-in"
              >
                <div className="font-display text-[26px] xl:text-[30px] font-extrabold tracking-[-0.03em] text-white min-w-0 max-w-full">
                  <FitText mode="auto" followsPlayback text={shortTitle(shown.title)} full={shown.title} />
                </div>
                <div className="text-[14px] xl:text-[15px] text-white/55 mt-1.5 min-w-0 max-w-full">
                  <FitText mode="auto" followsPlayback text={shown.artist} />
                </div>
                {titleSource(shown.title) && <div className="text-[12.5px] text-white/40 mt-1">From {titleSource(shown.title)}</div>}
                {/* Idle, the pill fades. */}
                <div className="fs-chrome fs-like mt-4 h-8">
                  <button
                    onClick={() => toggleLike(shown)}
                    title={liked ? "Remove from Liked Songs" : "Add to Liked Songs"}
                    aria-pressed={liked}
                    className="inline-flex items-center gap-2 h-8 px-4 rounded-full bg-white/[0.06] hover:bg-white/[0.11] text-white/60 hover:text-white text-[12.5px] font-semibold transition-all active:scale-95"
                  >
                    <Heart className={`w-3.5 h-3.5 shrink-0 ${liked ? "fill-current" : ""}`} />
                    {liked ? "In Your Library" : "Add to Library"}
                  </button>
                </div>
              </div>

              <div className="mt-7 w-full flex justify-center fs-enter fs-d2">
                <LayerVisualizer playing={playing} />
              </div>
            </div>

            {/* RIGHT — the mode switch over the existing lyrics / queue views.
                Idle, the switch fades. (The fade sits on an outer box: the
                entrance's `both` fill would hold the switch's own opacity.) */}
            <div className="flex-1 min-w-0 min-h-0 max-w-[780px] flex flex-col py-1">
              <div className="fs-chrome fs-switch shrink-0 h-10 mb-5">
                <div className="flex justify-center lg:justify-start fs-enter fs-d1">
                  <FsModeSwitch mode={mode} onChange={setMode} />
                </div>
              </div>
              <div className="flex-1 min-h-0 flex flex-col">
                {mode === "lyrics" ? (
                  <FsLyrics artRef={artRef} trackId={track.id} lyrics={lyrics} loading={lyricsLoading} offset={lyricsOffset} />
                ) : (
                  /* The exact queue sheet from the right rail — same data,
                     tabs and actions; its close returns to the lyrics view. */
                  <QueuePanel onClose={() => setMode("lyrics")} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* The existing play bar — the exact component the shell renders,
            unchanged; fullscreen adds nothing to it. No top border: the bar's
            black and the backdrop's near-black floor meet seamlessly. Idle,
            the bar fades as it slides towards the bottom edge. */}
        <div className="fs-chrome fs-dock h-[88px] shrink-0">
          <PlayerBar />
        </div>
      </div>
    </div>
  );
}

/* ============================================================ visualizer */

const VIZ_BARS = 32;

/**
 * The original's ambient visualizer, built so WebKitGTK only composites it: each bar is a layer of
 * its own whose content never changes, and only its scaleY moves (index.css .fs-lviz). The
 * original faded the row's ends with a mask-image, which repaints the whole row every frame; here
 * each bar carries the mask's value at its place as a fixed opacity instead.
 *
 * Measured at 3490x1964: the costliest effect of the Linux room, ~5 fps and roughly twice the
 * dropped frames. A 30 fps <canvas> was tried in its place and cost more (32-46 fps on its own):
 * each redraw repaints the canvas inside the room's layers.
 */
function LayerVisualizer({ playing }: { playing: boolean }) {
  const bars = useMemo(
    () =>
      Array.from({ length: VIZ_BARS }, (_, i) => {
        const r1 = ((i * 137) % 101) / 101;
        const r2 = ((i * 61) % 97) / 97;
        const x = (i + 0.5) / VIZ_BARS; // the bar's place along the row, 0..1
        const edge = Math.min(1, Math.min(x, 1 - x) / 0.18); // the original mask: 0 at the ends, full by 18%
        return {
          dur: `${(2.2 + r1 * 1.6).toFixed(2)}s`,
          delay: `${(-r2 * 3).toFixed(2)}s`,
          rest: (0.12 + r1 * 0.1).toFixed(2),
          fade: edge.toFixed(3),
        };
      }),
    [],
  );
  return (
    <div aria-hidden className={`fs-lviz flex h-9 w-[min(300px,72%)] items-center justify-center gap-[5px] ${playing ? "is-playing" : ""}`}>
      {bars.map((b, i) => (
        <span key={i} className="fs-lviz-bar" style={{ "--dur": b.dur, "--delay": b.delay, "--rest": b.rest, opacity: b.fade } as CSSProperties} />
      ))}
    </div>
  );
}

/** The original full-screen room where full animations are on (lib/fullMotion), else the lighter one. */
export function NowPlaying() {
  return useFullMotion() ? <FullNowPlaying /> : <LiteNowPlaying />;
}
