/**
 * PipApp — ByTune's native desktop miniplayer (PiP), rendered in its own
 * always-on-top BrowserWindow (`?window=pip`).
 *
 * Hybrid of Spotify's MiniPlayer (measured via CDP against the real app,
 * 330×342 viewport at 200% scale) and ByTune's own player treatments:
 *
 *   top bar 26px, auto-hides unless the window is hovered/focused — 6-dot
 *   grip centred, minimize and close X (12px marks in 20px hit boxes,
 *   centred 35 / 15px from the right edge, vertically centred);
 *   artwork fills the card edge-to-edge (object-cover) inside a 4px frame
 *   (5px along the top on Windows — see TOP_INSET),
 *   sliding down beneath the dropped bar (21px on Windows, 22 elsewhere) —
 *   transform only, the cover never re-crops (ByTune's original presentation);
 *   the card's background is the artwork's dominant colour (visible while
 *   the cover loads), blending 0.5s linear between tracks;
 *   seek (10px grey times + slider over a rise that is solid black at the
 *   bottom, fading to transparent via black/70) shows on hover
 *   only, pinned above the metadata bar;
 *   hover overlay (the card's rect): linear-gradient(rgba(18,18,18,.53) →
 *   #0a0a0a), opacity 0.3s cubic-bezier(0,0,0.5,1), transport row centred —
 *   mute (+ horizontal #282828 volume pill 96px wide, radius 12, on hover), shuffle, prev,
 *   PLAY (48px white circle, black icon, in a 56×48 button), next, repeat,
 *   copy-link — 32px buttons, 16px icons, #b3b3b3, the row zoomed with the
 *   window size (--pip-s);
 *   48px metadata bar: ByTune's own 15px/12px title+artist treatment (the
 *   title opens its album, the artist their page, in the main window) and
 *   the original 32px like button with its like-burst celebration, floated
 *   10px above the bottom edge;
 *   resize grip 9×9 (0.5 strokes) 4px from the corner;
 *   the whole artwork area is the native drag surface (buttons carve
 *   no-drag) — exactly Spotify's fixed drag layer.
 *
 * The top bar's fold button switches to the compact bar (PR #10's design, by
 * bevinkatti), a fixed 320×110 window (pip.ts): the cover, the title (its
 * album) and artist (their page), like, previous, play and next; the cover's
 * own blurred glow behind, a 3px seek strip along the bottom, and its unfold
 * button, minimize and close top right.
 *
 * Playback is NOT here. This window holds no audio: it renders snapshots
 * pushed from the main window (pip:state) and sends transport commands back
 * (pip:command). Closing it never touches playback.
 *
 * Hover mechanics: pointer events stop over the app-region drag surface, so
 * visibility is driven by the main process's native cursor watch
 * ("pip:cursor-inside") + keyboard focus — never by per-element listeners.
 * The cover is a drag handle like the rest of that surface: a click on it
 * moves the window, it never plays or pauses.
 */
import { useEffect, useRef, useState, type ReactNode, type FocusEvent } from "react";
import { FoldVertical, Loader2, UnfoldVertical } from "lucide-react";
import {
  SpCheck,
  SpCoverNote,
  SpNext,
  SpPause,
  SpPlay,
  SpPlus,
  SpPrev,
  SpRepeat,
  SpRepeatOne,
  SpShuffle,
  SpVolumeHigh,
  SpVolumeOff,
} from "../components/SpotifyIcons";
import { fmtTime, shortTitle } from "../lib/format";
import { FitText } from "../components/FitText";
import { upgradeArtwork } from "../lib/artwork";
import { isWindows } from "../lib/platform";
import type { PipCommand, PipSnapshot } from "./types";

const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragRegion = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** Spotify MiniPlayer geometry (logical px, CDP-measured). */
const TOP_BAR_H = 26; // dropdown top bar
const INSET = 4; // frame gap around the artwork card (left/right)
/** Windows' frameless window border overlaps the client's first pixel row,
 *  which renders the collapsed top frame a device pixel thinner than the
 *  sides — on Windows the top runs 1px larger so all three read equal. */
const TOP_INSET = isWindows ? INSET + 1 : INSET;
/** The overlay card's width at the default window size — the controls row's zoom is 1 there. */
const CARD_W = 343;
const GRADIENT = "linear-gradient(rgba(18, 18, 18, 0.53) 0%, rgb(10, 10, 10) 100%)";
/** The bar's shade over its cover glow: the glow shows behind the cover, the
    text and buttons sit on dark (a flat tint would turn warm covers brown). */
const BAR_SHADE = "linear-gradient(90deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.55) 40%, rgba(0,0,0,0.82) 100%)";
/** Shorter than this, the window is the compact bar: pip.ts makes it 320×110,
    and the square miniplayer can't be dragged below 233px. */
const BAR_MAX_H = 175;

/** like-burst confetti — flight target (--tx/--ty), spin (--rot), size and
    shade of each square in the Spotify-style "added" celebration */
