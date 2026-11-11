/**
 * Which YouTube Music song is a song from somewhere else: a Spotify playlist row, a CSV line,
 * "Artist - Title" pasted in. Pure, so it is unit-tested: candidates in, the best one that is
 * really the same recording out, or null.
 *
 * A title is its words plus its version markers. The words must agree (a spelling difference
 * is tolerated); the markers must agree both ways, so a remix, a live take or a karaoke track
 * never stands in for the original, nor the original for them. Brackets and " - " tails
 * ("(From \"Pushpa\")", "- Remastered 2011", "(feat. Foxes)") are packaging and ignored.
 * When both sides name artists, one must be shared; a length far off rules a candidate out.
 * A language preference (dubbed film songs share a title and a length) only ranks: the best
 * overall match still wins when no candidate is in that language.
 */
import { normalizeTitle } from "../lib/radio-filter";
import type { Track } from "../types";

export interface MatchTarget {
  title: string;
  /** every credited artist, as the source writes them ("A, B & C") */
  artist: string;
  album?: string;
  /** seconds; 0 or missing = unknown */
  duration?: number;
}

export const MATCH_LANGUAGES = ["telugu", "tamil", "hindi", "kannada", "malayalam", "english"] as const;
export type MatchLanguage = (typeof MATCH_LANGUAGES)[number];
/** Languages a title or album may name; the preference list plus a few more that mark a dub. */
const LANGUAGE_WORDS = [...MATCH_LANGUAGES, "bengali", "marathi", "punjabi", "gujarati"];

/** Words that make a different recording; they must agree on both sides. */
const VERSION = /\b(remix|live|acoustic|instrumental|unplugged|karaoke|slowed|reverb|sped|nightcore|lo-?fi|cover|reprise|mashup|8d)\b/gu;
/** How far apart two lengths may be and still be one recording. */
const MAX_LENGTH_GAP = 15;
const MIN_TITLE_SIMILARITY = 0.85;

/** The title's own words: brackets, " - " tails and feat. credits dropped, case and width folded. */
export function titleWords(title: string): string {
  const bare = title.replace(/[([{【「『][^)\]}】」』]*[)\]}】」』]/g, " ").replace(/\s[-–—]\s.*$/u, " ");
  return normalizeTitle(bare) || normalizeTitle(title);
}

/** The version markers anywhere in a title, sorted ("lo-fi" and "lofi" are one). */
export function versionMarks(title: string): string {
  const found = title.normalize("NFKC").toLocaleLowerCase().match(VERSION) ?? [];
  return [...new Set(found.map((w) => w.replace("-", "")))].sort().join(" ");
}

/** Each credited artist, folded and without spaces or dots ("A. R. Rahman" = "AR Rahman"). */
export function artistNames(artist: string): string[] {
  return artist
    .split(/\s*(?:,|&|\+|\/|;|、|\sx\s|\sand\s|\s(?:feat|ft)\.?\s|\sfeaturing\s|\swith\s|\svs\.?\s)\s*/iu)
    .map((name) => normalizeTitle(name).replace(/\s+/g, ""))
    .filter(Boolean);
}

/** Dice similarity over character pairs, spaces ignored: 1 = the same letters in the same order. */
export function similarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) pairs.set(x.slice(i, i + 2), (pairs.get(x.slice(i, i + 2)) ?? 0) + 1);
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const n = pairs.get(y.slice(i, i + 2)) ?? 0;
    if (n > 0) {
      shared++;
      pairs.set(y.slice(i, i + 2), n - 1);
    }
  }
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

/** The first language a title or album names ("Maari 2 [Telugu]", "(Hindi Version)"), or null. */
export function languageOf(text: string): string | null {
  const folded = text.normalize("NFKC").toLocaleLowerCase();
  return LANGUAGE_WORDS.find((l) => new RegExp(`\\b${l}\\b`, "u").test(folded)) ?? null;
}

/** How sure a candidate is the target (higher is surer), or null when it is a different recording. */
export function matchScore(target: MatchTarget, song: Track, prefer = ""): number | null {
  if (versionMarks(target.title) !== versionMarks(song.title)) return null;
  const words = titleWords(target.title);
  const sim = similarity(words, titleWords(song.title));
  if (sim < MIN_TITLE_SIMILARITY) return null;
  const gap = target.duration && song.duration ? Math.abs(target.duration - song.duration) : null;
  if (gap !== null && gap > MAX_LENGTH_GAP) return null;

  const wanted = artistNames(target.artist);
  const credited = artistNames(song.artist);
  const shared = wanted.filter((w) => credited.includes(w)).length;
  // No exception for an exact title at the exact length: a dub ("Srivalli", Telugu and Hindi)
  // is exactly that, sung by someone else.
  if (wanted.length && credited.length && !shared) return null;

  let score = sim * 100 + (shared ? 30 + 10 * (shared / wanted.length) : 0);
  if (gap !== null) score += gap <= 3 ? 20 : gap <= 8 ? 10 : 0;
  if (target.album && song.album && titleWords(target.album) === titleWords(song.album)) score += 10;
  // The song's own words ("(Telugu)", an album "[Telugu]") beat the general preference.
  const lang = languageOf(`${target.title} ${target.album ?? ""}`) || prefer;
  if (lang) {
    const got = languageOf(`${song.title} ${song.album ?? ""}`);
    if (got === lang) score += 15;
    else if (got) score -= 40;
  }
  return score;
}

/** The best candidate that is the target, or null. */
export function bestMatch(target: MatchTarget, candidates: readonly Track[], prefer = ""): Track | null {
  let best: Track | null = null;
  let bestScore = -Infinity;
  for (const song of candidates) {
    if (!song?.id) continue;
    const score = matchScore(target, song, prefer);
    if (score !== null && score > bestScore) {
      best = song;
      bestScore = score;
    }
  }
  return best;
}

/**
 * What to ask YouTube Music's song search, best first: the title without its packaging (version
 * markers kept) and the first artist, then the title alone, for catalogues that credit a song to
 * its composer or film rather than its singer.
 */
export function searchQueries(target: MatchTarget): string[] {
  const title = target.title.replace(/[([{【「『][^)\]}】」』]*[)\]}】」』]/g, " ").replace(/\s[-–—]\s.*$/u, " ").replace(/\s+/g, " ").trim();
  const name = [title || target.title.trim(), versionMarks(target.title)].filter(Boolean).join(" ");
  const first = target.artist.split(/\s*(?:,|&|\sx\s|\s(?:feat|ft)\.?\s)\s*/iu)[0]?.trim() ?? "";
  return [...new Set([first ? `${name} ${first}` : name, name])].filter(Boolean);
}
