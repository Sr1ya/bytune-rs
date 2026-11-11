/** Small formatting helpers shared across the UI. */

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

// Brackets that say where a song comes from, not what it's called.
const FROM_TAG = /^\s*from\s/i;
const SOUNDTRACK_TAG = /music from|motion picture|soundtrack|original series/i;
const VERSION_WORDS = /version|mix|edit|remaster|live|acoustic/i;
const VIDEO_LABEL = /^\s*(?:(?:official\s+)?(?:music\s+|lyric(?:al)?\s+|full\s+)?(?:video|audio|visuali[sz]er|lyrics?|lyrical)(?:\s+song)?|4k|hd|hq)\s*$/i;

/** The film or series a "From …" tag names: the quoted name, else the words up to any inner bracket. */
function sourceName(words: string): string | null {
  const quoted = /["“”]([^"“”]+)["“”]/.exec(words);
  const name = quoted ? quoted[1] : words.replace(/^\s*from\s+/i, "").replace(/\s*[([].*$/, "");
  return name.trim() || null;
}

function splitTitle(title: string): { short: string; source: string | null } {
  let out = "";
  let source: string | null = null;
  for (let i = 0; i < title.length; ) {
    const open = title[i];
    const close = open === "(" ? ")" : open === "[" ? "]" : "";
    if (close) {
      let depth = 0;
      let j = i;
      for (; j < title.length; j++) {
        if (title[j] === open) depth++;
        else if (title[j] === close && --depth === 0) break;
      }
      const inner = title.slice(i + 1, j);
      const from = FROM_TAG.test(inner);
      if (j < title.length && (from || VIDEO_LABEL.test(inner) || (SOUNDTRACK_TAG.test(inner) && !VERSION_WORDS.test(inner)))) {
        if (from) source ??= sourceName(inner);
        i = j + 1;
        continue;
      }
    }
    out += title[i++];
  }
  // The same tag without brackets: "Naatu Naatu - From "RRR"".
  const dash = /\s+[-–—]\s+(from\s.+)$/i.exec(out);
  if (dash) {
    source ??= sourceName(dash[1]);
    out = out.slice(0, dash.index);
  }
  const short = out.replace(/\s+/g, " ").replace(/[\s\-–—|:,]+$/, "").trim();
  return { short: short || title.trim(), source };
}

/**
 * A song or album title as shown on screen. YouTube Music writes the film or
 * series a song comes from into many titles — "Gehra Hua (From "Dhurandhar")"
 * — and uploads carry "(Official Video)"; those brackets say where a song is
 * from, not what it's called, so the screen leaves them out. Featured
 * artists, the language and the version stay. Display only: search, lyrics,
 * downloads and sharing keep the full title.
 */
export function shortTitle(title: string): string {
  return splitTitle(title).short;
}

/** The film or series a title names ("Dhurandhar"), for a "From …" line; null when it names none. */
export function titleSource(title: string): string | null {
  return splitTitle(title).source;
}

/** A page title's size step: full size while the name is short, smaller as it grows, so the whole name shows. */
export function titleStep(name: string): 0 | 1 | 2 {
  return name.length <= 26 ? 0 : name.length <= 48 ? 1 : 2;
}

/** Album, playlist and podcast page titles, by titleStep. */
export const PAGE_TITLE_SIZE = ["text-[34px]", "text-[28px]", "text-[24px]"] as const;

/** A total running time in words: "45 min", "1 hr 2 min", "3 hr". */
export function fmtTotal(sec: number): string {
  const minutes = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
