/**
 * The Home algorithm's short-term memory, as pure functions over the
 * listening journal (stores/journal): how each listen ended, how fast a
 * signal fades, which artists you're into lately, what's in heavy rotation,
 * which artists you play back to back, which old favourites to dust off, and
 * how well a playlist's artist line matches your taste.
 *
 * The model, in short: every listen is a vote for its artist and its song.
 * A finish counts 1, a part-listen 0.5, an early skip -1, and every vote fades
 * with a half-life, so what you play this week moves Home within a song or
 * two and what you stop playing drifts off on its own. No store and no clock
 * of its own: every function takes `now`, so one journal always gives one
 * answer.
 */
import type { Track } from "../../types";

export const DAY_MS = 86_400_000;

export type ListenOutcome = "done" | "part" | "skip";

export interface JournalEntry {
  /** the song as it played, trimmed to what replaying it needs */
  track: Track;
  /** when the listen ended (ms) — the moment its outcome was known */
  at: number;
  /** seconds actually heard */
  heard: number;
  out: ListenOutcome;
}

/** 1 now, 0.5 one half-life ago, fading toward 0. */
export function fade(ageMs: number, halfLifeMs: number): number {
  return ageMs <= 0 ? 1 : Math.pow(0.5, ageMs / halfLifeMs);
}

export function artistKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Did the listener walk away from this track? Conservative on purpose: a
 * track needs a known duration, at least a few seconds heard, and an early
 * exit — anything ambiguous (buffering, unknown length, near-complete plays)
 * stays neutral. The skip tally (stores/listening) and the journal share it.
 */
export function isEarlyExit(playedSec: number, durationSec: number): boolean {
  if (playedSec < 4) return false; // micro-gaps and instant double-clicks
  if (!(durationSec > 30)) return false;
  const exitWindow = Math.min(durationSec * 0.4, 120);
  return playedSec < exitWindow && playedSec < durationSec * 0.9;
}

/** How a listen ended; null for a click-through too short to mean anything. */
export function outcomeOf(heardSec: number, durationSec: number): ListenOutcome | null {
  if (!(heardSec >= 4)) return null;
  if (isEarlyExit(heardSec, durationSec)) return "skip";
  // Crossfades and trimmed silences end songs early: 70% heard is a finish. Unknown length: two minutes.
  const full = durationSec > 30 ? heardSec >= durationSec * 0.7 : heardSec >= 120;
  return full ? "done" : "part";
}

const VOTE: Record<ListenOutcome, number> = { done: 1, part: 0.5, skip: -1 };

/** Short horizon for "lately": a week-old listen counts a fifth as much as today's. */
export const LATELY_HALF_LIFE = 3 * DAY_MS;

/** Each artist's net vote over the short horizon: finishes and replays add, early skips subtract. */
export function latelyByArtist(entries: readonly JournalEntry[], now: number, halfLifeMs = LATELY_HALF_LIFE): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    const key = artistKeyOf(e.track.artist);
    if (!key || key === "unknown artist") continue;
    out.set(key, (out.get(key) ?? 0) + VOTE[e.out] * fade(now - e.at, halfLifeMs));
  }
  return out;
}

export interface Rotation {
  track: Track;
  /** finished or part-heard listens in the window */
  listens: number;
  score: number;
}

/**
 * Heavy rotation: songs you keep coming back to right now. A song needs two
 * or more real listens in the last three weeks and a positive faded vote, so
 * one play never makes the list and a song you started skipping falls off it.
 */
