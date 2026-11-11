/**
 * Replay — your listening, pressed on wax. Fed only by what ByTune actually
 * recorded (electron/stats.ts; the last seven days from the listening
 * journal): no fake numbers, and an empty period says so.
 *
 * The page: a hero washed in your top song's cover — your minutes counting
 * up, your top song's record sliding out of your top album's sleeve (it
 * spins while your Replay plays) — then
 * liner notes (your top artist, your hour on the curve of your day), your
 * top songs with the share of listening each took, your top artists (each
 * artist on a shared credit counts), your top albums as a record wall, and
 * your listening waveform with your biggest day. Share draws a story-sized
 * card (lib/replayCard).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Clock3, Copy, Download, Play, Share2, X } from "lucide-react";
import { Artwork, Btn, EmptyState, ErrorState } from "../components/primitives";
import { extractPalette } from "../lib/ambient";
import { upgradeArtwork } from "../lib/artwork";
import { shortTitle } from "../lib/format";
import { FitText } from "../components/FitText";
import { renderReplayCard } from "../lib/replayCard";
import {
  activityDays,
  biggestDay,
  calendarWeeks,
  creditArtists,
  creditNames,
  fmtHours,
  journalReplay,
  isoDay,
  peakHour,
  periodRange,
  streaks,
  vividRgb,
  type CalendarDay,
  type ReplayData,
  type ReplayPeriod,
} from "../lib/replayFormat";
import { peekArtistMeta, resolveArtistMeta } from "../stores/artistMeta";
import { useJournal } from "../stores/journal";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

const PERIODS: { key: ReplayPeriod; label: string }[] = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

/** The sidebar's Replay row: playing your Replay marks it (player.playingFrom). */
const REPLAY_ROW = "__replay__";
const NEUTRAL: [string, string] = ["60 60 64", "40 40 44"];

/** "6 PM" or "18" — whatever this computer's clock format is. */
const hourLabel = (h: number): string => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, opts);

