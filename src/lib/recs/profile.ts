/**
 * Taste profile — the signals layer of the Home recommendation engine.
 *
 * Everything here is computed from REAL user data only:
 *   - listening stats from the main process (per-artist/per-track play
 *     counts, listening time, last-played timestamps, hour-of-day totals)
 *   - liked tracks, listening history and user playlists (renderer store)
 *   - recent search terms
 *   - skip tallies (stores/listening, fed by the audio engine)
 *   - the listening journal (stores/journal): how each recent listen ended,
 *     the fast-moving "lately" half of taste (lib/recs/taste)
 *   - "Not interested" marks from Home (stores/homeEngagement)
 *
 * The output is a ranked artist-affinity list (plus who you're into lately,
 * what's in heavy rotation and which old favourites to dust off) and a
 * maturity tier, with a cheap `signature` the feed uses to decide when a
 * rebuild is warranted. Nothing is random: scores are deterministic
 * functions of the data, and the only seed is the day bucket (so the feed
 * rotates daily, not per view).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReplaySummary } from "../../shared/backend-types";
import { peekArtistMeta } from "../../stores/artistMeta";
import { useHomeEngagement } from "../../stores/homeEngagement";
import { useJournal } from "../../stores/journal";
import { useLibrary, type Playlist } from "../../stores/library";
import { useListening, type SkipEntry } from "../../stores/listening";
import { usePlayer } from "../../stores/player";
import { useRecents } from "../../stores/recents";
import { useUI } from "../../stores/ui";
import type { Track } from "../../types";
import { dayBucket } from "./seeded";
import {
  DAY_MS,
  backToBack,
  dustOff as pickDustOff,
  fade,
  fadedCount,
  heavyRotation as pickHeavyRotation,
  latelyByArtist,
  type JournalEntry,
  type Rotation,
} from "./taste";

/* ------------------------------------------------------------- stats i/o */

export type { ReplaySummary };

const STATS_TTL_MS = 60_000;
const STATS_REFRESH_MS = 120_000;

function emptySummary(period: ReplaySummary["period"]): ReplaySummary {
  return {
    totalMs: 0,
    plays: 0,
    tracks: [],
    artists: [],
    albums: [],
    hours: new Array(24).fill(0),
    days: [],
    period,
    months: [],
    counts: { tracks: 0, artists: 0, albums: 0 },
  };
}

interface StatsPair {
  all: ReplaySummary;
  month: ReplaySummary;
  at: number;
}

let statsCache: StatsPair | null = null;
let statsInflight: Promise<StatsPair> | null = null;