const LIKE_CONFETTI = [
  { size: 4, color: "#1ed760", tx: -3, ty: -17, rot: 95, delay: 0 },
  { size: 3, color: "#9af0b4", tx: 7, ty: -15, rot: -60, delay: 20 },
  { size: 3, color: "#169c46", tx: 15, ty: -7, rot: 140, delay: 10 },
  { size: 4, color: "#1ed760", tx: 18, ty: 3, rot: -110, delay: 30 },
  { size: 3, color: "#b7f5c4", tx: 13, ty: 12, rot: 70, delay: 0 },
  { size: 3, color: "#169c46", tx: 2, ty: 17, rot: -150, delay: 25 },
  { size: 4, color: "#1ed760", tx: -10, ty: 14, rot: 120, delay: 15 },
  { size: 3, color: "#9af0b4", tx: -17, ty: 5, rot: -90, delay: 35 },
  { size: 3, color: "#1ed760", tx: -18, ty: -6, rot: 60, delay: 20 },
  { size: 3, color: "#169c46", tx: -11, ty: -14, rot: -45, delay: 0 },
];

/** Copy-link glyph — Spotify's exact filled tray-arrow (16px grid). */
function SpCopyLink({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M1 5.75A.75.75 0 0 1 1.75 5H4v1.5H2.5v8h11v-8H12V5h2.25a.75.75 0 0 1 .75.75v9.5a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75z" />
      <path d="M8 9.576a.75.75 0 0 0 .75-.75V2.903l1.454 1.454a.75.75 0 0 0 1.06-1.06L8 .03 4.735 3.296a.75.75 0 0 0 1.06 1.061L7.25 2.903v5.923c0 .414.336.75.75.75" />
    </svg>
  );
}

/** 6-dot drag grip — Spotify's exact 4×2 dot field (24px grid). */
function SpGrip({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M6 13a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m4 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m4 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m4 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2" />
    </svg>
  );
}

/** Close X — Spotify's exact 16px-grid cross. */
function SpClose({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06" />
    </svg>
  );
}

function send(command: PipCommand): void {
  window.bytune?.pipSendCommand(command);
}

function IconBtn({
  onClick,
  active,
  title,
  disabled,
  children,
  className = "h-8 w-8",
}: {
  onClick?: () => void;
  active?: boolean;
  title: string;
  disabled?: boolean;
  children: ReactNode;
  /** the hit box's size: 32px in the square layout, smaller in the bar */
  className?: string;
}) {
  return (
    <button
      type="button"
      style={noDragRegion}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`relative grid ${className} shrink-0 cursor-pointer place-items-center rounded-full transition-all duration-150 hover:bg-white/10 active:scale-90 disabled:pointer-events-none disabled:opacity-40 ${
        active ? "text-white" : "text-white/90 hover:text-white"
      } focus-visible:text-white`}
    >
      {children}
      {/* Spotify's selected treatment: the icon keeps its normal colour and a
          small dot appears beneath it — no colour change. */}
      {active && (
        <span className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white" />
      )}
    </button>
  );
}

/** A track is sharable when its id is a YouTube video id (`local:…` file ids have no song link). */
function sharableId(id: string | null | undefined): boolean {
  return !!id && !id.includes(":") && !id.includes("/") && !id.includes("\\");
}

