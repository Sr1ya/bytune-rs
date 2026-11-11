/**
 * Taste sides — your listening split by sound, the way a record has Side A
 * and Side B. Your top artists are grouped by two kinds of evidence:
 *   - the catalogue: YouTube lists one as the other's related artist;
 *   - you: you play them back to back (taste.ts backToBack), three times
 *     counting as much as the catalogue's say-so.
 * Groups merge by average linkage, so one artist who bridges two scenes
 * can't chain them into one blob. Each side of two or more artists becomes a
 * mix on Home; a lone artist is already covered by their own radio. Pure.
 */
import { pairKey } from "./taste";

export interface SideArtist {
  key: string;
  artistId: string | null;
  score: number;
}

/** Below this average tie, two groups stay separate sides. */
const MERGE_AT = 0.3;

export function findSides<T extends SideArtist>(
  artists: readonly T[],
  relatedIds: (artistId: string) => readonly string[] | null | undefined,
  pairs: ReadonlyMap<string, number>,
  maxSides = 4
): T[][] {
  const n = artists.length;
  const tie = (a: T, b: T): number => {
    const ra = a.artistId && b.artistId ? relatedIds(a.artistId) : null;
    const rb = a.artistId && b.artistId ? relatedIds(b.artistId) : null;
    const catalogue = (b.artistId && ra?.includes(b.artistId)) || (a.artistId && rb?.includes(a.artistId)) ? 1 : 0;
    const heard = Math.min(1, (pairs.get(pairKey(a.key, b.key)) ?? 0) / 3);
    return Math.min(1, catalogue + heard);
  };
  const w: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : tie(artists[i], artists[j]))));

  let groups: number[][] = artists.map((_, i) => [i]);
  for (;;) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let sum = 0;
        for (const a of groups[i]) for (const b of groups[j]) sum += w[a][b];
        const avg = sum / (groups[i].length * groups[j].length);
        if (avg > best) {
          best = avg;
          bi = i;
          bj = j;
        }
      }
    }
    if (best < MERGE_AT) break;
    const merged = [...groups[bi], ...groups[bj]];
    groups = groups.filter((_, k) => k !== bi && k !== bj);
    groups.push(merged);
  }

  const total = (g: number[]): number => g.reduce((s, i) => s + artists[i].score, 0);
  return groups
    .filter((g) => g.length >= 2)
    .sort((a, b) => total(b) - total(a))
    .slice(0, maxSides)
    .map((g) => g.map((i) => artists[i]).sort((a, b) => b.score - a.score));
}