async function loadStats(force = false): Promise<StatsPair> {
  if (!force && statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache;
  if (!statsInflight) {
    statsInflight = (async () => {
      try {
        const [all, month] = await Promise.all([
          window.bytune?.statsSummary("all"),
          window.bytune?.statsSummary("month"),
        ]);
        statsCache = {
          all: all ?? emptySummary("all"),
          month: month ?? emptySummary("month"),
          at: Date.now(),
        };
      } catch {
        /* keep whatever we had; a fresh app gets empties */
      } finally {
        statsInflight = null;
      }
      return statsCache ?? { all: emptySummary("all"), month: emptySummary("month"), at: Date.now() };
    })();
  }
  return statsInflight;
}

/**
 * Drop the cached stats pair so the next read re-queries the main process.
 * Called when the cloud restores the listening-history store — without this
 * a restored Replay would stay hidden behind the up-to-60s-old cache.
 */
export function invalidateStatsCache(): void {
  statsCache = null;
}

/** Subscribes to listening stats; refreshes on listening activity + a slow clock. */
export function useStats(): StatsPair | null {
  const listenVersion = useListening((s) => s.version);
  const reloadNonce = useUI((s) => s.homeReloadNonce);
  // Track changes double as a "a play may just have been credited" signal —
  // the previous track's play was counted at its midpoint, so by the time the
  // next one starts the main process already holds it.
  const playingId = usePlayer((s) => s.queue[s.index]?.id ?? "");
  const [stats, setStats] = useState<StatsPair | null>(statsCache);
  const prevPlayingId = useRef(playingId);
  const prevNonce = useRef(reloadNonce);

  useEffect(() => {
    let alive = true;
    const trackChanged = playingId !== prevPlayingId.current;
    prevPlayingId.current = playingId;
    const manualReload = reloadNonce !== prevNonce.current;
    prevNonce.current = reloadNonce;

    // Manual refreshes and track changes may carry plays the 60s cache would
    // hide — read straight through it. Track changes wait out the main
    // process's debounced 5s flush first; a refresh click, the very first
    // call ever, and a Home revisit past the cache's TTL answer instantly;
    // everything else keeps the 15s grace.
    const forced = manualReload || trackChanged;
    const cacheAge = statsCache === null ? Infinity : Date.now() - statsCache.at;
    const delay = manualReload
      ? 0
      : trackChanged
        ? 5_000
        : cacheAge >= STATS_TTL_MS
          ? 0
          : 15_000;
    const timer = window.setTimeout(() => {
      void loadStats(forced).then((s) => {
        if (alive) setStats(s);
      });
    }, delay);
    const clock = window.setInterval(() => {
      void loadStats().then((s) => {
        if (alive) setStats(s);
      });
    }, STATS_REFRESH_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenVersion, playingId, reloadNonce]);

  return stats;
}

/* ---------------------------------------------------------------- profile */

export type Maturity = "cold" | "light" | "warmed" | "strong";

export interface ArtistSignal {
  /** lowercased name — the stats' join key */
  key: string;
  name: string;
  /** youtube artist page when known (local tags / meta cache / search) */
  artistId: string | null;
  thumb: string | null;
  msMonth: number;
  playsMonth: number;
  msAll: number;
  playsAll: number;
  lastPlayedAt: number | null;
  likedTracks: number;
  skips: number;
  searchHits: number;
  /** net vote from recent listens (finishes +, early skips −), fading over days */
  lately: number;
  /** final affinity score — deterministic, higher = more present on Home */
  score: number;
}

/** An old favourite to dust off: real history, not played lately. */
export interface DustTrack {
  track: Track;
  plays: number;
  lastAt: number;
}

export interface TasteProfile {
  /** cheap change signal — feed rebuilds only when this moves */
  signature: string;
  generatedAt: number;
  /** stable per-day seed for the feed's rotation */
  daySeed: number;
  totalPlays: number;
  maturity: Maturity;
  /** ranked best-signal-first */
  artists: ArtistSignal[];
  /** the artists you're into right now (positive recent vote), strongest first */
  lately: ArtistSignal[];
  /** songs you keep coming back to right now */
  heavyRotation: Rotation[];
  /** old favourites not played in weeks, most-played first */
  dustOff: DustTrack[];
  /** artist pairs heard back to back (taste.ts pairKey → count) — taste sides read these */
  pairs: Map<string, number>;
  /** most-played tracks this month, best first */
  topTracks: ReplaySummary["tracks"];
  /** ids already in heavy rotation — candidates filter against these */
  playedTrackIds: Set<string>;
  recentlyPlayed: Track[];
  liked: Track[];
  searches: string[];
  /** listening minutes per hour of day (this month) — for gentle time context */
  hours: number[];
  /** 0..1 — how much the user listens at the current hour vs their peak */
  hourEnergy: number;
}

/**
 * Listening time credited for a history entry whose duration is unknown.
 * History is a completed play; this is the length of a typical track, used
 * only when the track itself carries no length.
 */
const ASSUMED_PLAY_MS = 210_000;

export function maturityOf(totalPlays: number): Maturity {
  // Cold means "no listening signal at all" — a handful of plays is already
  // enough to personalize against, so the first session gets real recs.
  if (totalPlays < 1) return "cold";
  if (totalPlays < 25) return "light";
  if (totalPlays < 100) return "warmed";
  return "strong";
}

interface ComputeInput {
  all: ReplaySummary;
  month: ReplaySummary;
  history: Track[];
  liked: Track[];
  playlists: Playlist[];
  searches: string[];
  skips: Record<string, SkipEntry>;
  now: number;
  /** artists the listener follows — a standing preference, like a few likes */
  followed?: { id: string; name: string; thumb?: string }[];
  /** how recent listens ended, oldest first (stores/journal) */
  journal?: readonly JournalEntry[];
  /** "Not interested" marks per artist key, faded as of `at` (stores/homeEngagement) */
  hiddenArtists?: Readonly<Record<string, { n: number; at: number }>>;
}

/** A skip tally or a "Not interested" mark fades over a month: you can come back to an artist. */
const NEGATIVE_HALF_LIFE = 30 * DAY_MS;
/** Heavy rotation and old favourites both look three weeks back. */
const RECENT_MS = 21 * DAY_MS;

export function computeTasteProfile(input: ComputeInput): TasteProfile {
  const { all, month, history, liked, playlists, searches, skips, now, followed = [], journal = [], hiddenArtists = {} } = input;

  const lower = (s: string): string => s.trim().toLowerCase();

  // ---- aggregate per artist (month for trend, all for long-term) ----------
  interface Agg {
    name: string;
    msMonth: number;
    playsMonth: number;
    msAll: number;
    playsAll: number;
    lastAt: number | null;
  }
  const aggs = new Map<string, Agg>();
  const aggFor = (name: string): Agg => {
    const key = lower(name) || "unknown artist";
    let a = aggs.get(key);
    if (!a) {
      a = { name: name.trim() || "Unknown artist", msMonth: 0, playsMonth: 0, msAll: 0, playsAll: 0, lastAt: null };
      aggs.set(key, a);
    }
    return a;
  };

  for (const a of month.artists) {
    const agg = aggFor(a.name);
    agg.msMonth = a.ms;
    agg.playsMonth = a.plays;
  }
  for (const a of all.artists) {
    const agg = aggFor(a.name);
    agg.msAll = a.ms;
    agg.playsAll = a.plays;
  }

  // ---- library fallback: real behaviour that travels with the account ------
  // Listening stats only exist on the device that recorded them, so a
  // restored account (new machine, cleared app data, or any build older than
  // stats sync) would read as cold and drop back to a generic feed even
  // though its history and likes are right here. For every artist stats is
  // silent about, the library's own plays and likes stand in. Per-artist
  // fallback — never added on top of stats — so nothing is double counted.
  const statsKnown = new Set<string>([...aggs.keys()]);
  const fromLibrary = new Map<string, { name: string; plays: number; ms: number }>();
  let libraryPlays = 0;
  let libraryLikes = 0;
  const creditFromLibrary = (track: Track, fromHistory: boolean): void => {
    const key = lower(track.artist) || "unknown artist";
    if (key === "unknown artist" || statsKnown.has(key)) return;
    if (!fromHistory) {
      libraryLikes += 1;
      // A like scores through likedBoost below, but the artist must exist in
      // the profile for that boost to be applied at all — even with no plays.
      if (!fromLibrary.has(key) && !aggs.has(key)) aggFor(track.artist);
      return; // a like is a preference, not a play
    }
    libraryPlays += 1;
    const cur = fromLibrary.get(key) ?? { name: track.artist, plays: 0, ms: 0 };
    cur.plays += 1;
    // A history entry is a completed play; the track's own length is the best
    // available stand-in for the listening time stats would have recorded.
    cur.ms += track.duration > 0 ? track.duration * 1000 : ASSUMED_PLAY_MS;
    fromLibrary.set(key, cur);
  };
  for (const t of history) creditFromLibrary(t, true);
  for (const t of liked) creditFromLibrary(t, false);
  // A followed artist is in the profile even before a single play.
  for (const a of followed) if (a.name.trim()) aggFor(a.name);
  for (const [key, credited] of fromLibrary) {
    const agg = aggFor(credited.name);
    agg.playsAll += credited.plays;
    agg.msAll += credited.ms;
  }
  // Artist recency: stats buckets don't timestamp artists, but their tracks
  // do — the freshest track counts as the artist's last visit.
  for (const t of [...month.tracks, ...all.tracks]) {
    const agg = aggFor(t.artist);
    if (!agg.lastAt || t.lastAt > agg.lastAt) agg.lastAt = t.lastAt;
  }

  // ---- identity resolution: real tracks first, then the persisted
  // artist-meta cache (search results from earlier runs) -------------------
  const idByKey = new Map<string, { artistId?: string; thumb?: string }>();
  // Followed artists carry their exact page id and photo.
  for (const a of followed) {
    const key = lower(a.name);
    if (key) idByKey.set(key, { artistId: a.id, thumb: a.thumb });
  }
  for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
    const key = lower(t.artist);
    if (!key || key === "unknown artist") continue;
    const cur = idByKey.get(key) ?? {};
    if (!cur.artistId && t.artistId) cur.artistId = t.artistId;
    if (!cur.thumb && t.artistImage) cur.thumb = t.artistImage;
    idByKey.set(key, cur);
  }
  for (const name of [...aggs.values()].map((a) => a.name)) {
    const key = lower(name);
    if (idByKey.has(key)) continue;
    const meta = peekArtistMeta(name);
    if (meta) idByKey.set(key, { artistId: meta.id, thumb: meta.thumb ?? undefined });
  }

  // ---- side signals --------------------------------------------------------
  const likedByKey = new Map<string, number>();
  for (const t of liked) {
    const key = lower(t.artist);
    likedByKey.set(key, (likedByKey.get(key) ?? 0) + 1);
  }
  // Following counts like two liked songs.
  for (const a of followed) {
    const key = lower(a.name);
    if (key) likedByKey.set(key, (likedByKey.get(key) ?? 0) + 2);
  }
  const searchByKey = new Map<string, number>();
  for (const q of searches) {
    const key = lower(q);
    for (const [artistKey2] of aggs) {
      if (artistKey2.includes(key) || key.includes(artistKey2)) {
        searchByKey.set(artistKey2, (searchByKey.get(artistKey2) ?? 0) + 1);
      }
    }
  }

  // ---- score ---------------------------------------------------------------
  // The maxima must consider library-credited artists too, otherwise a
  // restored account's fallback listening time would dwarf every real number.
  const maxMsMonth = Math.max(
    1,
    ...month.artists.map((a) => a.ms),
    ...[...aggs.values()].map((a) => a.msMonth)
  );
  const maxMsAll = Math.max(
    1,
    ...all.artists.map((a) => a.ms),
    ...[...aggs.values()].map((a) => a.msAll)
  );

  // ---- lately: the journal's net vote per artist (finishes +, skips −) ----
  const lately = latelyByArtist(journal, now);
  const maxLately = Math.max(0, ...lately.values());

  const artists: ArtistSignal[] = [];
  for (const [key, agg] of aggs) {
    // Untagged local files report "Unknown artist" — a real listening entry
    // for Replay, but never an artist the feed can personalize around.
    if (key === "unknown artist") continue;
    const engagement = agg.playsMonth + agg.playsAll + (likedByKey.get(key) ?? 0);
    if (engagement === 0) continue;

    // Recency decay: a half-life of ~5 days. Artists the user stepped away
    // from fade out; a return to them bounces straight back.
    const ageDays = agg.lastAt ? (now - agg.lastAt) / DAY_MS : null;
    const recency = ageDays === null ? 0.4 : Math.exp((-ageDays / 5) * Math.LN2);

    // The trend half: this month's listening time, and — once the journal
    // has something to say — an equal share of the recent net vote, so a
    // new obsession climbs within a few songs and a run of skips sinks it.
    const vote = lately.get(key) ?? 0;
    const monthTrend = (agg.msMonth / maxMsMonth) * (0.35 + 0.65 * recency);
    const trend = maxLately > 0 ? 0.5 * monthTrend + 0.5 * (Math.max(0, vote) / maxLately) : monthTrend;
    const longterm = agg.msAll / maxMsAll;
    const likedBoost = Math.min(12, (likedByKey.get(key) ?? 0) * 6);
    const searchBoost = Math.min(8, (searchByKey.get(key) ?? 0) * 4);
    const skipsNow = skips[key] ? skips[key].count * fade(now - skips[key].updatedAt, NEGATIVE_HALF_LIFE) : 0;
    const skipPenalty = Math.min(35, skipsNow * 9) + (vote < 0 ? Math.min(15, -vote * 5) : 0);
    const hidePenalty = Math.min(30, fadedCount(hiddenArtists[key], now, NEGATIVE_HALF_LIFE) * 12);

    const score = 60 * trend + 30 * longterm + likedBoost + searchBoost - skipPenalty - hidePenalty;
    // Engagement is the only gate: an absolute score floor would hide an
    // artist with real plays whenever any other artist has a large listening
    // total, which is exactly what a restored-but-small library looks like.
    // Low scorers simply rank below the ones the listener actually lives in.

    const identity = idByKey.get(key);
    artists.push({
      key,
      name: agg.name,
      artistId: identity?.artistId ?? null,
      thumb: identity?.thumb ?? null,
      msMonth: agg.msMonth,
      playsMonth: agg.playsMonth,
      msAll: agg.msAll,
      playsAll: agg.playsAll,
      lastPlayedAt: agg.lastAt,
      likedTracks: likedByKey.get(key) ?? 0,
      skips: skips[key]?.count ?? 0,
      searchHits: searchByKey.get(key) ?? 0,
      lately: vote,
      score,
    });
  }
  artists.sort((a, b) => b.score - a.score);
  const latelyArtists = artists.filter((a) => a.lately > 0).sort((a, b) => b.lately - a.lately);

  const playedTrackIds = new Set<string>();
  for (const t of month.tracks) playedTrackIds.add(t.id);
  for (const t of history) playedTrackIds.add(t.id);
  for (const t of liked) playedTrackIds.add(t.id);
  for (const e of journal) if (e.out !== "skip") playedTrackIds.add(e.track.id);

  // ---- songs: heavy rotation now, old favourites to dust off --------------
  // Stats rows carry no length or album; the full song, wherever the library
  // has it, plays and drags like any other.
  const known = new Map<string, Track>();
  for (const t of [...playlists.flatMap((p) => p.tracks), ...liked, ...history]) known.set(t.id, t);
  for (const e of journal) known.set(e.track.id, e.track);
  const songOf = (t: { id: string; title: string; artist: string; thumb: string }): Track =>
    known.get(t.id) ?? { id: t.id, title: t.title, artist: t.artist, thumb: t.thumb, duration: 0 };

  let heavyRotation = pickHeavyRotation(journal, now);
  // A journal still filling up (new install, restored account): this month's repeat plays stand in.
  if (heavyRotation.length < 4) {
    const inJournal = new Set(heavyRotation.map((r) => r.track.id));
    heavyRotation = [
      ...heavyRotation,
      ...month.tracks
        .filter((t) => t.plays >= 3 && !inJournal.has(t.id))
        .sort((a, b) => b.plays - a.plays)
        .map((t) => ({ track: songOf(t), listens: t.plays, score: 0 })),
    ].slice(0, 20);
  }

  const recentPlayed = new Set<string>();
  const recentSkipped = new Set<string>();
  for (const e of journal) {
    if (now - e.at > RECENT_MS) continue;
    (e.out === "skip" ? recentSkipped : recentPlayed).add(e.track.id);
  }
  const dustOff: DustTrack[] = pickDustOff(all.tracks, { played: recentPlayed, skipped: recentSkipped }, now).map((t) => ({
    track: songOf(t),
    plays: t.plays,
    lastAt: t.lastAt,
  }));

  const hours = month.hours.length === 24 ? month.hours : new Array(24).fill(0);
  const peakHour = Math.max(1, ...hours);
  const hourEnergy = hours[new Date().getHours()] / peakHour;

  // Maturity counts every real activity the account can prove, so a restored
  // library is never mistaken for a brand-new listener.
  const totalPlays = all.plays + libraryPlays + libraryLikes;
  const signature = [
    totalPlays,
    month.plays,
    all.tracks[0]?.id ?? "",
    history.length,
    history[0]?.id ?? "",
    liked.length,
    liked[0]?.id ?? "",
    playlists.length,
    searches[0] ?? "",
    Object.keys(skips).length,
    skips[artists[0]?.key ?? ""]?.count ?? 0,
    journal.length,
    journal[journal.length - 1]?.at ?? 0,
    Object.keys(hiddenArtists).length,
    dayBucket(now),
  ].join("|");

  return {
    signature,
    generatedAt: now,
    daySeed: dayBucket(now) * 2654435761,
    totalPlays,
    maturity: maturityOf(totalPlays),
    artists,
    lately: latelyArtists,
    heavyRotation,
    dustOff,
    pairs: backToBack(journal),
    topTracks: month.tracks,
    playedTrackIds,
    recentlyPlayed: history,
    liked,
    searches,
    hours,
    hourEnergy,
  };
}

/** React binding: the profile for the current stores, or null until stats land. */
export function useTasteProfile(): TasteProfile | null {
  const stats = useStats();
  const history = useLibrary((s) => s.history);
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const followed = useLibrary((s) => s.followedArtists);
  const searches = useRecents((s) => s.searches);
  const skips = useListening((s) => s.skips);
  const listenVersion = useListening((s) => s.version);
  const journal = useJournal((s) => s.entries);
  const hiddenArtists = useHomeEngagement((s) => s.hiddenArtists);

  return useMemo(() => {
    if (!stats) return null;
    return computeTasteProfile({
      all: stats.all,
      month: stats.month,
      // Podcast episodes are not music taste.
      history: history.filter((t) => !t.episode),
      liked: liked.filter((t) => !t.episode),
      playlists,
      searches,
      skips,
      now: Date.now(),
      followed,
      journal,
      hiddenArtists,
    });
    // listenVersion participates so a freshly recorded skip re-scores the
    // profile even when the skips object was recycled by the persistence layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, history, liked, playlists, searches, skips, listenVersion, followed, journal, hiddenArtists]);
}
