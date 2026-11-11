/** Replay's numbers and days, worded and counted the same everywhere. */
import type { JournalEntry } from "./recs/taste";

/** "week" is the listening journal's last seven days; the rest come from the stats buckets (electron/stats). */
export type ReplayPeriod = "week" | "month" | "lastMonth" | "year" | "all";

/** One period's listening, in the stats summary's shape. */
export interface ReplayData {
  totalMs: number;
  plays: number;
  tracks: { id: string; title: string; artist: string; thumb: string; ms: number; plays: number }[];
  artists: { name: string; thumb?: string; ms: number; plays: number }[];
  albums: { name: string; artist?: string; thumb?: string; ms: number; plays: number }[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: string;
  months: string[];
  /** how many different songs, artists and albums (the lists stop at 50) */
  counts?: { tracks: number; artists: number; albums: number };
}

/** "42 min", "1 hr", "2.5 hrs", "1,204 hrs". */
export function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  const v = h < 10 ? Math.round(h * 10) / 10 : Math.round(h);
  return `${v.toLocaleString()} ${v === 1 ? "hr" : "hrs"}`;
}

/** Local "YYYY-MM-DD", the shape electron/stats.ts keys its days by. */
export const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The activity chart's days, quiet ones included at 0: the last seven days,
 *  the month so far, all of last month, or the last 28 days for the longer periods. */
export function activityDays(
  period: ReplayPeriod,
  days: { date: string; ms: number }[],
  today = new Date(),
): { date: string; ms: number }[] {
  const byDate = new Map(days.map((d) => [d.date, d.ms]));
  const y = today.getFullYear();
  const m = today.getMonth();
  const [start, end] =
    period === "week" ? [new Date(y, m, today.getDate() - 6), today]
    : period === "month" ? [new Date(y, m, 1), today]
    : period === "lastMonth" ? [new Date(y, m - 1, 1), new Date(y, m, 0)]
    : [new Date(y, m, today.getDate() - 27), today];
  const out: { date: string; ms: number }[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = isoDay(d);
    out.push({ date, ms: byDate.get(date) ?? 0 });
  }
  return out;
}

/**
 * A cover colour made poster-bright: its own hue, saturation lifted to at
 * least `minS` and lightness set to `l` (both 0–1), so even a dusty cover
 * gives a rich wash on black. Greys stay grey. "R G B" in, "R G B" out.
 */
export function vividRgb(triplet: string, minS: number, l: number): string {
  const [r, g, b] = triplet
    .trim()
    .split(/\s+/)
    .map((v) => Math.min(255, Math.max(0, Number(v) || 0)) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.02) {
    const v = Math.round(l * 255);
    return `${v} ${v} ${v}`;
  }
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const s = Math.max(minS, Math.min(1, d / (1 - Math.abs(max + min - 1))));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r1, g1, b1].map((v) => Math.round((v + m) * 255)).join(" ");
}

/**
 * The artists a credit line names: "A, B & C" → ["A", "B", "C"], "A feat. B"
 * → ["A", "B"]. A band whose name holds one of those marks ("Mumford & Sons")
 * splits too; Replay asks the catalogue about such lines (creditArtists' `whole`).
 */
