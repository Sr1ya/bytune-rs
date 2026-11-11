/**
 * Time-synced lyrics — the premium pass.
 *
 * Only a handful of lines are readable at once: the active line is bright
 * and softly glowing, and every line away from it loses opacity progressively
 * and goes out of focus, so the panel reads as depth rather than a list.
 * Word-synced providers get the karaoke sweep; silence gaps render as
 * breathing dots. Click a line to seek there.
 *
 * The store's position updates on `timeupdate` (~4Hz) — too coarse for a
 * word sweep, so the active word-synced line advances off its own rAF loop
 * reading the live element clock.
 *
 * What this view may cost (measured in WebKitGTK at 2x, full screen): it draws on the main thread,
 * so anything that changes every frame is repainted every frame. Three things together held the
 * lyrics at ~12 fps (4-6 fps through a line change) and are gone: CSS masks over the scroller (the
 * whole panel was re-rendered through them on every change), a `filter: blur()` and a scale per
 * line (nine lines repainted and re-blurred per frame at each line change), and a React re-render
 * of the sweep per frame under a drop-shadow filter. What moves now is composited, not repainted:
 * lines fade on layers of their own, the list glides as one transform, the glow and the soft focus
 * are text-shadows painted once, and the sweep writes one word's style a frame.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { getPlaybackPosition } from "../lib/audio";
import { visibleLyricLines } from "../lib/lyricsLines";
import { romanize } from "../lib/romanize";
import { LYRICS_LOADING_LINES, pickLyricsLine } from "../lib/lyricsPhrases";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import type { LyricsResult, SyncedLyricLine, SyncedLyricWord } from "../types";

/** How long the lyrics take to glide to the next line. */
const GLIDE_MS = 600;

interface LyricsViewProps {
  lyrics: LyricsResult | null;
  loading: boolean;
  large?: boolean;
  /** Fullscreen scale — the same treatments as `large`, sized for the
      fullscreen panel's height. Container, spacing and type only. */
  hero?: boolean;
  /** Where the live line's centre rests, as a fraction of the container's
      height (0.5 = dead centre). The fullscreen player measures the album
      cover's centre and passes that fraction, so the live line sits exactly
      beside it; everything else keeps the centred anchor. */
  anchor?: number;
  /** The playing track's id — pins the loading copy to one line per track. */
  trackKey?: string;
}

type LyricsVariant = "compact" | "large" | "hero";

/** Line type scale — `hero` is the fullscreen variant of `large`. */
/** Background vocals and romanized readings: a quieter line under the lyric. */
function subLineClass(variant: LyricsVariant): string {
  switch (variant) {
    case "hero":
      return "font-display text-[clamp(17px,1.9vw,28px)] leading-[1.3] font-bold";
    case "large":
      return "font-display text-[22px] leading-[1.3] font-bold";
    default:
      return "font-display text-[15px] leading-[1.35] font-bold";
  }
}

function lineSizeClass(variant: LyricsVariant): string {
  switch (variant) {
    case "hero":
      return "font-display text-[clamp(28px,3.4vw,54px)] leading-[1.22] tracking-[-0.03em] font-extrabold";
    case "large":
      return "font-display text-[40px] leading-[1.25] tracking-[-0.03em] font-extrabold";
    default:
      return "font-display text-[24px] leading-[1.4] tracking-[-0.02em] font-extrabold";
  }
}

/**
 * Word sweep spans, sanitised into the line's own time window.
 *
 * Providers emit backing-vocal words that start *before* the line activates
 * (they'd light the moment the line does and stay lit for its whole duration)
 * and degenerate zero-length spans (they'd pop fully lit at their start).
 * Both are repaired here: spans that are sane get clamped into the line
 * window, anything else falls back to an even distribution across it.
 */