/** What the period covers, in words: "November 2026", "Since Sep 2026". */
function periodLabel(period: ReplayPeriod, data: ReplayData | null, now = new Date()): string {
  const month = (d: Date): string => d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (period === "week") return "The last seven days";
  if (period === "month") return month(now);
  if (period === "lastMonth") return month(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  if (period === "year") return String(now.getFullYear());
  const first = data?.months[0];
  return first ? `Since ${new Date(`${first}-01T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" })}` : "All time";
}

function reducedMotion(): boolean {
  return document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** A number that counts up to its value once it changes (instant under Reduce animation). */
function useCountUp(value: number, ms = 1100): number {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const base = from.current;
    let raf = 0;
    const tick = (t: number): void => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 4);
      setShown(Math.round(base + (value - base) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}

/** A cover's two colours as "R G B", made poster-bright; neutral until (or unless) they're read. */
function useCoverColors(url: string | null | undefined): [string, string] {
  const [colors, setColors] = useState<[string, string]>(NEUTRAL);
  useEffect(() => {
    let alive = true;
    if (!url) {
      setColors(NEUTRAL);
      return;
    }
    void extractPalette(url).then((p) => {
      if (alive && p) setColors([vividRgb(p.primary, 0.5, 0.36), vividRgb(p.secondary, 0.55, 0.48)]);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return colors;
}

/** Whether the catalogue's artist is this very name ("Simon and Garfunkel" = "Simon & Garfunkel"). */
function sameName(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.normalize("NFKC").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) === norm(b);
}

/**
 * Top artists by artist, not by credit line: "Luis Fonsi & Daddy Yankee"
 * counts for both. A line the catalogue knows as one artist ("Mumford &
 * Sons") stays whole: known lines straight from the cache, new ones once
 * their lookup lands.
 */
function useCreditedArtists(lines: ReplayData["artists"] | undefined): ReplayData["artists"] {
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    const unchecked = (lines ?? [])
      .slice(0, 20)
      .filter((a) => creditNames(a.name).length > 1 && peekArtistMeta(a.name)?.name === undefined);
    if (!unchecked.length) return;
    let alive = true;
    void Promise.all(unchecked.map((a) => resolveArtistMeta(a.name, true))).then(() => {
      if (alive) setChecked((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [lines]);
  return useMemo(() => {
    const whole = new Set<string>();
    for (const a of lines ?? []) {
      const found = peekArtistMeta(a.name)?.name;
      if (found && creditNames(a.name).length > 1 && sameName(found, a.name)) whole.add(a.name.trim().toLowerCase());
    }
    return creditArtists(lines ?? [], whole);
    // `checked` re-reads the cache once new lookups land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, checked]);
}

// Kept across visits so Back lands on the same period, drawn at full height
// straight away — the app's scroll restore needs the content already there.
let lastPeriod: ReplayPeriod = "month";
const summaryCache = new Map<ReplayPeriod, ReplayData>();

/** Join key for an album row — the same shape the stats buckets use. */
const albumKey = (al: { name: string; artist?: string }): string => `${al.name.toLowerCase()}|${(al.artist || "unknown artist").toLowerCase()}`;

export function ReplayView() {
  const [period, setPeriodState] = useState<ReplayPeriod>(lastPeriod);
  const setPeriod = (k: ReplayPeriod): void => {
    lastPeriod = k;
    setPeriodState(k);
  };
  const [nonce, setNonce] = useState(0);
  const [stats, setStats] = useState<ReplayData | null>(() => (lastPeriod === "week" ? null : summaryCache.get(lastPeriod) ?? null));
  const [loading, setLoading] = useState(() => lastPeriod !== "week" && !summaryCache.has(lastPeriod));
  const [error, setError] = useState<string | null>(null);
  const [artistThumbs, setArtistThumbs] = useState<Record<string, string>>({});
  const [sharing, setSharing] = useState(false);
  const journal = useJournal((s) => s.entries);
  const playQueue = usePlayer((s) => s.playQueue);
  const { history, liked, playlists } = useLibrary();

  useEffect(() => {
    if (period === "week") {
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const cached = summaryCache.get(period);
    setStats(cached ?? null);
    setLoading(!cached);
    setError(null);
    window.bytune
      ?.statsSummary(period)
      .then((res) => {
        summaryCache.set(period, res as ReplayData);
        if (!cancelled) setStats(res as ReplayData);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, nonce]);

  // Every month on record, for the calendar to step through whichever period is open;
  // read again when music starts or stops, so today shows the moment it counts.
  const [allDays, setAllDays] = useState<ReplayData["days"] | null>(() => summaryCache.get("all")?.days ?? null);
  const listeningNow = usePlayer((s) => s.playing && !s.queue[s.index]?.episode);
  useEffect(() => {
    let alive = true;
    window.bytune
      ?.statsSummary("all")
      .then((res) => {
        summaryCache.set("all", res as ReplayData);
        if (alive) setAllDays((res as ReplayData).days);
      })
      .catch(() => {
        /* no streak band without the record; the rest of Replay still shows */
      });
    return () => {
      alive = false;
    };
  }, [nonce, listeningNow]);

  // The week comes from the journal, so it's always current.
  const data = useMemo(() => (period === "week" ? journalReplay(journal, Date.now()) : stats), [period, journal, stats]);
  const artists = useCreditedArtists(data?.artists);

  // Artist photos come from the (cloud-synced) identity cache; names it
  // doesn't know yet are resolved once and cached for the whole app.
  useEffect(() => {
    let alive = true;
    void Promise.all(
      artists.slice(0, 8).map(async (a) => {
        if (a.thumb || artistThumbs[a.name]) return;
        const meta = await resolveArtistMeta(a.name);
        if (meta?.thumb && alive && !artistThumbs[a.name]) {
          setArtistThumbs((prev) => ({ ...prev, [a.name]: meta.thumb as string }));
        }
      })
    );
    return () => {
      alive = false;
    };
    // artistThumbs intentionally excluded: re-running on our own writes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artists]);

  // Album covers for buckets recorded before Replay stored artwork: the
  // listener's own library already knows what those albums look like.
  //
  // Local-file covers (localart://) point at extracted art on THIS machine —
  // a data reset deletes that folder and a cloud restore can never bring it
  // back, so such a reference is used only after the file is confirmed present.
  const albumCandidates = useMemo(() => {
    const web = new Map<string, string>();
    const local = new Map<string, string>();
    for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
      if (!t.album || !t.thumb) continue;
      const key = albumKey({ name: t.album, artist: t.artist });
      if (/^(https?:\/\/|data:image\/|blob:)/i.test(t.thumb)) {
        if (!web.has(key)) web.set(key, t.thumb);
      } else if (t.thumb.startsWith("localart:") && !local.has(key)) {
        local.set(key, t.thumb);
      }
    }
    return { web, local };
  }, [history, liked, playlists]);

  const [presentCovers, setPresentCovers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void Promise.all(
      data.albums.slice(0, 8).map(async (al) => {
        const key = albumKey(al);
        if (al.thumb || albumCandidates.web.has(key) || presentCovers[key]) return;
        const candidate = albumCandidates.local.get(key);
        if (!candidate) return;
        try {
          const art = await window.bytune?.localArtBytes(candidate);
          if (alive && art?.length) setPresentCovers((prev) => ({ ...prev, [key]: candidate }));
        } catch {
          /* the extracted cover is gone — keep the placeholder */
        }
      })
    );
    return () => {
      alive = false;
    };
    // presentCovers is a cache this pass fills; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, albumCandidates]);

  const albumThumb = (al: ReplayData["albums"][number]): string => {
    const key = albumKey(al);
    return al.thumb || albumCandidates.web.get(key) || presentCovers[key] || "";
  };
  const artistThumb = (a: ReplayData["artists"][number]): string => a.thumb || artistThumbs[a.name] || "";

  // Top artists and albums open their pages; with no id to go on, a search.
  const searchFor = (q: string): void => {
    useUI.getState().setSearchQuery(q);
    useUI.getState().navigate({ name: "search" });
  };
  const openArtist = async (name: string): Promise<void> => {
    const meta = await resolveArtistMeta(name);
    if (meta?.id) useUI.getState().navigate({ name: "artist", param: meta.id });
    else searchFor(name);
  };
  const albumIds = useMemo(() => {
    const ids = new Map<string, string>();
    for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
      const key = t.album && t.albumId ? albumKey({ name: t.album, artist: t.artist }) : null;
      if (key && !ids.has(key)) ids.set(key, t.albumId as string);
    }
    return ids;
  }, [history, liked, playlists]);
  const openAlbum = (al: ReplayData["albums"][number]): void => {
    const id = albumIds.get(albumKey(al));
    if (id) useUI.getState().navigate({ name: "album", param: id });
    else searchFor(`${al.name} ${al.artist ?? ""}`.trim());
  };

  // Songs as the player plays them: the library's full copy where it has one (length, album, local file).
  const known = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of [...playlists.flatMap((p) => p.tracks), ...liked, ...history]) m.set(t.id, t);
    for (const e of journal) if (!m.has(e.track.id)) m.set(e.track.id, e.track);
    return m;
  }, [history, liked, playlists, journal]);
  const topTracks: Track[] = useMemo(
    () => (data?.tracks ?? []).slice(0, 50).map((t) => known.get(t.id) ?? { id: t.id, title: t.title, artist: t.artist, thumb: t.thumb, duration: 0 }),
    [data, known]
  );
  const playReplay = (from = 0): void => {
    if (topTracks.length) playQueue(topTracks, from, REPLAY_ROW);
  };

  const topSong = data?.tracks[0];
  const topAlbum = data?.albums[0];
  const colors = useCoverColors(topSong?.thumb);
  const label = periodLabel(period, data);

  if (error) {
    return <ErrorState title="Replay didn't load" body="Give it another try." onRetry={() => setNonce((n) => n + 1)} />;
  }

  const hasData = !!data && data.totalMs > 0;

  return (
    <div className="rp-page space-y-10 pb-6">
      <div className="flex items-end justify-between gap-6 flex-wrap animate-slide-up">
        <div>
          <h1 className="font-display text-[44px] font-extrabold tracking-[-0.035em] text-ink-hi leading-none">Replay</h1>
          <p className="text-[14px] text-ink-dim mt-2">{label}</p>
        </div>
        <PeriodSwitch value={period} onChange={setPeriod} />
      </div>

      {loading && <div className="skeleton h-[340px] rounded-[26px]" />}

      {!loading && !hasData && (
        <EmptyState
          icon={Clock3}
          title="Nothing on this record yet"
          body={
            period === "week"
              ? "Your week fills in as you listen — every song you play from now on counts here."
              : "Play something first — Replay fills in as ByTune counts what you actually listen to."
          }
        />
      )}

      {!loading && hasData && data && (
        // Keyed by period: each period arrives fresh, its record sliding out again.
        <div key={period} className="space-y-12">
          <Hero
            data={data}
            colors={colors}
            sleeve={topAlbum ? albumThumb(topAlbum) || null : null}
            label={topSong?.thumb || null}
            onPlay={() => playReplay(0)}
            onShare={() => setSharing(true)}
          />
          <LinerNotes data={data} artists={artists} artistThumb={artistThumb} onOpenArtist={(n) => void openArtist(n)} />
          <TopSongs data={data} tracks={topTracks} colors={colors} onPlay={playReplay} />
          <TopArtists artists={artists} artistThumb={artistThumb} onOpen={(n) => void openArtist(n)} />
          {data.albums.length > 0 && <TopAlbums data={data} albumThumb={albumThumb} onOpen={openAlbum} />}
          <Pattern data={data} period={period} allDays={allDays} artists={artists} artistThumb={artistThumb} albumThumb={albumThumb} />
          <p className="text-[12.5px] text-ink-faint">Counted by ByTune on this device — nothing estimated.</p>
        </div>
      )}

      {sharing && hasData && data && (
        <ShareSheet
          onClose={() => setSharing(false)}
          fileName={`ByTune Replay — ${label}`}
          make={() => {
            const days = activityDays(period, data.days);
            const run = streaks(period === "all" || period === "year" ? data.days : days);
            return renderReplayCard({
              periodLabel: label,
              minutes: Math.round(data.totalMs / 60000),
              plays: data.plays,
              activeDays: run.active,
              streak: run.longest,
              songs: data.tracks.slice(0, 5).map((t) => ({ title: shortTitle(t.title), artist: t.artist, thumb: t.thumb })),
              artists: artists.slice(0, 5).map((a) => ({ name: a.name, thumb: artistThumb(a), detail: fmtHours(a.ms) })),
              sleeve: topAlbum ? albumThumb(topAlbum) || null : null,
              label: topSong?.thumb || null,
              colors,
            });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ period switch */

function PeriodSwitch({ value, onChange }: { value: ReplayPeriod; onChange: (k: ReplayPeriod) => void }) {
  const refs = useRef<Partial<Record<ReplayPeriod, HTMLButtonElement | null>>>({});
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current[value];
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value]);
  return (
    <div className="rp-seg" role="tablist" aria-label="Replay period">
      {thumb && <span className="rp-seg-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} aria-hidden />}
      {PERIODS.map((p) => (
        <button
          key={p.key}
          ref={(el) => {
            refs.current[p.key] = el;
          }}
          role="tab"
          aria-selected={p.key === value}
          onClick={() => onChange(p.key)}
          className={p.key === value ? "text-black" : "text-ink-dim hover:text-ink-hi"}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- hero */

function Hero({
  data,
  colors,
  sleeve,
  label,
  onPlay,
  onShare,
}: {
  data: ReplayData;
  colors: [string, string];
  sleeve: string | null;
  label: string | null;
  onPlay: () => void;
  onShare: () => void;
}) {
  const minutes = useCountUp(Math.round(data.totalMs / 60000));
  const spinning = usePlayer((s) => s.playing && s.playingFrom === REPLAY_ROW);
  const run = streaks(data.days);
  const style = { "--rp-a": colors[0], "--rp-b": colors[1] } as CSSProperties;
  return (
    <section className="rp-hero animate-slide-up" style={style}>
      <div className="rp-hero-main">
        <div className="rp-words">
          <div className="rp-eyebrow">Minutes listened</div>
          <div className="rp-minutes font-display">{minutes.toLocaleString()}</div>
          <p className="mt-4 text-[15px] text-white/85">
            {data.plays.toLocaleString()} {data.plays === 1 ? "play" : "plays"} · {run.active} {run.active === 1 ? "day" : "days"} of listening
          </p>
          <div className="mt-7 flex gap-2.5">
            <Btn variant="white" icon={Play} onClick={onPlay}>
              Play your Replay
            </Btn>
            <Btn variant="glass" icon={Share2} onClick={onShare}>
              Share
            </Btn>
          </div>
        </div>
        <div className={`rp-art ${sleeve ? "" : "is-alone"} ${spinning ? "is-spinning" : ""}`} aria-hidden>
          {label && (
            <img
              className="rp-wash"
              src={upgradeArtwork(label)}
              alt=""
              draggable={false}
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
          {sleeve && (
            <span className="rp-sleeve">
              <img src={sleeve} alt="" draggable={false} />
            </span>
          )}
          <span className="rp-record">
            <span className="rp-disc">
              {label && (
                <span className="rp-label">
                  <img src={upgradeArtwork(label)} alt="" draggable={false} />
                </span>
              )}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- liner notes */

/** The hour card's colour: the sky at that time of day (night, morning, afternoon, evening, late). */
const skyAt = (h: number): string =>
  h < 5 ? "84 80 214" : h < 11 ? "38 158 168" : h < 17 ? "58 132 226" : h < 21 ? "222 84 124" : "104 78 206";

function LinerNotes({
  data,
  artists,
  artistThumb,
  onOpenArtist,
}: {
  data: ReplayData;
  artists: ReplayData["artists"];
  artistThumb: (a: ReplayData["artists"][number]) => string;
  onOpenArtist: (name: string) => void;
}) {
  const artist = artists[0];
  const photo = artist ? artistThumb(artist) : "";
  const [artistColor] = useCoverColors(photo || undefined);
  const hour = peakHour(data.hours);
  const total = data.hours.reduce((sum, ms) => sum + ms, 0);
  return (
    <div className="rp-cards">
      {artist && (
        <button
          className={`rp-card animate-slide-up ${photo ? "rp-card-photo" : ""}`}
          style={{ "--c": artistColor, animationDelay: "60ms" } as CSSProperties}
          onClick={() => onOpenArtist(artist.name)}
        >
          {photo && <img className="rp-card-glow" src={upgradeArtwork(photo)} alt="" draggable={false} aria-hidden />}
          <div className="rp-eyebrow">Top artist</div>
          <div className="mt-auto flex items-center gap-4 pt-5">
            <Artwork src={photo} className="w-[108px] h-[108px] shrink-0 shadow-float" rounded="rounded-full" iconClassName="w-6 h-6" alt="" />
            <div className="min-w-0">
              <FitText lines={2} text={artist.name} className="font-display text-[24px] font-extrabold tracking-[-0.02em] text-white leading-[1.2]" />
              <div className="text-[13.5px] text-white/75 mt-1.5">
                {fmtHours(artist.ms)} · {artist.plays.toLocaleString()} {artist.plays === 1 ? "play" : "plays"}
              </div>
            </div>
          </div>
        </button>
      )}
      {hour !== null && (
        <div className="rp-card animate-slide-up" style={{ "--c": skyAt(hour), animationDelay: "120ms" } as CSSProperties}>
          <div className="rp-eyebrow">Your hour</div>
          <div className="font-display text-[30px] font-extrabold tracking-[-0.02em] text-white mt-3 leading-none">{hourLabel(hour)}</div>
          <div className="text-[13.5px] text-white/75 mt-2">
            {Math.max(1, Math.round((data.hours[hour] / Math.max(1, total)) * 100))}% of all your listening
          </div>
          <DayCurve hours={data.hours} peak={hour} />
        </div>
      )}
    </div>
  );
}

/**
 * A smooth line through points evenly spaced in x that never overshoots them
 * (Steffen's monotone cubic), so it can't dip below zero or peak anywhere
 * but a real hour.
 */
function monotonePath(pts: readonly (readonly [number, number])[], low: number, high: number): string {
  const n = pts.length;
  const h = pts[1][0] - pts[0][0];
  const s = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / h);
  const m = pts.map((_, i) =>
    i === 0 ? s[0] : i === n - 1 ? s[n - 2] : (Math.sign(s[i - 1]) + Math.sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), Math.abs(s[i - 1] + s[i]) / 4)
  );
  // The end tangents are one-sided; holding the handles inside the chart keeps the ends in it too.
  const y = (v: number): number => Math.min(high, Math.max(low, v));
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    d += `C${x0 + h / 3},${y(y0 + (m[i] * h) / 3)} ${x1 - h / 3},${y(y1 - (m[i + 1] * h) / 3)} ${x1},${y1}`;
  }
  return d;
}

/** Your day, midnight to midnight: how much you listen in each hour as one line, your hour pinned on it. */
function DayCurve({ hours, peak }: { hours: number[]; peak: number }) {
  const W = 240;
  const H = 64;
  const max = Math.max(1, ...hours);
  const pts = hours.map((ms, h) => [((h + 0.5) / 24) * W, H - 1 - (ms / max) * (H - 9)] as const);
  const line = `M0,${pts[0][1]}L${monotonePath(pts, 1, H - 1).slice(1)}L${W},${pts[23][1]}`;
  const at = { left: `${((peak + 0.5) / 24) * 100}%`, top: `${(pts[peak][1] / H) * 100}%` };
  return (
    <div className="mt-auto pt-5" aria-hidden>
      <div className="rp-curve">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="rp-curve-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line}L${W},${H}L0,${H}Z`} fill="url(#rp-curve-fill)" />
          <path d={line} fill="none" stroke="rgb(255 255 255 / 0.9)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="rp-curve-drop" style={at} />
        <span className="rp-curve-pin" style={at} />
      </div>
      <div className="relative mt-2 h-4 text-[11px] text-white/55 tabular-nums">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} className="absolute top-0 -translate-x-1/2 whitespace-nowrap first:translate-x-0" style={{ left: h ? `${((h + 0.5) / 24) * 100}%` : 0 }}>
            {hourLabel(h)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- top songs */

function TopSongs({
  data,
  tracks,
  colors,
  onPlay,
}: {
  data: ReplayData;
  tracks: Track[];
  colors: [string, string];
  onPlay: (i: number) => void;
}) {
  const rows = data.tracks.slice(0, 10);
  const top = Math.max(1, rows[0]?.ms ?? 1);
  const playingId = usePlayer((s) => (s.playing ? s.queue[s.index]?.id ?? null : null));
  const style = { "--rp-a": colors[0], "--rp-b": colors[1] } as CSSProperties;
  return (
    <section className="animate-slide-up" style={style}>
      <h2 className="section-title text-[24px] mb-4">Top songs</h2>
      <ol className="rp-songs">
        {rows.map((t, i) => (
          <li key={t.id}>
            <button
              onClick={() => onPlay(i)}
              className="fit-host group w-full grid grid-cols-[40px_52px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-ink-hi/[0.05]"
            >
              <span className={`font-display text-[22px] font-extrabold tabular-nums text-right ${i === 0 ? "text-ink-hi" : "text-ink-faint"}`}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <Artwork src={tracks[i]?.thumb ?? t.thumb} className="w-[52px] h-[52px] rounded-lg" iconClassName="w-4 h-4" alt="" />
              <span className="min-w-0">
                <FitText
                  text={shortTitle(t.title)}
                  full={t.title}
                  className={`text-[14.5px] font-semibold ${playingId === t.id ? "text-accent" : "text-ink-hi"}`}
                />
                <FitText text={t.artist} className="text-[13px] text-ink-dim" />
                <span className="rp-meter mt-2 block" aria-hidden>
                  <i style={{ width: `${Math.max(4, (t.ms / top) * 100)}%`, animationDelay: `${150 + i * 50}ms` }} />
                </span>
              </span>
              <span className="text-right text-[12.5px] text-ink-faint tabular-nums leading-relaxed">
                {fmtHours(t.ms)}
                <br />
                {t.plays.toLocaleString()} {t.plays === 1 ? "play" : "plays"}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------- top artists */

function TopArtists({
  artists,
  artistThumb,
  onOpen,
}: {
  artists: ReplayData["artists"];
  artistThumb: (a: ReplayData["artists"][number]) => string;
  onOpen: (name: string) => void;
}) {
  // Full rows only: eight (two rows of four), else four.
  const rows = artists.slice(0, artists.length >= 8 ? 8 : 4);
  if (!rows.length) return null;
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[24px] mb-5">Top artists</h2>
      <ol className="rp-artists" style={{ "--n": Math.max(4, rows.length) } as CSSProperties}>
        {rows.map((a, i) => (
          <li key={a.name} className="min-w-0">
            <button onClick={() => onOpen(a.name)} className="group flex w-full flex-col items-center text-center">
              <span className="relative block w-full max-w-[176px]">
                <Artwork
                  src={artistThumb(a)}
                  className="aspect-square w-full shadow-float transition-transform duration-300 group-hover:scale-[1.04]"
                  rounded="rounded-full"
                  iconClassName="w-7 h-7"
                  alt=""
                />
                <span
                  className={`absolute left-0 top-0 grid h-9 min-w-9 place-items-center rounded-full px-2 font-display text-[15px] font-extrabold shadow-elev ${
                    i === 0 ? "bg-white text-black" : "bg-[#1c1c1f] text-ink-hi"
                  }`}
                >
                  {i + 1}
                </span>
              </span>
              <FitText lines={2} text={a.name} className="mt-3 w-full text-[14.5px] font-semibold leading-snug text-ink-hi" />
              <span className="mt-0.5 text-[12.5px] text-ink-faint">{fmtHours(a.ms)}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------- top albums */

function TopAlbums({
  data,
  albumThumb,
  onOpen,
}: {
  data: ReplayData;
  albumThumb: (al: ReplayData["albums"][number]) => string;
  onOpen: (al: ReplayData["albums"][number]) => void;
}) {
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[24px] mb-5">Top albums</h2>
      <div className="rw rp-albums">
        {data.albums.slice(0, 8).map((al, i) => {
          const thumb = albumThumb(al);
          return (
            <button key={`${al.name}-${i}`} className="rw-item fit-host" onClick={() => onOpen(al)}>
              <span className="rw-art" aria-hidden>
                <span className="rw-disc">
                  <span className="rw-label">{thumb && <img src={thumb} alt="" draggable={false} />}</span>
                </span>
                {thumb ? <img className="rw-sleeve" src={thumb} alt="" draggable={false} /> : <span className="rw-sleeve bg-ink-hi/[0.06]" />}
              </span>
              <span className="mt-3 flex gap-1.5 text-[14px] font-semibold leading-snug text-ink-hi">
                <span className="shrink-0 text-ink-faint tabular-nums">{i + 1}</span>
                <FitText lines={2} text={shortTitle(al.name)} full={al.name} className="min-w-0" />
              </span>
              <FitText text={`${al.artist ? `${al.artist} · ` : ""}${fmtHours(al.ms)}`} className="text-[13px] text-ink-dim" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- pattern */

/** This computer's first day of the week (0 Sunday … 6 Saturday); Monday when it can't say. */
function firstWeekday(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    return (loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
}

/** A count over a small pile of what it counts: covers, faces, sleeves. */
function CountTile({ value, label, pile, round }: { value: number; label: string; pile: string[]; round?: boolean }) {
  const n = useCountUp(value);
  return (
    <div className="rp-count">
      {pile.length > 0 && (
        <span className="rp-pile" aria-hidden>
          {pile.map((src, i) => (
            <Artwork key={`${i}-${src}`} src={src} className="rp-pile-item" rounded={round ? "rounded-full" : "rounded-[7px]"} iconClassName="w-3 h-3" alt="" />
          ))}
        </span>
      )}
      <div className="mt-4 font-display text-[36px] font-extrabold leading-none tracking-[-0.03em] text-ink-hi tabular-nums">{n.toLocaleString()}</div>
      <div className="mt-1.5 text-[13px] text-ink-dim">{label}</div>
    </div>
  );
}

/** "Mon, Nov 2 · 41 min" — a calendar day's hover tip. */
const dayTip = (d: { date: string; ms: number }): string =>
  `${dayLabel(d.date, { weekday: "short", month: "short", day: "numeric" })} · ${!d.ms ? "no music" : d.ms < 60_000 ? "under a minute" : fmtHours(d.ms)}`;

/**
 * Your listening: how many songs, artists and albums the period held, each
 * over a pile of its own art, then its days as a calendar, brighter where
 * you listened more and your biggest day ringed. The week, this month and
 * last month open on their month and step back through every month on
 * record (the words beside it follow the month shown); the year and all time
 * show a grid of weeks — the year, or the last twelve months.
 */
function Pattern({
  data,
  period,
  allDays,
  artists,
  artistThumb,
  albumThumb,
}: {
  data: ReplayData;
  period: ReplayPeriod;
  allDays: ReplayData["days"] | null;
  artists: ReplayData["artists"];
  artistThumb: (a: ReplayData["artists"][number]) => string;
  albumThumb: (al: ReplayData["albums"][number]) => string;
}) {
  const now = new Date();
  const today = isoDay(now);
  const firstDay = useMemo(firstWeekday, []);
  const wide = period === "year" || period === "all";
  // The month calendar: months back from this one, starting on the period's own.
  const [back, setBack] = useState(period === "lastMonth" ? 1 : 0);
  const month = new Date(now.getFullYear(), now.getMonth() - back, 1, 12);
  const onRecord = allDays ?? data.days;
  const firstHeard = onRecord.reduce((min, d) => (d.ms > 0 && d.date < min ? d.date : min), today);
  const canBack = isoDay(month).slice(0, 7) > firstHeard.slice(0, 7);
  const range = wide ? periodRange(period, now) : { from: isoDay(month), to: isoDay(new Date(month.getFullYear(), month.getMonth() + 1, 0, 12)) };
  const weeks = calendarWeeks(range.from, range.to, wide ? data.days : onRecord, today, firstDay);
  const past = weeks.flat().filter((d): d is NonNullable<CalendarDay> => !!d && !d.ahead);
  // All time's grid is its last twelve months; its biggest day is still all time's.
  const best = biggestDay(period === "all" ? data.days : past);
  const max = Math.max(1, ...past.map((d) => d.ms));
  const level = (d: NonNullable<CalendarDay>): string => (d.ahead ? "rp-lvx" : `rp-lv${d.ms > 0 ? Math.min(4, Math.ceil((d.ms / max) * 4)) : 0}`);
  const active = past.filter((d) => d.ms > 0).length;
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(2026, 10, 1 + ((firstDay + i) % 7), 12).toLocaleDateString(undefined, { weekday: "narrow" })
  );
  // A grid of weeks names each month above the week it starts in.
  const months = wide
    ? weeks.flatMap((w, wi) => {
        const first = w.find((d) => d && (d.date.endsWith("-01") || wi === 0));
        return first ? [{ wi, label: new Date(`${first.date}T12:00:00`).toLocaleDateString(undefined, { month: "short" }) }] : [];
      })
    : [];
  if (months.length > 1 && months[1].wi - months[0].wi < 3) months.shift();

  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[24px] mb-4">Your listening</h2>
      <div className="rp-counts">
        <CountTile value={data.counts?.tracks ?? data.tracks.length} label="different songs" pile={data.tracks.slice(0, 5).map((t) => t.thumb).filter(Boolean)} />
        <CountTile value={data.counts?.artists ?? artists.length} label="artists" pile={artists.slice(0, 5).map(artistThumb).filter(Boolean)} round />
        <CountTile value={data.counts?.albums ?? data.albums.length} label="albums" pile={data.albums.slice(0, 5).map(albumThumb).filter(Boolean)} />
      </div>

      <div className={`rp-days ${wide ? "is-wide" : ""}`}>
        <div className="rp-days-text">
          {best && (
            <>
              <div className="text-[13px] text-ink-dim">Your biggest day</div>
              <div className="mt-1 text-[20px] font-bold leading-snug tracking-[-0.01em] text-ink-hi">
                {dayLabel(best.date, { weekday: "long", month: "long", day: "numeric" })}
              </div>
              <div className="mt-0.5 text-[14px] text-ink-dim">{fmtHours(best.ms)} of music</div>
            </>
          )}
          <div className={`${best ? "mt-5" : ""} text-[13px] text-ink-dim`}>
            <span className="font-semibold text-ink-hi tabular-nums">{active}</span> of {past.length} days with music
          </div>
          <div className="rp-legend" aria-hidden>
            Less
            {[0, 1, 2, 3, 4].map((l) => (
              <i key={l} className={`rp-lv${l}`} />
            ))}
            More
          </div>
        </div>

        {wide ? (
          <div className="rp-yr" style={{ "--weeks": weeks.length } as CSSProperties} aria-hidden>
            <div className="rp-yr-months">
              {months.map((m) => (
                <span key={m.wi} style={{ gridColumn: `${m.wi + 1} / span 4` }}>
                  {m.label}
                </span>
              ))}
            </div>
            <div className="rp-yr-grid">
              {weeks.map((w, wi) =>
                w.map((d, di) => {
                  const place = { gridColumn: wi + 1, gridRow: di + 1, "--i": wi } as CSSProperties;
                  if (!d) return <span key={`${wi}-${di}`} style={place} />;
                  const tip = d.ahead ? undefined : dayTip(d);
                  return (
                    <span
                      key={d.date}
                      className={`rp-yr-day ${level(d)} ${tip ? "rp-tip" : ""} ${d.date === best?.date ? "is-best" : ""}`}
                      data-tip={tip}
                      data-side={wi < 4 ? "start" : wi > weeks.length - 5 ? "end" : undefined}
                      style={place}
                    />
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div className="rp-cal-wrap">
            <div className="rp-cal-nav">
              <button onClick={() => setBack(back + 1)} disabled={!canBack} title="Previous month" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span aria-live="polite">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
              <button onClick={() => setBack(back - 1)} disabled={back === 0} title="Next month" aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="rp-cal" aria-hidden>
              {weekdays.map((w, i) => (
                <span key={`h${i}`} className="rp-cal-head">
                  {w}
                </span>
              ))}
              {weeks.flat().map((d, i) => {
                if (!d) return <span key={`g${i}`} />;
                const tip = d.ahead ? undefined : dayTip(d);
                const col = i % 7;
                return (
                  <span
                    key={d.date}
                    className={`rp-cal-day ${level(d)} ${tip ? "rp-tip" : ""} ${d.date === best?.date ? "is-best" : ""}`}
                    data-tip={tip}
                    data-side={col < 2 ? "start" : col > 4 ? "end" : undefined}
                    style={{ "--i": i } as CSSProperties}
                  >
                    {Number(d.date.slice(8))}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- share sheet */

function ShareSheet({ make, fileName, onClose }: { make: () => Promise<Blob>; fileName: string; onClose: () => void }) {
  const [card, setCard] = useState<{ url: string; bytes: Uint8Array } | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useUI((s) => s.toast);
  const makeRef = useRef(make);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    void makeRef
      .current()
      .then(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        url = URL.createObjectURL(blob);
        if (alive) setCard({ url, bytes });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const copy = async (): Promise<void> => {
    if (!card) return;
    try {
      await window.bytune?.copyReplayImage(card.bytes);
      setCopied(true);
      toast("Copied — paste it into a story or a chat");
    } catch {
      toast("Couldn't copy the card", "error");
    }
  };
  const save = async (): Promise<void> => {
    if (!card) return;
    try {
      const res = await window.bytune?.saveReplayImage(card.bytes, fileName);
      if (res?.path) toast("Saved your Replay card");
    } catch {
      toast("Couldn't save the card", "error");
    }
  };

  // On the page root, like the app's other overlays: inside the page, the window frame would offset it.
  return createPortal(
    <div className="rp-share-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Share your Replay">
      <div className="rp-share">
        <div className="rp-share-preview">
          {card ? <img src={card.url} alt="Your Replay card" /> : failed ? null : <div className="skeleton h-full w-full" />}
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ink-hi leading-tight">Share your Replay</h2>
            <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-dim hover:bg-ink-hi/[0.08] hover:text-ink-hi" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-[14px] text-ink-dim mt-2 leading-relaxed">
            Your minutes, your top songs and artists, and your top song's record — one card, sized for a story.
          </p>
          {failed && <p className="text-[13.5px] text-red-300 mt-4">The card couldn't be drawn. Close this and try again.</p>}
          <div className="mt-7 flex flex-col gap-2.5">
            <Btn variant="white" icon={copied ? Check : Copy} onClick={() => void copy()} disabled={!card}>
              {copied ? "Copied" : "Copy image"}
            </Btn>
            <Btn variant="glass" icon={Download} onClick={() => void save()} disabled={!card}>
              Save image
            </Btn>
          </div>
          <p className="mt-auto pt-6 text-[12.5px] text-ink-faint leading-relaxed">
            A 1080 × 1920 picture, sized for a story. Copy it into a chat, or save it and post it from your phone.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}