export function creditNames(line: string): string[] {
  const names = line
    .split(/\s*(?:,|&|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length ? names : [line.trim()];
}

type ArtistRow = ReplayData["artists"][number];

/**
 * Top artists by artist, not by credit line: every artist a line names gets
 * its full time and plays (Luis Fonsi and Daddy Yankee both get "Despacito"),
 * added to their other lines. Lines in `whole` (lowercased) are one artist
 * by the catalogue's own account and stay as they are.
 */
export function creditArtists(lines: readonly ArtistRow[], whole: ReadonlySet<string> = new Set()): ArtistRow[] {
  const out = new Map<string, ArtistRow>();
  for (const line of lines) {
    const names = whole.has(line.name.trim().toLowerCase()) ? [line.name.trim()] : creditNames(line.name);
    for (const name of names) {
      const key = name.toLowerCase();
      const cur: ArtistRow = out.get(key) ?? { name, ms: 0, plays: 0 };
      cur.ms += line.ms;
      cur.plays += line.plays;
      // A line's photo shows one artist; on a shared line there's no telling whose.
      if (!cur.thumb && line.thumb && names.length === 1) cur.thumb = line.thumb;
      out.set(key, cur);
    }
  }
  return [...out.values()].sort((x, y) => y.ms - x.ms || y.plays - x.plays);
}

/** The hour you listen most (0–23); null with no listening at all. */
export function peakHour(hours: readonly number[]): number | null {
  let best = -1;
  let at: number | null = null;
  hours.forEach((ms, h) => {
    if (ms > best && ms > 0) {
      best = ms;
      at = h;
    }
  });
  return at;
}

/** The day with the most listening; null with none. */
export function biggestDay(days: readonly { date: string; ms: number }[]): { date: string; ms: number } | null {
  let best: { date: string; ms: number } | null = null;
  for (const d of days) if (d.ms > 0 && (!best || d.ms > best.ms)) best = d;
  return best;
}

/** Days with any listening, and the longest run of them back to back. */
export function streaks(days: readonly { date: string; ms: number }[]): { active: number; longest: number } {
  const listened = [...new Set(days.filter((d) => d.ms > 0).map((d) => d.date))].sort();
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const date of listened) {
    // Noon, so a daylight-saving change never makes two days look 23 or 25 hours apart.
    const day = new Date(`${date}T12:00:00`);
    const next = prev ? new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1, 12) : null;
    run = next && isoDay(next) === isoDay(day) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  return { active: listened.length, longest };
}

/** The local day before / after a "YYYY-MM-DD" (noon-based, so daylight saving never skips one). */
export function shiftDay(date: string, by: number): string {
  const d = new Date(`${date}T12:00:00`);
  return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + by, 12));
}

/** The days a period's calendar shows: this week's seven, a whole month, a whole year, or the last 365 for all time. */
export function periodRange(period: ReplayPeriod, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const day = (yy: number, mm: number, dd: number): string => isoDay(new Date(yy, mm, dd, 12));
  const today = isoDay(now);
  if (period === "week") return { from: shiftDay(today, -6), to: today };
  if (period === "month") return { from: day(y, m, 1), to: day(y, m + 1, 0) };
  if (period === "lastMonth") return { from: day(y, m - 1, 1), to: day(y, m, 0) };
  if (period === "year") return { from: day(y, 0, 1), to: day(y, 11, 31) };
  return { from: shiftDay(today, -364), to: today };
}

/** One calendar slot: a day of the period (`ahead` while it's still to come), or null outside it. */
export type CalendarDay = { date: string; ms: number; ahead: boolean } | null;

/**
 * The days from `from` to `to` as whole calendar weeks starting on
 * `firstDay` (0 Sunday … 6 Saturday). Days outside the range are null, so
 * every week has seven slots and the weekdays line up.
 */
export function calendarWeeks(
  from: string,
  to: string,
  days: readonly { date: string; ms: number }[],
  today: string,
  firstDay: number,
): CalendarDay[][] {
  const byDate = new Map(days.map((d) => [d.date, d.ms]));
  let start = from;
  while (new Date(`${start}T12:00:00`).getDay() !== firstDay) start = shiftDay(start, -1);
  const weeks: CalendarDay[][] = [];
  for (let d = start; d <= to; ) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++, d = shiftDay(d, 1)) week.push(d < from || d > to ? null : { date: d, ms: byDate.get(d) ?? 0, ahead: d > today });
    weeks.push(week);
  }
  return weeks;
}

/**
 * Your streak as of `today`: the run of back-to-back listening days that
 * ends today, or yesterday while today is still to play (a streak breaks
 * only once a whole day passes without music), and your longest run, with
 * its first and last day (the latest, on a tie).
 */