function resolveWordSpans(
  words: SyncedLyricWord[],
  t0: number,
  t1: number,
): Array<{ start: number; end: number }> {
  const n = words.length || 1;
  const sane =
    words.length > 0 &&
    words.every((w) => w.end > w.start && w.start >= t0 - 0.25 && w.end <= t1 + 0.5);
  if (sane) {
    return words.map((w) => ({
      start: Math.max(t0, w.start),
      end: Math.min(t1, Math.max(w.start + 0.04, w.end)),
    }));
  }
  return words.map((_, i) => ({
    start: t0 + ((t1 - t0) * i) / n,
    end: t0 + ((t1 - t0) * (i + 1)) / n,
  }));
}

/**
 * Karaoke sweep across one line's words. Each frame only the words whose state changed are
 * touched (usually the one being sung): sung and unsung words are plain colours, and the word in
 * flight carries the gradient (.lyric-word rules in index.css). No React render per frame.
 */
function WordLine({
  words,
  spans,
  variant,
  glow,
  offset,
}: {
  words: SyncedLyricWord[];
  spans: Array<{ start: number; end: number }>;
  variant: LyricsVariant;
  glow: boolean;
  offset: number;
}) {
  const playing = usePlayer((st) => st.playing);
  // A seek while paused moves the sweep too.
  const seekNonce = usePlayer((st) => st.seekNonce);
  const wordEls = useRef<Array<HTMLSpanElement | null>>([]);
  useLayoutEffect(() => {
    const painted: string[] = [];
    const paint = (): void => {
      const pos = getPlaybackPosition() - offset;
      for (let i = 0; i < words.length; i++) {
        const node = wordEls.current[i];
        if (!node) continue;
        const span = spans[i] ?? words[i];
        const p = span.end > span.start ? (pos - span.start) / (span.end - span.start) : pos >= span.start ? 1 : 0;
        const state = p <= 0 ? "0" : p >= 1 ? "1" : (p * 100).toFixed(1);
        if (painted[i] === state) continue;
        painted[i] = state;
        node.classList.toggle("is-sung", state === "1");
        node.classList.toggle("is-singing", state !== "0" && state !== "1");
        if (state !== "0" && state !== "1") node.style.setProperty("--p", `${state}%`);
      }
    };
    paint();
    // The sweep only moves while audio is playing; parked at pause, the line holds its last state.
    if (!playing) return;
    let raf = window.requestAnimationFrame(function tick() {
      paint();
      raf = window.requestAnimationFrame(tick);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [playing, seekNonce, words, spans, offset]);
  return (
    <span className={`${lineSizeClass(variant)} ${glow ? "lyric-glow" : ""}`}>
      {words.map((w, i) => (
        <span
          key={i}
          ref={(node) => {
            wordEls.current[i] = node;
          }}
          className="lyric-word"
        >
          {i > 0 ? " " : ""}
          {w.text}
        </span>
      ))}
    </span>
  );
}

/** How far from the live line a line still changes: beyond it every line looks the same. */
const DEPTH_REACH = 6;

/**
 * One line, at its distance from the live one (`depth`: 0 live, negative sung, capped at
 * ±DEPTH_REACH). Memoised on that, so a line change renders the dozen lines around it, not the song.
 *
 * Depth is opacity alone, eased, on lines that ride layers of their own (will-change), so the fade
 * is composited and nothing is repainted. With "Blur unfocused lyrics" the lines out of focus are
 * drawn soft: one softness for all of them, as a text-shadow (.lyric-line.is-soft), painted once
 * when a line leaves or takes the focus. A `filter: blur()` per distance, and a scale per distance,
 * each had every line near the live one repainted on every frame of a line change.
 */
const LyricLine = memo(function LyricLine({
  line,
  nextTime,
  depth,
  roman,
  variant,
  soft,
  glow,
  offset,
  lineRef,
  onSeek,
}: {
  line: SyncedLyricLine;
  nextTime: number | undefined;
  depth: number;
  roman: string | null;
  variant: LyricsVariant;
  soft: boolean;
  glow: boolean;
  offset: number;
  lineRef: React.Ref<HTMLButtonElement> | undefined;
  onSeek: (time: number) => void;
}) {
  const active = depth === 0;
  const d = Math.min(Math.abs(depth), 5);
  // Sung lines sink away a touch harder than upcoming ones. The far ones are nearly gone, which
  // is what lets the panel's edges cut them without a mask.
  const opacity = [1, 0.5, 0.3, 0.18, 0.1, 0.05][d] * (depth < 0 ? 0.7 : 1);
  // The lines whose depth is about to change keep a layer; the rest of the song does not.
  const willChange = Math.abs(depth) < DEPTH_REACH ? "opacity" : undefined;

  // The sweep window is the line's own slice of the song: from its start to
  // the next line (or the last word's end, whichever is sooner). Word spans
  // are sanitised against it before rendering.
  const spans = useMemo(() => {
    const ws = line.words;
    if (!active || !ws?.length) return null;
    let t1 = nextTime ?? line.time + 4;
    const lastEnd = ws[ws.length - 1].end;
    if (lastEnd > line.time) t1 = Math.min(t1, Math.max(lastEnd, line.time + 1));
    if (t1 <= line.time) t1 = line.time + 3;
    return resolveWordSpans(ws, line.time, t1);
  }, [active, line, nextTime]);

  if (line.gap) {
    return (
      <div className="lyric-line flex items-center gap-2 py-2 px-1" title="Instrumental" style={{ opacity: Math.max(0.15, opacity), willChange }}>
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className={`w-1.5 h-1.5 rounded-full bg-ink-hi/80 ${active ? "animate-pulse" : ""}`}
            style={{
              animationDelay: `${dot * 0.22}s`,
              boxShadow: active ? "0 0 12px rgba(255,255,255,0.5)" : undefined,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      ref={lineRef}
      onClick={() => onSeek(line.time)}
      title="Jump here"
      className={`lyric-line block w-full text-left text-ink-hi ${soft && !active ? "is-soft" : ""}`}
      style={{ opacity, willChange }}
    >
      {spans ? (
        <WordLine words={line.words!} spans={spans} variant={variant} glow={glow} offset={offset} />
      ) : (
        <span className={`${lineSizeClass(variant)} ${active && glow ? "lyric-glow-line" : ""}`}>{line.text}</span>
      )}
      {/* Background vocals and a romanized reading follow as quieter lines. */}
      {line.bg && <span className={`block mt-1 opacity-70 ${subLineClass(variant)}`}>{line.bg.text}</span>}
      {roman && <span className={`block mt-1 opacity-60 ${subLineClass(variant)}`}>{roman}</span>}
    </button>
  );
});

export function LyricsView({
  lyrics,
  loading,
  large = false,
  hero = false,
  anchor = 0.5,
  offset = 0,
  trackKey,
}: LyricsViewProps & { offset?: number }) {
  const variant: LyricsVariant = hero ? "hero" : large ? "large" : "compact";
  const seek = usePlayer((s) => s.seek);
  // Click a line to hear it from just before its first word.
  const seekToLine = useCallback((time: number) => seek(Math.max(0, time + offset - 0.15)), [seek, offset]);
  // Appearance switches with defined mobile behavior: synced lyrics gates
  // the whole synced treatment, blur de-emphasis is separately toggled,
  // and the glow yields to reduced motion / reduced blur.
  const syncedOn = useSettings((s) => s.syncedLyrics);
  const blurOn = useSettings((s) => s.blurUnfocusedLyrics);
  const romanOn = useSettings((s) => s.romanizeLyrics);
  const reduceMotion = useSettings((s) => s.reduceAnimation);
  const reduceBlur = useSettings((s) => s.reduceDynamicBlur);
  const blurLines = blurOn && !reduceBlur;
  const glowLines = blurOn && !reduceMotion && !reduceBlur;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The glide in flight (a transform on the list), if any. */
  const glide = useRef<Animation | null>(null);
  const lastIndex = useRef(-1);
  /** The active line changed and no frame has moved the list for it yet. */
  const lineMoved = useRef(false);

  // BitChord mobile's LyricsLoadingLine: the lookup's stand-in is one of the
  // loading phrases — no spinner — picked once per track and held there.
  const loadingPhrase = useMemo(() => pickLyricsLine(LYRICS_LOADING_LINES), [trackKey]);

  const synced = lyrics?.synced ?? null;

  const lines = useMemo(() => (synced ? visibleLyricLines(synced) : null), [synced]);

  // Static text for the plain (unsynced) treatment: the provider's plain
  // lyrics when they exist, otherwise the synced lines' own words joined in
  // order — so switching synced lyrics OFF never blanks the panel on tracks
  // that only shipped synced lines. Gap/instrumental markers carry no words.
  const staticText = useMemo(() => {
    if (lyrics?.plain && lyrics.plain.trim()) return lyrics.plain;
    const fromSynced = (lines ?? [])
      .map((l) => l.text.trim())
      .filter((t) => t.length > 0)
      .join("\n")
      .trim();
    return fromSynced || null;
  }, [lyrics, lines]);

  // Lyric times live on the matched recording's timeline; the playing upload
  // may prepend an intro (music videos). offset converts element position →
  // lyric timeline. Read as the line it lands on, so the ~4Hz position ticks
  // re-render this view only when the line changes.
  const activeIndex = usePlayer((s) => {
    if (!lines) return -1;
    const lyricPos = s.position - offset;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= lyricPos + 0.35) idx = i;
      else break;
    }
    return idx;
  });

  // Romanized readings, worked out once per song rather than on every line change.
  const romans = useMemo(
    () => (romanOn && lines ? lines.map((l) => (l.gap ? null : (l.roman ?? romanize(l.text)))) : null),
    [lines, romanOn],
  );

  // Keep the active line on its anchor. Runs on lyrics load too — at mount
  // the layout isn't measured yet, so the first attempt needs a frame first.
  // `anchor` is the fraction of the container height where the live line's
  // centre comes to rest: 0.5 = centred (default), the fullscreen player
  // passes the album cover's measured centre so the line sits beside it.
  // The move is a glide: an ease-out over GLIDE_MS, restarted from wherever it
  // is when the next line comes. A long jump (a seek, lyrics opening
  // mid-song) lands at once, as does every move under Reduce motion.
  // When only the anchor moved (fullscreen's cover resizing with the window)
  // the line follows at once.
  // The glide never scrolls frame by frame: the scroller jumps to where the
  // line belongs and the list, a layer of its own (.lyrics-lines), plays the
  // distance back as a transform. Scrolling a little every frame repainted the
  // lines each time; a layer's transform is only composited.
  useEffect(() => {
    if (activeIndex < 0) return;
    if (activeIndex !== lastIndex.current) {
      lastIndex.current = activeIndex;
      lineMoved.current = true;
    }
    const raf = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const list = listRef.current;
      const el = activeRef.current;
      if (!container || !list || !el) return;
      // Where the list is drawn right now, off its resting place (a glide in flight).
      const drawnAt = glide.current ? new DOMMatrixReadOnly(getComputedStyle(list).transform).m42 : 0;
      // The line's centre in the scroller's content, measured against the
      // scroller itself (offsetTop counts from whatever positioned box is
      // nearest, which need not be the scroller). The line's own scale keeps
      // its centre, and the glide's offset is taken back out.
      const r = el.getBoundingClientRect();
      const mid = container.scrollTop + r.top - drawnAt - container.getBoundingClientRect().top + r.height / 2;
      const target = Math.max(0, mid - container.clientHeight * anchor);
      const from = container.scrollTop;
      container.scrollTop = target;
      if (!lineMoved.current) return; // only the anchor moved: a glide in flight carries on to the new place
      lineMoved.current = false;
      glide.current?.cancel();
      glide.current = null;
      // What the scroller really moved (it stops at its ends), plus what the last glide still owed.
      const owed = container.scrollTop - from + drawnAt;
      const still =
        document.documentElement.classList.contains("reduce-motion") ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (still || Math.abs(owed) < 0.5 || Math.abs(owed) > container.clientHeight * 1.5) return;
      const anim = list.animate([{ transform: `translateY(${owed}px)` }, { transform: "translateY(0)" }], {
        duration: GLIDE_MS,
        easing: "cubic-bezier(0.25, 1, 0.5, 1)", // ease-out quart
      });
      glide.current = anim;
      const done = (): void => {
        if (glide.current === anim) glide.current = null;
      };
      anim.addEventListener("finish", done);
      anim.addEventListener("cancel", done);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeIndex, synced, anchor]);
  useEffect(() => () => glide.current?.cancel(), []);

  if (loading) {
    // Words, not a spinner — mobile's LyricsLoadingLine, dimmed like an
    // unsung line.
    return (
      <div className="flex justify-center py-12">
        <span
          className={`font-display font-extrabold text-ink-hi/55 animate-pulse ${
            hero
              ? "text-[30px] tracking-[-0.02em]"
              : large
                ? "text-[28px] tracking-[-0.02em]"
                : "text-[18px]"
          }`}
        >
          {loadingPhrase}
        </span>
      </div>
    );
  }

  if (!lyrics || !staticText) {
    return (
      <p
        className={`text-center text-ink-faint ${
          hero ? "py-16 text-lg" : large ? "py-16 text-base" : "py-10 text-sm"
        }`}
      >
        No lyrics available for this track.
      </p>
    );
  }

  if (synced && syncedOn) {
    // Spacers: the scroll target puts the active line's centre at `anchor` ×
    // container height. The bottom spacer lets the last lines reach the
    // anchor too. % heights resolve against the scroller's own (definite,
    // absolute-positioned) height; the −fudge is ~half a line so the line
    // *centre* lands on the anchor. `max(...,12px)` keeps a sane gap if the
    // anchor ever measures near an edge.
    const headFudge = hero ? 36 : large ? 28 : 20;
    // Both panels park the lyric list at the top of the area: a small fixed
    // head spacer (just under the top melt mask's full-opacity line) instead
    // of the anchor pre-centre, and it never changes size — the intro view and
    // the first active line sit at exactly the same height, so singing
    // starting cannot reposition the list. Later lines glide down to the
    // anchor (fullscreen: beside the cover) and stay on it through the normal
    // auto-scroll once their offset outgrows the scroll clamp.
    const topSpacer = "calc(10% + 4px)";
    const bottomSpacer = `max(12px, calc(${(1 - anchor) * 100}% - ${headFudge}px))`;
    return (
      // No edge masks: the lines away from the live one fade by their own opacity (LyricLine), so the
      // panel's edges only ever cut lines that are nearly gone. A mask here re-rendered the whole
      // panel through an offscreen surface on every change.
      <div className="relative flex-1 min-h-0 -mx-6">
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-y-auto scroll-host px-6 py-0"
        >
        <div aria-hidden="true" style={{ height: topSpacer, flexShrink: 0 }} />
        <div
          ref={listRef}
          className={`lyrics-lines ${hero ? "space-y-7" : large ? "space-y-5" : "space-y-4"}`}
          style={{ "--lyric-soft": hero ? "4px" : large ? "3px" : "2px" } as React.CSSProperties}
        >
          {(lines ?? []).map((line, i) => (
            <LyricLine
              key={`${line.time}-${i}`}
              line={line}
              nextTime={lines?.[i + 1]?.time}
              depth={Math.max(-DEPTH_REACH, Math.min(DEPTH_REACH, i - activeIndex))}
              roman={romans?.[i] ?? null}
              variant={variant}
              soft={blurLines}
              glow={glowLines}
              offset={offset}
              lineRef={i === activeIndex ? activeRef : undefined}
              onSeek={seekToLine}
            />
          ))}
          {lyrics?.source && <p className="pt-4 text-[12px] font-medium text-ink-hi/45">Lyrics from {lyrics.source}</p>}
        </div>
        <div aria-hidden="true" style={{ height: bottomSpacer, flexShrink: 0 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <pre
        className={`relative flex-1 min-h-0 overflow-y-auto whitespace-pre-wrap font-sans text-ink-dim ${
          hero ? "h-full text-[17px] leading-8 py-2" : large ? "h-full text-[15px] leading-7 py-2" : "text-[13px] leading-6 py-2"
        }`}
      >
        {staticText}
      </pre>
    </div>
  );
}