export function heavyRotation(
  entries: readonly JournalEntry[],
  now: number,
  opts: { windowMs?: number; halfLifeMs?: number; minListens?: number; max?: number } = {}
): Rotation[] {
  const { windowMs = 21 * DAY_MS, halfLifeMs = 5 * DAY_MS, minListens = 2, max = 20 } = opts;
  const byId = new Map<string, Rotation & { latest: number }>();
  for (const e of entries) {
    if (now - e.at > windowMs) continue;
    const cur = byId.get(e.track.id) ?? { track: e.track, listens: 0, score: 0, latest: 0 };
    if (e.out !== "skip") cur.listens += 1;
    cur.score += VOTE[e.out] * fade(now - e.at, halfLifeMs);
    // The newest copy carries the freshest metadata (art, title fixes).
    if (e.at >= cur.latest) {
      cur.latest = e.at;
      cur.track = e.track;
    }
    byId.set(e.track.id, cur);
  }
  return [...byId.values()]
    .filter((r) => r.listens >= minListens && r.score > 0)
    .sort((a, b) => b.score - a.score || b.listens - a.listens)
    .slice(0, max)
    .map(({ track, listens, score }) => ({ track, listens, score }));
}

/** A count that fades: `n` as of `at`, read at `now`. */
export function fadedCount(entry: { n: number; at: number } | undefined, now: number, halfLifeMs: number): number {
  return entry ? entry.n * fade(now - entry.at, halfLifeMs) : 0;
}

/** "a|b" with the two artist keys in a fixed order. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Artists heard back to back: consecutive listens (no skip on either side)
 * within half an hour, counted per artist pair. Taste sides (sides.ts) read
 * these: what you play together belongs together, whatever the catalogue says.
 */
export function backToBack(entries: readonly JournalEntry[], gapMs = 30 * 60_000): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...entries].sort((x, y) => x.at - y.at);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.out === "skip" || b.out === "skip" || b.at - a.at > gapMs) continue;
    const ka = artistKeyOf(a.track.artist);
    const kb = artistKeyOf(b.track.artist);
    if (!ka || !kb || ka === kb || ka === "unknown artist" || kb === "unknown artist") continue;
    const key = pairKey(ka, kb);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

export interface StatTrack {
  id: string;
  title: string;
  artist: string;
  thumb: string;
  plays: number;
  lastAt: number;
}

/**
 * Old favourites to dust off: songs with real history (three plays or more)
 * that you haven't played in three weeks — and haven't skipped lately either.
 * Most-played first.
 */
export function dustOff(
  tracks: readonly StatTrack[],
  recent: { played: ReadonlySet<string>; skipped: ReadonlySet<string> },
  now: number,
  opts: { restMs?: number; minPlays?: number; max?: number } = {}
): StatTrack[] {
  const { restMs = 21 * DAY_MS, minPlays = 3, max = 20 } = opts;
  return tracks
    .filter((t) => t.plays >= minPlays && now - t.lastAt >= restMs && !recent.played.has(t.id) && !recent.skipped.has(t.id))
    .sort((a, b) => b.plays - a.plays || b.lastAt - a.lastAt)
    .slice(0, max);
}

/**
 * "Arijit Singh, Pritam & Shreya Ghoshal and more" → its artist keys. Never
 * splits on a bare "and" (it's inside names); "Name • 15M views" style counts
 * are dropped.
 */
export function artistsInLine(line: string): string[] {
  return line
    .replace(/\s+(?:and|&)\s+more\s*$/i, "")
    .split(/,|&|•|\s+x\s+|\bfeat\.?\s|\bft\.?\s/i)
    .map(artistKeyOf)
    .filter((k) => k && k !== "unknown artist" && !/^\d[\d.,]*\s*[kmb]?\s*(views|plays|songs|tracks|subscribers|listeners)$/.test(k));
}

/**
 * Order items by how much of their artist line is your taste (affinity 0..1
 * per artist key). Items that match nothing keep their order behind the ones
 * that do — a stable sort, so the provider's own order is the tie-break.
 */
export function rankByTaste<T extends { subtitle?: string }>(items: readonly T[], affinity: ReadonlyMap<string, number>): T[] {
  if (!affinity.size) return [...items];
  const scored = items.map((item, i) => {
    let match = 0;
    for (const key of artistsInLine(item.subtitle ?? "")) match += affinity.get(key) ?? 0;
    return { item, i, match };
  });
  return scored.sort((a, b) => b.match - a.match || a.i - b.i).map((s) => s.item);
}
