/**
 * Picks which radio songs AutoPlay queues — pure, so it is unit-tested.
 *
 * YouTube's radio repeats itself across pages, leans hard on the seed's
 * artist, and mixes catalogue songs with music videos and uploads of the same
 * recording. This keeps a session free of repeats (including the "(Official
 * Video)" cut of a song already heard), keeps artists varied, and prefers the
 * catalogue song.
 */
import type { Track } from "../types";

export interface RadioCandidate extends Track {
  videoType?: "song" | "video" | "upload" | "episode";
}

export interface PickOptions {
  /** ids never to queue: already played/queued this session, or "Don't play this" */
  excludeIds: ReadonlySet<string>;
  /** recordingKey()s already played/queued this session */
  excludeKeys: ReadonlySet<string>;
  /** artistKey of the seed song — it may appear a little more often */
  seedArtist?: string;
  limit: number;
}

const PER_ARTIST = 2;
const SEED_ARTIST = 3;
const MIN_SEC = 60;
const MAX_SEC = 15 * 60;
/** Queue videos only when fewer catalogue songs than this survive. */
const FEW_SONGS = 3;

/** Bracketed extras that name a different recording — those stay in the key. */
const VERSION_WORDS = /remix|cover|live|acoustic|instrumental|unplugged|karaoke|slowed|reverb|sped|lo-?fi|version/i;

/**
 * A title reduced to what identifies the song: case- and width-folded,
 * "(Official Video)", "[Lyrics]", "(From …)" and "feat." credits removed.
 * Letters, combining marks and digits of every script survive, so Telugu,
 * Hindi or Japanese titles never collapse to nothing.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[([【「][^)\]】」]*[)\]】」]/g, (group) => (VERSION_WORDS.test(group) ? group : " "))
    .replace(/\s+-\s+(?:official|lyrics?|audio|video|visuali[sz]er|from)\b.*$/u, " ")
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/u, " ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** The first credited artist, normalized — "A & B", "A, B", "A x B" → "a". */
export function artistKey(artist: string): string {
  return normalizeTitle(artist.split(/,|&|\s+x\s+|\s+(?:feat\.?|ft\.?)\s+/i)[0] ?? "");
}

/** One recording's identity across its song, video and lyric uploads ("" = unknown). */
export function recordingKey(title: string, artist: string): string {
  const name = normalizeTitle(title);
  return name ? `${name}|${artistKey(artist)}` : "";
}

/** Strips radio-only fields, so the queue (and history/likes built from it) keeps plain tracks. */
function plain(t: RadioCandidate): Track {
  const { videoType: _type, ...track } = t;
  return track;
}

export function pickSuggestions(candidates: readonly RadioCandidate[], opts: PickOptions): Track[] {
  const songs: RadioCandidate[] = [];
  const videos: RadioCandidate[] = [];
  const uploads: RadioCandidate[] = [];
  for (const c of candidates) {
    if (!c?.id || opts.excludeIds.has(c.id) || c.videoType === "episode") continue;
    // 0 = unknown length, which catalogue rows sometimes report: keep those.
    if (c.duration > 0 && (c.duration < MIN_SEC || c.duration > MAX_SEC)) continue;
    if (c.videoType === "upload") uploads.push(c);
    else if (c.videoType === "video") videos.push(c);
    else songs.push(c);
  }

  const picked: RadioCandidate[] = [];
  const keys = new Set<string>();
  const perArtist = new Map<string, number>();
  const take = (pool: RadioCandidate[]): void => {
    for (const c of pool) {
      if (picked.length >= opts.limit) return;
      const key = recordingKey(c.title, c.artist);
      if (key && (opts.excludeKeys.has(key) || keys.has(key))) continue;
      const who = c.artistId || artistKey(c.artist);
      const cap = who && (who === opts.seedArtist || artistKey(c.artist) === opts.seedArtist) ? SEED_ARTIST : PER_ARTIST;
      const n = perArtist.get(who) ?? 0;
      if (who && n >= cap) continue;
      if (who) perArtist.set(who, n + 1);
      if (key) keys.add(key);
      picked.push(c);
    }
  };
  take(songs);
  if (picked.length < FEW_SONGS) take(videos);
  if (!picked.length) take(uploads);
  return picked.map(plain);
}