export function PipApp() {
  const [snap, setSnap] = useState<PipSnapshot | null>(null);
  /** native cursor watch (main process): true while the OS pointer is over
      the PiP window. Pointer events stop over the drag surface, so the main
      process arbitrates inside/outside — Spotify's model exactly. */
  const [cursorInside, setCursorInside] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const [volOpen, setVolOpen] = useState(false);
  const volTimer = useRef<number | null>(null);
  /** Spotify-style like-burst overlay (set when adding, self-clears) */
  const [likeBurst, setLikeBurst] = useState(false);
  const likeBurstTimer = useRef<number | null>(null);
  /** The seek thumb's own value. While it's held the drag is purely visual:
      snapshots pushed from the main window must not fight the thumb mid-drag,
      and the seek command is sent once, on release. Once sent, the thumb
      stays where it was dropped until a snapshot shows the seek landed, so it
      never flashes back to the old spot. */
  const [seek, setSeek] = useState<{ v: number; sent: boolean } | null>(null);
  const seekRef = useRef(seek);
  seekRef.current = seek;
  /** "Link copied" feedback on the copy-link button */
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  /** dominant colour of the current artwork — the card's loading backdrop */
  const [ambient, setAmbient] = useState("#282828");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  /** the compact bar (the window's height says, as pip.ts sized it) or the square */
  const [bar, setBar] = useState(() => window.innerHeight < BAR_MAX_H);
  useEffect(() => {
    const onResize = (): void => setBar(window.innerHeight < BAR_MAX_H);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const off = window.bytune?.onPipState((s) => setSnap(s as PipSnapshot));
    return off;
  }, []);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  /* The main window's playback shortcuts, while the PiP window is focused:
     Space play/pause, ←/→ 5s back/forward (Shift: previous/next song), ↑/↓
     volume, M mute, S shuffle, R repeat. The engine lives in the main window,
     so they route over the command channel. A focused slider keeps its own
     arrow keys, and only the plain arrows repeat while held. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const arrow = e.code.startsWith("Arrow");
      if (arrow && e.target instanceof HTMLInputElement) return;
      if (e.repeat && (!arrow || e.shiftKey)) return;
      const s = snapRef.current;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          send({ type: "toggle" });
          break;
        case "ArrowRight":
          if (e.shiftKey) send({ type: "next" });
          else if (s) send({ type: "seek", sec: s.position + 5 });
          break;
        case "ArrowLeft":
          if (e.shiftKey) send({ type: "prev" });
          else if (s) send({ type: "seek", sec: Math.max(0, s.position - 5) });
          break;
        case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          if (s) send({ type: "volume", v: s.volume + (e.code === "ArrowUp" ? 0.05 : -0.05) });
          break;
        case "KeyM":
          send({ type: "mute" });
          break;
        case "KeyS":
          send({ type: "shuffle" });
          break;
        case "KeyR":
          send({ type: "repeat" });
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* The transport row zooms with the window (--pip-s, 1 at the default size):
     a small window keeps every button inside the card, a big one grows them
     (capped), and a short one keeps the row and its volume pill inside the
     overlay. Written straight to the DOM — no re-render churn mid-resize. */
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    const ro = new ResizeObserver(() => {
      const s = Math.min(1.3, (zone.clientWidth - 2 * INSET) / CARD_W, (zone.clientHeight - TOP_BAR_H) / 120);
      zone.style.setProperty("--pip-s", s.toFixed(3));
    });
    ro.observe(zone);
    return () => ro.disconnect();
    // Again whenever the square layout (and with it the zone) comes back from the bar.
  }, [bar]);

  /* The OS window's corners are rounded by the OS itself; the shell stays
     square and black so shell, corner squares and window edge all read as
     one solid black panel (Spotify does the same). */
  useEffect(() => {
    document.documentElement.style.background = "#000";
    document.body.style.background = "#000";
  }, []);

  useEffect(() => {
    const off = window.bytune?.onPipCursorInside((inside) => setCursorInside(inside));
    return off;
  }, []);

  // A new track resets any in-progress visual drag.
  const track = snap?.track ?? null;
  const trackId = track?.id ?? null;
  const thumb = track?.thumb ? upgradeArtwork(track.thumb) : "";
  useEffect(() => setSeek(null), [trackId]);

  /* Dominant artwork colour for the card's backdrop (visible while the cover
     loads): 48px canvas readback, 4-bit/channel quantisation, best bucket by
     count weighted toward saturation. Cross-origin readback can fail (file
     thumbs) — the previous neutral stays. */
  useEffect(() => {
    if (!thumb) {
      setAmbient("#282828");
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const c = document.createElement("canvas");
        c.width = 48;
        c.height = 48;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 48, 48);
        const data = ctx.getImageData(0, 0, 48, 48).data;
        const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          e.n++;
          e.r += r;
          e.g += g;
          e.b += b;
          buckets.set(key, e);
        }
        let best: { n: number; r: number; g: number; b: number } | null = null;
        let bestScore = -1;
        for (const e of buckets.values()) {
          const mx = Math.max(e.r, e.g, e.b) / e.n;
          const mn = Math.min(e.r, e.g, e.b) / e.n;
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          const score = e.n * (0.3 + sat);
          if (score > bestScore) {
            bestScore = score;
            best = e;
          }
        }
        if (!best || best.n === 0) return;
        setAmbient(`rgb(${Math.round(best.r / best.n)},${Math.round(best.g / best.n)},${Math.round(best.b / best.n)})`);
      } catch {
        /* tainted canvas — keep the current ambient */
      }
    };
    img.src = thumb;
    return () => {
      cancelled = true;
    };
  }, [thumb]);

  useEffect(
    () => () => {
      if (volTimer.current !== null) window.clearTimeout(volTimer.current);
      if (likeBurstTimer.current !== null) window.clearTimeout(likeBurstTimer.current);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  /** Spotify shows bar + transport whenever the cursor is over the window
      (native watch) or the window holds keyboard focus. */
  const expanded = cursorInside || focusWithin;
  const playing = snap?.playing ?? false;
  const buffering = snap?.buffering ?? false;
  const duration = snap?.duration ?? 0;
  const position = Math.min(snap?.position ?? 0, duration > 0 ? duration : Infinity);
  const max = duration > 0 ? duration : 1;
  const shownSeek = Math.min(seek?.v ?? position, max);
  /* Sent once per drag or key adjustment: on a key let go, on blur, or on a
     release anywhere in the window — a drag whose pointer the window loses
     mid-way (focus stolen, say) never gets its release on the slider, and
     would otherwise sit unsent with the time frozen. Reads refs only, so the
     window listener's first copy serves for good. */
  const commitSeek = (): void => {
    const s = seekRef.current;
    if (!s || s.sent) return;
    seekRef.current = { v: s.v, sent: true };
    send({ type: "seek", sec: s.v });
    setSeek(seekRef.current);
  };
  useEffect(() => {
    window.addEventListener("pointerup", commitSeek);
    return () => window.removeEventListener("pointerup", commitSeek);
  }, []);
  // A dropped thumb lets go once a snapshot puts playback next to it — or
  // after 1.5s, should the seek never land.
  useEffect(() => {
    if (seek?.sent && Math.abs(position - seek.v) < 1.5) setSeek(null);
  }, [seek, position]);
  useEffect(() => {
    if (!seek?.sent) return;
    const t = window.setTimeout(() => setSeek(null), 1500);
    return () => window.clearTimeout(t);
  }, [seek]);
  const canShare = sharableId(track?.id ?? null);

  // Keyboard focus holds the controls up; the focus a mouse click leaves on a
  // button doesn't, so they still hide once the cursor leaves the window.
  const onCardFocus = (e: FocusEvent<HTMLDivElement>): void => setFocusWithin((e.target as Element).matches(":focus-visible"));
  const onCardBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
  };

  /* volume popover: one hover/focus region with a short linger on exit */
  const openVol = (): void => {
    if (volTimer.current !== null) {
      window.clearTimeout(volTimer.current);
      volTimer.current = null;
    }
    setVolOpen(true);
  };
  const scheduleVolClose = (): void => {
    if (volTimer.current !== null) window.clearTimeout(volTimer.current);
    volTimer.current = window.setTimeout(() => {
      volTimer.current = null;
      setVolOpen(false);
    }, 180);
  };

  /* copy the song link (clipboard API with a textarea fallback); the button
     shows a check and "Link copied" for a moment once it worked */
  const copyShareLink = async (): Promise<void> => {
    if (!track || !canShare) return;
    const url = `https://music.youtube.com/watch?v=${track.id}`;
    let ok = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false; // clipboard unavailable
      }
    }
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  /* Title → its album, artist → their page, in the main window (brought
     forward); with nothing playing, a click just brings ByTune forward. */
  const openInMain = (to: "album" | "artist"): void => {
    window.bytune?.pipShowMain();
    if (track) send({ type: "open", to });
  };

  /* The like button (the metadata bar's, and the bar's): a green check once
     liked. Liking, not unliking, plays the Spotify-style "added" burst. */
  const toggleLike = (): void => {
    if (!snap?.liked && !likeBurst) {
      setLikeBurst(true);
      if (likeBurstTimer.current !== null) window.clearTimeout(likeBurstTimer.current);
      likeBurstTimer.current = window.setTimeout(() => setLikeBurst(false), 900);
    }
    send({ type: "like" });
  };
  const likeButton = (box: string, icon: string): ReactNode =>
    track && (
      <button
        type="button"
        style={noDragRegion}
        onClick={toggleLike}
        title={snap?.liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
        aria-label={snap?.liked ? "Remove from Liked Songs" : "Save to Liked Songs"}
        aria-pressed={snap?.liked}
        className={`relative grid ${box} shrink-0 cursor-pointer place-items-center rounded-full transition-transform duration-150 hover:scale-105 active:scale-90`}
      >
        <span key={snap?.liked ? "liked" : "unliked"} className="icon-swap">
          {snap?.liked ? (
            <SpCheck className={`${icon} text-[#1ed760]`} />
          ) : (
            <SpPlus className={`${icon} text-white/70 hover:text-white`} />
          )}
        </span>
        {/* like-burst overlay — green check disc + expanding ring + green
            confetti squares; purely visual (pointer-transparent) */}
        {likeBurst && (
          <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-0 w-0">
            {LIKE_CONFETTI.map((p, i) => (
              <span
                key={i}
                className="absolute block"
                style={
                  {
                    width: p.size,
                    height: p.size,
                    left: -p.size / 2,
                    top: -p.size / 2,
                    background: p.color,
                    animation: `pip-like-confetti 700ms ease-out ${p.delay}ms both`,
                    "--tx": `${p.tx}px`,
                    "--ty": `${p.ty}px`,
                    "--rot": `${p.rot}deg`,
                  } as React.CSSProperties
                }
              />
            ))}
            <span
              className="absolute block rounded-full border-2 border-[#1d7a3c]"
              style={{ width: 28, height: 28, left: -14, top: -14, animation: "pip-like-ring 800ms ease-out both" }}
            />
            <span
              className="absolute grid place-items-center rounded-full bg-[#1ed760]"
              style={{ width: 27, height: 27, left: -13.5, top: -13.5, animation: "pip-like-pop 850ms ease-out both" }}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="#000" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5.5 12.5l4.4 4.4L18.5 8.3" />
              </svg>
            </span>
          </span>
        )}
      </button>
    );

  /* The bar's seek strip: press, drag, let go. The same held thumb as the
     square layout's slider (seek / commitSeek), so it never jumps back. */
  const onStripPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!track) return;
    e.preventDefault();
    const strip = e.currentTarget;
    strip.setPointerCapture(e.pointerId);
    const hold = (clientX: number): void => {
      const r = strip.getBoundingClientRect();
      seekRef.current = { v: Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * max, sent: false };
      setSeek(seekRef.current);
    };
    const move = (ev: PointerEvent): void => hold(ev.clientX);
    const up = (ev: PointerEvent): void => {
      strip.removeEventListener("pointermove", move);
      strip.removeEventListener("pointerup", up);
      hold(ev.clientX);
      commitSeek();
    };
    hold(e.clientX);
    strip.addEventListener("pointermove", move);
    strip.addEventListener("pointerup", up);
  };

  const reveal = (extra = ""): string =>
    `${extra} transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
      expanded ? "opacity-100" : "pointer-events-none opacity-0"
    }`;

  return (
    <div
      ref={rootRef}
      onFocus={onCardFocus}
      onBlur={onCardBlur}
      onPointerEnter={() => setCursorInside(true)}
      onContextMenu={(e) => e.preventDefault()}
      className="pip-root animate-pip-in fixed inset-0 flex select-none flex-col overflow-hidden bg-black text-white"
    >
      {bar ? (
        <>
          {/* ------------------------- the bar (short windows) ------------------------- */}
          {/* Native drag surface: the whole bar, the cover included (a click on
              it moves the window, as in the square layout). Controls carve no-drag. */}
          <div aria-hidden className="absolute inset-0" style={dragRegion} />
          {/* The cover's glow: the cover itself blurred behind the bar, BAR_SHADE
              darkening the text side. The dominant colour shows while it loads. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ backgroundColor: ambient }}>
            {thumb && (
              <img
                key={trackId ?? "none"}
                src={thumb}
                alt=""
                draggable={false}
                className="animate-art-in absolute inset-0 h-full w-full scale-125 object-cover opacity-80 blur-2xl saturate-150"
              />
            )}
            <div className="absolute inset-0" style={{ background: BAR_SHADE }} />
          </div>

          <div className="relative flex min-h-0 flex-1 items-center gap-2.5 px-2 pb-[3px]">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-[#181818] shadow-[0_2px_10px_rgba(0,0,0,0.5)]">
              {thumb ? (
                <img key={trackId ?? "none"} src={thumb} alt="" draggable={false} className="animate-art-in h-full w-full object-cover" />
              ) : (
                <div key={trackId ?? "none"} className="animate-art-in grid h-full w-full place-items-center">
                  <SpCoverNote className="h-1/2 w-1/2 text-white/25" />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1" style={noDragRegion}>
              <button
                key={trackId ?? "t"}
                type="button"
                onClick={() => openInMain("album")}
                title={track ? "Go to album" : "Open ByTune"}
                className={`animate-meta-in block w-full min-w-0 cursor-pointer text-left text-[13px] font-semibold leading-[1.35] text-white ${
                  track ? "hover:underline" : ""
                }`}
              >
                <FitText mode="auto" text={track ? shortTitle(track.title) : "Nothing playing"} full={track?.title} />
              </button>
              <button
                key={trackId ? `${trackId}-a` : "a"}
                type="button"
                onClick={() => openInMain("artist")}
                title={track ? "Go to artist" : "Open ByTune"}
                className={`animate-meta-in block w-full min-w-0 cursor-pointer text-left text-[11px] leading-[1.4] text-white/60 ${
                  track ? "hover:text-white hover:underline" : ""
                }`}
              >
                <FitText mode="auto" text={track ? track.artist : ""} />
              </button>
            </div>

            {likeButton("h-7 w-7", "h-4 w-4")}

            <div className="flex shrink-0 items-center gap-0.5" style={noDragRegion}>
              <IconBtn className="h-7 w-7" onClick={() => send({ type: "prev" })} title="Previous" disabled={!track}>
                <SpPrev className="h-4 w-4" />
              </IconBtn>
              <button
                type="button"
                style={noDragRegion}
                onClick={() => send({ type: "toggle" })}
                disabled={!track}
                title={playing ? "Pause" : "Play"}
                aria-label={playing ? "Pause" : "Play"}
                className="mx-0.5 grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full bg-white text-black shadow-[0_2px_8px_rgba(0,0,0,0.4)] transition-transform duration-150 hover:scale-[1.06] active:scale-95 focus-visible:scale-[1.06] disabled:pointer-events-none disabled:opacity-40"
              >
                {buffering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span key={playing ? "pause" : "play"} className="icon-swap">
                    {playing ? <SpPause className="h-4 w-4" /> : <SpPlay className="ml-0.5 h-4 w-4" />}
                  </span>
                )}
              </button>
              <IconBtn className="h-7 w-7" onClick={() => send({ type: "next" })} title="Next" disabled={!track}>
                <SpNext className="h-4 w-4" />
              </IconBtn>
            </div>
          </div>

          {/* The seek strip along the bottom: press or drag anywhere on it. The
              keyboard seeks with Left/Right, as in the square layout. */}
          <div
            aria-hidden
            style={noDragRegion}
            onPointerDown={onStripPointerDown}
            title={duration > 0 ? `${fmtTime(shownSeek)} / ${fmtTime(duration)}` : undefined}
            className="group/seek absolute inset-x-0 bottom-0 z-20 h-[3px] cursor-pointer bg-white/15 transition-[height] duration-150 hover:h-[6px]"
          >
            <div className="relative h-full bg-white" style={{ width: `${Math.min(100, Math.max(0, (shownSeek / max) * 100))}%` }}>
              <span className="absolute right-0 top-1/2 h-2 w-2 -translate-y-1/2 translate-x-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover/seek:opacity-100" />
            </div>
          </div>

          {/* Back to the full miniplayer, minimize and close, top right: faint
              until the cursor is over the window. */}
          <div
            className={`absolute right-1.5 top-1.5 z-30 flex items-center gap-1 transition-opacity duration-150 ${expanded ? "opacity-100" : "opacity-40"}`}
            style={noDragRegion}
          >
            <button
              type="button"
              onClick={() => window.bytune?.pipSetCompact(false)}
              title="Full miniplayer"
              aria-label="Full miniplayer"
              className="grid h-4 w-4 cursor-pointer place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white active:scale-95"
            >
              <UnfoldVertical className="h-3 w-3" strokeWidth={2.25} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => window.bytune?.pipMinimize()}
              title="Minimize miniplayer"
              aria-label="Minimize miniplayer"
              className="grid h-4 w-4 cursor-pointer place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white active:scale-95"
            >
              <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3.27 8h9.46" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => window.bytune?.pipClose()}
              title="Close miniplayer"
              aria-label="Close miniplayer"
              className="grid h-4 w-4 cursor-pointer place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white active:scale-95"
            >
              <SpClose className="h-2.5 w-2.5" />
            </button>
          </div>
        </>
      ) : (
        <>
          {/* ------------------------- upper player zone ------------------------- */}
          {/* Everything above the metadata bar. Native drag surface first: the
              whole area drags the window exactly like Spotify's fixed drag layer
              — interactive elements carve no-drag. Pointer events never fire
              over the drag surface; visibility runs off the native cursor
              watch + focus (see `expanded`). overflow-hidden clips the bar's
              hidden state above the window and the cover's tucked bottom. */}
          <div ref={zoneRef} className="relative min-h-0 flex-1 overflow-hidden">
            <div aria-hidden className="absolute inset-0" style={dragRegion} />

            {/* the cover — fills the card edge-to-edge and slides beneath the
                dropped bar, TOP_BAR_H − TOP_INSET (transform only: the image keeps its exact
                rendered size, never re-crops; the tucked bottom clips at the
                zone edge). The layer must NOT carry app-regions: drag carve-outs
                inside a transformed subtree are placed wrong by Chromium, so
                every app-region lives outside this layer. */}
            <div
              className={`absolute left-[4px] right-[4px] overflow-hidden rounded-[8px] transition-transform ${
                expanded ? "duration-200 ease-out" : "duration-[250ms] ease-in"
              }`}
              style={{
                top: TOP_INSET,
                height: `calc(100% - ${TOP_INSET}px)`,
                transform: expanded ? `translateY(${TOP_BAR_H - TOP_INSET}px)` : "translateY(0px)",
                backgroundColor: ambient,
              }}
            >
              {thumb ? (
                <img
                  key={trackId ?? "none"}
                  src={thumb}
                  alt=""
                  draggable={false}
                  className="animate-art-in h-full w-full object-cover"
                />
              ) : (
                <div key={trackId ?? "none"} className="animate-art-in grid h-full w-full place-items-center">
                  <SpCoverNote className="h-12 w-12 text-white/25" />
                </div>
              )}
            </div>

            {/* hover transport overlay — Spotify's gradient over the card.
                Sits at the card's EXPANDED geometry (fixed, untransformed) so
                its no-drag carve-outs track real layout. */}
            <div
              aria-hidden={!expanded}
              className={`absolute bottom-0 left-[4px] right-[4px] rounded-[8px] transition-opacity duration-300 ease-[cubic-bezier(0,0,0.5,1)] ${
                expanded ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
              style={{ top: TOP_BAR_H, backgroundImage: GRADIENT }}
            >
              <div className={`absolute inset-0 flex items-center justify-center ${reveal()}`}>
                <div className="pip-controls flex items-center justify-center gap-[2px] px-1">
                  {/* volume + vertical popover — one hover region, bridged */}
                  <div
                    className="relative"
                    onMouseEnter={openVol}
                    onMouseLeave={scheduleVolClose}
                    onFocus={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) openVol();
                    }}
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleVolClose();
                    }}
                  >
                    {/* No active marking: the glyph itself swaps to the muted
                        speaker, the way Spotify communicates mute. */}
                    <IconBtn onClick={() => send({ type: "mute" })} title={snap?.muted ? "Unmute" : "Mute"}>
                      <span key={snap?.muted ? "off" : "on"} className="icon-swap">
                        {snap?.muted ? <SpVolumeOff /> : <SpVolumeHigh />}
                      </span>
                    </IconBtn>
                    {/* git-version hover design: horizontal pill, left-anchored
                        so it never clips the card edge; pb-2 bridges the pointer
                        gap while crossing button → slider. The no-drag carve-out
                        keeps the slider clickable over the drag surface. */}
                    <div
                      className={`absolute bottom-full left-0 pb-2 transition-all duration-150 ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
                        volOpen && expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
                      }`}
                      style={noDragRegion}
                    >
                      <div className="w-[96px] rounded-xl bg-[#282828] px-2.5 py-2 shadow-elev">
                        <input
                          type="range"
                          aria-label="Volume"
                          min={0}
                          max={1}
                          step={0.01}
                          value={snap?.muted ? 0 : snap?.volume ?? 0.8}
                          onChange={(e) => send({ type: "volume", v: Number(e.target.value) })}
                          className="slider mp-slider w-full"
                          style={{ "--fill": `${Math.round((snap?.muted ? 0 : (snap?.volume ?? 0.8)) * 100)}%` } as React.CSSProperties}
                        />
                      </div>
                    </div>
                  </div>
                  <IconBtn onClick={() => send({ type: "shuffle" })} active={snap?.shuffle} title="Shuffle" disabled={!track}>
                    <SpShuffle />
                  </IconBtn>
                  <IconBtn onClick={() => send({ type: "prev" })} title="Previous" disabled={!track}>
                    <SpPrev />
                  </IconBtn>
                  <button
                    type="button"
                    style={noDragRegion}
                    onClick={() => send({ type: "toggle" })}
                    disabled={!track}
                    title={playing ? "Pause" : "Play"}
                    aria-label={playing ? "Pause" : "Play"}
                    className="mx-1.5 grid h-12 w-12 cursor-pointer shrink-0 place-items-center rounded-full bg-white text-black shadow-[0_4px_16px_rgba(0,0,0,0.45)] transition-transform duration-150 hover:scale-[1.06] active:scale-95 focus-visible:scale-[1.06] disabled:pointer-events-none disabled:opacity-40"
                  >
                    {buffering ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <span key={playing ? "pause" : "play"} className="icon-swap">
                        {playing ? <SpPause className="h-5 w-5" /> : <SpPlay className="ml-0.5 h-5 w-5" />}
                      </span>
                    )}
                  </button>
                  <IconBtn onClick={() => send({ type: "next" })} title="Next" disabled={!track}>
                    <SpNext />
                  </IconBtn>
                  <IconBtn
                    onClick={() => send({ type: "repeat" })}
                    active={snap?.repeat !== "off"}
                    title={snap?.repeat === "one" ? "Repeat one" : "Repeat"}
                    disabled={!track}
                  >
                    {snap?.repeat === "one" ? <SpRepeatOne /> : <SpRepeat />}
                  </IconBtn>
                  <IconBtn onClick={() => void copyShareLink()} disabled={!canShare} title={copied ? "Link copied" : "Copy link to Song"}>
                    <span key={copied ? "copied" : "copy"} className="icon-swap">
                      {copied ? (
                        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 8.5l3.2 3.2L13 4.8" />
                        </svg>
                      ) : (
                        <SpCopyLink className="h-4 w-4" />
                      )}
                    </span>
                  </IconBtn>
                </div>
              </div>
            </div>

            {/* seek — hover only, pinned above the metadata bar (old treatment):
                10px grey times flanking the slider over a rise that is solid
                black at the bottom (artwork must not bleed through) fading to
                transparent via black/70 */}
            <div
              className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black via-black/70 to-transparent px-3 pb-2 pt-5 ${reveal()}`}
              style={noDragRegion}
              aria-hidden={!expanded}
            >
              <div className="flex items-center gap-2">
                <span className="w-7 shrink-0 text-right text-[10px] tabular-nums leading-none text-white/70">
                  {fmtTime(shownSeek)}
                </span>
                {/* No step, and a millisecond-rounded value: the browser keeps
                    exactly the value React writes. A stepped slider rounded the
                    live position, and React read that rounding as an edit — the
                    slider's own release event then re-armed the old position as a
                    fresh drag, freezing the time and seeking back on the next blur. */}
                <input
                  type="range"
                  aria-label="Seek"
                  className="slider mp-slider min-w-0 flex-1"
                  min={0}
                  max={max}
                  step="any"
                  value={Math.round(shownSeek * 1000) / 1000}
                  disabled={!track}
                  onChange={(e) => setSeek({ v: Number(e.target.value), sent: false })}
                  onKeyUp={commitSeek}
                  onBlur={commitSeek}
                  style={{ "--fill": `${Math.min(100, (shownSeek / max) * 100)}%` } as React.CSSProperties}
                />
                <span className="w-7 shrink-0 text-[10px] tabular-nums leading-none text-white/70">
                  {fmtTime(duration)}
                </span>
              </div>
            </div>

            {/* top bar — 26px, drops when the cursor is over the window / the
                window is focused; sits 1px down so it laps the cover's top edge
                instead of meeting it flush. The close button carves no-drag out
                of the drag surface. */}
            <div className="absolute inset-x-0 top-[1px] z-20 h-[26px]">
              <div
                className={`relative flex h-full w-full items-center justify-center bg-black transition-[transform,opacity] ${
                  expanded ? "translate-y-0 opacity-100 duration-200 ease-out" : "pointer-events-none -translate-y-full opacity-0 duration-[250ms] ease-in"
                }`}
              >
                <SpGrip className="h-6 w-6 text-[#b3b3b3]" />
                {/* 20px hit boxes around the 12px marks — same look, easier to hit */}
                <button
                  type="button"
                  style={noDragRegion}
                  onClick={() => window.bytune?.pipSetCompact(true)}
                  title="Compact player"
                  aria-label="Compact player"
                  className="group absolute right-[45px] top-[3px] grid h-5 w-5 cursor-pointer place-items-center rounded-full text-white active:scale-95"
                >
                  <span className="grid h-3 w-3 place-items-center rounded-full transition-colors duration-150 group-hover:bg-white/10">
                    <FoldVertical className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  </span>
                </button>
                <button
                  type="button"
                  style={noDragRegion}
                  onClick={() => window.bytune?.pipMinimize()}
                  title="Minimize miniplayer"
                  aria-label="Minimize miniplayer"
                  className="group absolute right-[25px] top-[3px] grid h-5 w-5 cursor-pointer place-items-center rounded-full text-white active:scale-95"
                >
                  <span className="grid h-3 w-3 place-items-center rounded-full transition-colors duration-150 group-hover:bg-white/10">
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      {/* span matches one X stick's tip-to-tip reach (2.47→13.53
                          incl. round caps) so the minus reads as wide as the X */}
                      <path d="M3.27 8h9.46" />
                    </svg>
                  </span>
                </button>
                <button
                  type="button"
                  style={noDragRegion}
                  onClick={() => window.bytune?.pipClose()}
                  title="Close miniplayer"
                  aria-label="Close miniplayer"
                  className="group absolute right-[5px] top-[3px] grid h-5 w-5 cursor-pointer place-items-center rounded-full text-white active:scale-95"
                >
                  <span className="grid h-3 w-3 place-items-center rounded-full transition-colors duration-150 group-hover:bg-white/10">
                    <SpClose className="h-3.5 w-3.5" />
                  </span>
                </button>
              </div>
            </div>
          </div>

          {/* ------------------------- metadata bar ------------------------- */}
          {/* floats a 10px gap above the bottom edge instead of sitting flush */}
          <div className="relative z-10 mx-2 mb-[10px] flex h-12 shrink-0 items-center gap-1">
            <div className="min-w-0 flex-1">
              <button
                key={trackId ?? "t"}
                type="button"
                onClick={() => openInMain("album")}
                title={track ? "Go to album" : "Open ByTune"}
                className={`animate-meta-in block w-full min-w-0 cursor-pointer text-left text-[15px] font-semibold leading-[1.35] text-white ${
                  track ? "hover:underline" : ""
                }`}
              >
                <FitText mode="auto" text={track ? shortTitle(track.title) : "Nothing playing"} full={track?.title} />
              </button>
              <button
                key={trackId ? `${trackId}-a` : "a"}
                type="button"
                onClick={() => openInMain("artist")}
                title={track ? "Go to artist" : "Open ByTune"}
                className={`animate-meta-in block w-full min-w-0 cursor-pointer text-left text-[12px] leading-[1.4] text-white/60 ${
                  track ? "hover:text-white hover:underline" : ""
                }`}
              >
                <FitText mode="auto" text={track ? track.artist : ""} />
              </button>
            </div>

            {likeButton("h-8 w-8", "h-[18px] w-[18px]")}
          </div>

          {/* resize grip — Spotify's 9×9 double-line mark, 4px from the corner.
              Purely visual: frameless resizing is the window's native edges. */}
          <div aria-hidden className="pointer-events-none absolute bottom-[4px] right-[4px] text-[#b3b3b3]">
            <svg viewBox="0 0 9 9" width="9" height="9" fill="none">
              <line x1="0.823223" y1="8.82322" x2="8.82322" y2="0.823223" stroke="currentColor" strokeWidth="0.5" />
              <line x1="4.82322" y1="8.82322" x2="8.82322" y2="4.82322" stroke="currentColor" strokeWidth="0.5" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
