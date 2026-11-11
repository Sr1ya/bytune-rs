/**
 * A category's own ByTune mix: the songs of its top playlists taken in turns,
 * so no one list leads, one copy of each recording (radio-filter's key), at
 * most MIX_PER_ARTIST songs per artist, and no video uploads ("… Lyrical
 * Video …", "Song | Film | Cast"): ByTune plays songs. Pure — the category
 * page fetches the playlists, this picks.
 */
import { artistKey, recordingKey } from "./radio-filter";
import type { Track } from "../types";

export const MIX_SIZE = 60;
const MIX_PER_ARTIST = 3;
/** An upload's caption rather than a song's name: a lyric or video cut, or "Song | Film | Cast". */
const UPLOAD = /\b(lyrical|lyrics? video|video song|full video|official video|music video|promo|teaser|trailer|jukebox)\b|\s\|\s/i;

export function isUploadTitle(title: string): boolean {
  return UPLOAD.test(title);
}

export function buildMix(lists: readonly (readonly Track[])[], size = MIX_SIZE): Track[] {
  const out: Track[] = [];
  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const longest = lists.reduce((n, list) => Math.max(n, list.length), 0);
  for (let i = 0; i < longest && out.length < size; i++) {
    for (const list of lists) {
      const t = list[i];
      if (!t || t.episode || seen.has(t.id) || isUploadTitle(t.title)) continue;
      const rec = recordingKey(t.title, t.artist);
      const who = artistKey(t.artist);
      if ((rec && seen.has(rec)) || (who && (perArtist.get(who) ?? 0) >= MIX_PER_ARTIST)) continue;
      seen.add(t.id);
      if (rec) seen.add(rec);
      if (who) perArtist.set(who, (perArtist.get(who) ?? 0) + 1);
      out.push(t);
      if (out.length >= size) break;
    }
  }
  return out;
}
