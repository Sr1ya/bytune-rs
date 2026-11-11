import type { SyncedLyricLine } from "../types";

/**
 * The synced lines worth showing. Providers attach backing-vocal / credit
 * lines wrapped in parentheses (or stamped 0:00) at the head of the song —
 * they render as phantom lyrics before the first real line, so they're
 * dropped there; later in the song a "(…)" line is a real lyric. A line that
 * is only a [label] ("[Chorus]") is a section heading and goes anywhere.
 * Instrumental gap markers always stay.
 */
export function visibleLyricLines(synced: SyncedLyricLine[]): SyncedLyricLine[] {
  const first = synced.findIndex((l) => !l.gap && !!l.text && !/^[[(]/.test(l.text.trim()) && l.time > 0);
  const head = first < 0 ? synced.length : first;
  return synced.filter((l, i) => l.gap || (!!l.text && i >= head && !/^\[[^\]]*\]$/.test(l.text.trim())));
}