export function streakNow(
  days: readonly { date: string; ms: number }[],
  today = new Date(),
): { current: number; today: boolean; best: number; bestFrom: string | null; bestTo: string | null } {
  const listened = new Set(days.filter((d) => d.ms > 0).map((d) => d.date));
  let best = 0;
  let bestFrom: string | null = null;
  let bestTo: string | null = null;
  for (const start of [...listened].sort()) {
    if (listened.has(shiftDay(start, -1))) continue;
    let end = start;
    let len = 1;
    while (listened.has(shiftDay(end, 1))) {
      end = shiftDay(end, 1);
      len++;
    }
    if (len >= best) [best, bestFrom, bestTo] = [len, start, end];
  }
  const todayKey = isoDay(today);
  const heard = listened.has(todayKey);
  let current = 0;
  for (let d = heard ? todayKey : shiftDay(todayKey, -1); listened.has(d); d = shiftDay(d, -1)) current++;
  return { current, today: heard, best, bestFrom, bestTo };
}

/**
 * The last seven days (today and the six before it) from the listening
 * journal, in Replay's shape. Minutes count everything heard, skips
 * included; plays count finished and part-heard listens — the same line the
 * stats draw between a listen and a click-through.
 */
export function journalReplay(entries: readonly JournalEntry[], now: number): ReplayData {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const since = start.getTime();

  const tracks = new Map<string, ReplayData["tracks"][number] & { lastAt: number }>();
  const artists = new Map<string, ReplayData["artists"][number]>();
  const albums = new Map<string, ReplayData["albums"][number]>();
  const hours = new Array<number>(24).fill(0);
  const days = new Map<string, number>();
  let totalMs = 0;
  let plays = 0;

  for (const e of entries) {
    if (e.at < since || e.at > now) continue;
    const ms = Math.max(0, e.heard) * 1000;
    const played = e.out === "skip" ? 0 : 1;
    const t = e.track;
    totalMs += ms;
    plays += played;

    const cur = tracks.get(t.id) ?? { id: t.id, title: t.title, artist: t.artist, thumb: t.thumb, ms: 0, plays: 0, lastAt: 0 };
    cur.ms += ms;
    cur.plays += played;
    if (e.at >= cur.lastAt) Object.assign(cur, { title: t.title, artist: t.artist, thumb: t.thumb || cur.thumb, lastAt: e.at });
    tracks.set(t.id, cur);

    const artistKey = t.artist.trim().toLowerCase();
    if (artistKey && artistKey !== "unknown artist") {
      const a = artists.get(artistKey) ?? { name: t.artist, ms: 0, plays: 0 };
      a.ms += ms;
      a.plays += played;
      artists.set(artistKey, a);
    }
    if (t.album) {
      const key = `${t.album.toLowerCase()}|${artistKey || "unknown artist"}`;
      const al = albums.get(key) ?? { name: t.album, artist: t.artist, thumb: t.thumb, ms: 0, plays: 0 };
      al.ms += ms;
      al.plays += played;
      albums.set(key, al);
    }

    // When the listen started: the journal stamps its end.
    const began = new Date(e.at - ms);
    hours[began.getHours()] += ms;
    const day = isoDay(began);
    days.set(day, (days.get(day) ?? 0) + ms);
  }

  const byTime = <T extends { ms: number }>(m: Map<string, T>): T[] => [...m.values()].sort((x, y) => y.ms - x.ms).slice(0, 50);
  return {
    totalMs,
    plays,
    tracks: byTime(tracks).map(({ id, title, artist, thumb, ms, plays }) => ({ id, title, artist, thumb, ms, plays })),
    artists: byTime(artists),
    albums: byTime(albums),
    hours,
    days: [...days.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, ms]) => ({ date, ms })),
    period: "week",
    months: [],
    counts: { tracks: tracks.size, artists: new Set([...artists.keys()].flatMap(creditNames)).size, albums: albums.size },
  };
}
