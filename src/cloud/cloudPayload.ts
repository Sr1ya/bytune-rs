/**
 * Validation of what the cloud sends back — ByTune's electron/cloud-payload.ts, unchanged but for
 * its imports, Node's byte length (a UTF-8 length here) and the three settings checks it took from
 * backup-transfer.ts, copied in below.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { SYNCED_STORES } from "../lib/config";
import { artworkUrlOk } from "../lib/artwork";
import { MATCH_LANGUAGES } from "../shared/track-match";
import { DEVICE_SETTINGS_FIELDS } from "./syncMerge";

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/** The import language preference: "" (any) or one of the matcher's languages. */
function matchLanguageOk(v: unknown): boolean {
  return v === "" || (MATCH_LANGUAGES as readonly unknown[]).includes(v);
}

/** Equalizer band gains: one dB value per band (EQ_BANDS in src/lib/audio.ts has 10), within ±12. */
function eqGainsOk(v: unknown): boolean {
  return Array.isArray(v) && v.length === 10 && v.every((g) => typeof g === "number" && Number.isFinite(g) && g >= -12 && g <= 12);
}

/** Saved EQ presets: at most 20, each a short non-empty name and a valid gain curve. */
function eqPresetsOk(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length <= 20 &&
    v.every(
      (p) =>
        !!p && typeof p === "object" && typeof p.name === "string" && p.name.trim().length > 0 && p.name.length <= 40 && eqGainsOk(p.gains)
    )
  );
}

export const MAX_CLOUD_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const invalid = (): never => { throw new Error("Invalid cloud backup data."); };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 16_384;
const id = (v: unknown): v is string => text(v) && v.length > 0 && v.length <= 1024 && !forbidden.has(v);
const timestamp = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function boundedJson(value: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 24) invalid();
    if (v === null || typeof v === "boolean") bytes += 5;
    else if (typeof v === "number") { if (!Number.isFinite(v)) invalid(); bytes += 24; }
    else if (typeof v === "string") {
      if (v.length > MAX_CLOUD_PAYLOAD_BYTES) invalid();
      bytes += byteLength(JSON.stringify(v));
    } else if (Array.isArray(v)) {
      if (v.length > 50_000) invalid();
      bytes += v.length + 2;
      for (const item of v) visit(item, depth + 1);
    } else if (object(v)) {
      bytes += 2;
      for (const [key, item] of Object.entries(v)) {
        if (forbidden.has(key) || key.length > 1024) invalid();
        bytes += byteLength(JSON.stringify(key)) + 2;
        visit(item, depth + 1);
      }
    } else invalid();
    if (bytes > MAX_CLOUD_PAYLOAD_BYTES) invalid();
  };
  visit(value, 0);
}

/**
 * Sanitize a list of id-keyed records IN PLACE: malformed or duplicate entries
 * are dropped, valid ones survive. Returns the cleaned array (or undefined
 * when the field itself was unusable).
 *
 * Dropping is the deliberate policy here. The push path never validated, so a
 * payload written by any earlier build (or a track whose duration serialized
 * to `null`, or an old playlist without `tracks`) could permanently brick the
 * account: one bad record used to reject the ENTIRE row, which meant sign-in
 * never pulled the account's real data and "Restore from cloud" always failed.
 * A dropped record is a loss the app can heal on the next visit to it; a
 * rejected row was a loss of every liked song and playlist at once.
 */
function cleanRecords<T = any>(value: unknown, check: (record: Record<string, any>) => boolean): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const entry of value) {
    if (!object(entry) || !id(entry.id) || seen.has(entry.id) || !check(entry)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out as T[];
}

/** A library track row: only fields the renderer actually reads are checked. */
const trackOk = (t: Record<string, any>): boolean =>
  text(t.title) && text(t.artist) && text(t.thumb)
  && typeof t.duration === "number" && Number.isFinite(t.duration) && t.duration >= 0;

/** Thumbs come from a hostile-able source (a compromised other session or a
 *  shared backup). Scheme-unsafe URLs are stripped in place rather than
 *  dropping the record — the pull self-heals instead of losing the sync, and a
 *  non-web URL can never reach <img src>. */
const stripUnsafeThumbs = (records: unknown): void => {
  for (const record of Array.isArray(records) ? records : []) {
    if (object(record) && typeof record.thumb === "string" && record.thumb !== "" && !artworkUrlOk(record.thumb)) {
      record.thumb = "";
    }
  }
};

/**
 * Validate (and normalize) one store's cloud payload. Throws only for
 * structural problems that make the row unrepresentable — a non-object
 * envelope, a missing `state`, a size/depth violation or a prototype-polluting
 * key. Everything inside `state` is sanitized in place: malformed records and
 * settings keys are dropped so one bad field can never take down the account.
 *
 * Returns true when something was dropped or normalized, so the caller can
 * push the healed copy back and the account stops paying the same tax on
 * every future sync.
 */
export function validateCloudPayload(name: string, payload: unknown): boolean {
  let sanitized = false;
  boundedJson(payload);
  if (!object(payload) || !object(payload.state) || (payload.version !== undefined && !timestamp(payload.version))) invalid();
  const state = (payload as Record<string, any>).state;

  if (name === "library") {
    // The download registry is device-owned (local file paths + per-machine
    // state, stripped before upload) and must never arrive from the cloud:
    // a planted copy would hydrate into the renderer's download view and be
    // pushed back up on the next local write. Same policy as the device
    // settings fields below.
    delete state.downloads;
    for (const key of ["liked", "history"]) {
      const before = JSON.stringify(state[key] ?? null);
      stripUnsafeThumbs(state[key]);
      const clean = cleanRecords(state[key], trackOk);
      if (state[key] !== undefined) state[key] = clean ?? [];
      if (JSON.stringify(state[key]) !== before) sanitized = true;
    }
    if (state.playlists !== undefined) {
      const before = JSON.stringify(state.playlists);
      if (!Array.isArray(state.playlists)) state.playlists = [];
      stripUnsafeThumbs(state.playlists);
      const clean = cleanRecords(state.playlists, (p) => {
        if (!text(p.name) || !timestamp(p.createdAt) || !Array.isArray(p.tracks)) return false;
        stripUnsafeThumbs(p.tracks);
        if (p.orderedAt !== undefined && !timestamp(p.orderedAt)) delete p.orderedAt;
        const tracks = cleanRecords(p.tracks, trackOk);
        if (tracks === undefined) return false;
        p.tracks = tracks;
        return (p.folderId === undefined || id(p.folderId)) && (p.pinned === undefined || typeof p.pinned === "boolean");
      });
      if (clean !== undefined) state.playlists = clean;
      if (JSON.stringify(state.playlists) !== before) sanitized = true;
    }
    const beforeFolders = JSON.stringify(state.folders ?? null);
    const folders = cleanRecords(state.folders, (f) => text(f.name) && timestamp(f.createdAt));
    if (state.folders !== undefined) state.folders = folders ?? [];
    const beforeFollows = JSON.stringify(state.followedArtists ?? null);
    const follows = cleanRecords(state.followedArtists, (a) => text(a.name) && timestamp(a.followedAt));
    if (state.followedArtists !== undefined) state.followedArtists = follows ?? [];
    if (JSON.stringify(state.folders ?? null) !== beforeFolders || JSON.stringify(state.followedArtists ?? null) !== beforeFollows) sanitized = true;
    if (state.pinnedSingles !== undefined) {
      const before = JSON.stringify(state.pinnedSingles);
      if (object(state.pinnedSingles)) {
        for (const [k, v] of Object.entries(state.pinnedSingles)) {
          if (typeof v !== "boolean") delete state.pinnedSingles[k];
        }
      } else {
        delete state.pinnedSingles;
      }
      if (JSON.stringify(state.pinnedSingles ?? null) !== before) sanitized = true;
    }
    if (state.libraryOrder !== undefined) {
      // Your Library's row order: row keys ("playlist:<id>"), short and bounded.
      const before = JSON.stringify(state.libraryOrder);
      state.libraryOrder = Array.isArray(state.libraryOrder)
        ? state.libraryOrder.filter((k: unknown) => typeof k === "string" && k.length > 0 && k.length <= 200).slice(0, 5000)
        : [];
      if (JSON.stringify(state.libraryOrder) !== before) sanitized = true;
    }
  } else if (name === "recent-searches") {
    if (state.searches !== undefined) {
      const before = JSON.stringify(state.searches);
      state.searches = Array.isArray(state.searches)
        ? state.searches.filter((q: unknown) => text(q) && q.length > 0)
        : [];
      if (JSON.stringify(state.searches) !== before) sanitized = true;
    }
  } else if (name === "listening-signals") {
    if (state.skips !== undefined) {
      const before = JSON.stringify(state.skips);
      if (object(state.skips)) {
        for (const [artist, v] of Object.entries(state.skips)) {
          if (!object(v) || !timestamp(v.count) || !timestamp(v.updatedAt)) delete state.skips[artist];
        }
      } else {
        state.skips = {};
      }
      if (JSON.stringify(state.skips) !== before) sanitized = true;
    }
    if (state.version !== undefined && !timestamp(state.version)) { state.version = 0; sanitized = true; }
  } else if (name === "listening-history") {
    sanitized = sanitizeHistoryBuckets(state) || sanitized;
  } else if (name === "artist-meta-cache") {
    // Artist name → YouTube page id + photo. Bounded, and a hostile entry can
    // only ever point at a non-web thumb (stripped) or a navigation id.
    if (state.byName !== undefined) {
      const before = JSON.stringify(state.byName);
      const entries = object(state.byName) ? Object.entries(state.byName) : [];
      const clean: Record<string, any> = {};
      for (const [name, meta] of entries.slice(0, 400)) {
        if (!id(name) || !object(meta) || !id(meta.id)) continue;
        if (typeof meta.resolvedAt !== "number" || !Number.isFinite(meta.resolvedAt)) continue;
        if (meta.thumb != null && typeof meta.thumb !== "string") continue;
        if (typeof meta.thumb === "string" && meta.thumb !== "" && !artworkUrlOk(meta.thumb)) meta.thumb = "";
        clean[name] = { id: meta.id, thumb: meta.thumb ?? null, resolvedAt: meta.resolvedAt };
      }
      state.byName = clean;
      sanitized = JSON.stringify(clean) !== before;
    }
  } else if (name === "settings") {
    for (const [key, v] of Object.entries(state)) {
      // Device-owned fields must never arrive from the cloud: strip them so a
      // hostile row cannot plant a path on a fresh machine (local values are
      // re-attached by the device merge, and consumption re-gates anyway).
      if ((DEVICE_SETTINGS_FIELDS as readonly string[]).includes(key)) {
        delete state[key];
        sanitized = true;
        continue;
      }
      if (key === "loudnessLevel") {
        if (typeof v !== "string" || !["off", "quiet", "normal", "loud"].includes(v)) { delete state[key]; sanitized = true; }
      } else if (key === "matchLanguage") {
        if (!matchLanguageOk(v)) { delete state[key]; sanitized = true; }
      } else if (["downloadQuality", "streamingQuality"].includes(key)) {
        const allowed = key === "downloadQuality" ? ["standard", "high", "lossless"] : ["low", "medium", "high", "lossless"];
        if (typeof v !== "string" || !allowed.includes(v)) { delete state[key]; sanitized = true; }
      } else if (key === "crossfadeSeconds" || key === "playbackSpeed") {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > (key === "playbackSpeed" ? 2 : 30)) { delete state[key]; sanitized = true; }
      } else if (key === "eqGains") {
        if (!eqGainsOk(v)) { delete state[key]; sanitized = true; }
      } else if (key === "eqPresets") {
        if (!eqPresetsOk(v)) { delete state[key]; sanitized = true; }
      } else if (typeof v !== "boolean") {
        // Unknown or non-conforming keys are dropped, not fatal: a value from
        // a different build must not be able to brick the whole account.
        delete state[key];
        sanitized = true;
      }
    }
  } else invalid();
  return sanitized;
}

/** Replay buckets: month key + the four aggregates, each record-sanitized. */
function sanitizeHistoryBuckets(state: Record<string, any>): boolean {
  const counters = (v: any): boolean => typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0
    && typeof v.plays === "number" && Number.isFinite(v.plays) && v.plays >= 0;
  // Track rows carry title/artist/thumb; artist and album rows carry name.
  const trackEntry = (v: any): boolean => object(v) && text(v.title) && text(v.artist) && text(v.thumb) && counters(v);
  const nameEntry = (v: any): boolean => object(v) && text(v.name) && counters(v);
  // A non-web URL can never reach <img src> — stripped, not dropped.
  const safeThumb = (v: any): void => {
    if (typeof v.thumb === "string" && v.thumb !== "" && !artworkUrlOk(v.thumb)) v.thumb = "";
  };
  const trim = (rec: unknown, max: number): Record<string, any> => {
    if (!object(rec)) return {};
    const keys = Object.keys(rec);
    if (keys.length <= max) return rec;
    const keep = keys.sort((a, b) => (Number(rec[b]?.ms) || 0) - (Number(rec[a]?.ms) || 0)).slice(0, max);
    return Object.fromEntries(keep.map((k) => [k, rec[k]]));
  };
  if (state.buckets === undefined) return false;
  const before = JSON.stringify(state.buckets);
  // Buckets are keyed by `month`, not `id`, so they are sanitized here rather
  // than through cleanRecords — an id-keyed sweep would drop every month.
  const seenMonths = new Set<string>();
  const clean: any[] = [];
  for (const b of Array.isArray(state.buckets) ? state.buckets : []) {
    if (!object(b) || !text(b.month) || !/^\d{4}-\d{2}$/.test(b.month) || seenMonths.has(b.month)) continue;
    seenMonths.add(b.month);
    b.tracks = trim(b.tracks, 600);
    b.artists = trim(b.artists, 400);
    b.albums = trim(b.albums, 400);
    // NB: object() is a boolean type-guard, not an identity function —
    // Object.entries(object(...)) would always be empty.
    for (const [k, v] of Object.entries(b.tracks)) {
      if (!trackEntry(v)) delete b.tracks[k];
      else safeThumb(v);
    }
    for (const rec of [b.artists, b.albums] as Record<string, any>[]) {
      for (const [k, v] of Object.entries(rec)) { if (!nameEntry(v)) delete rec[k]; else safeThumb(v); }
    }
    b.hours = Array.isArray(b.hours) && b.hours.length === 24
      ? b.hours.map((h: unknown) => (typeof h === "number" && Number.isFinite(h) && h >= 0 ? h : 0))
      : new Array(24).fill(0);
    const days: Record<string, number> = {};
    if (object(b.days)) {
      for (const [d, ms] of Object.entries(b.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) days[d] = ms;
      }
    }
    b.days = days;
    clean.push(b);
  }
  // Retention horizon mirrors the local store.
  state.buckets = clean.sort((a: any, c: any) => (a.month < c.month ? -1 : 1)).slice(-36);
  return JSON.stringify(state.buckets) !== before;
}

export interface CloudRow {
  store_name: string;
  payload: any;
  updated_at?: string;
  /** True when validation dropped/normalized part of the payload. */
  sanitized?: boolean;
}

/**
 * Validate the complete response before any store is replaced. A row that
 * cannot be used (unknown store name, duplicate, stale timestamp, structurally
 * broken or oversized payload) is DROPPED from the result rather than failing
 * the whole restore — the remaining rows still bring the account's data back,
 * and a dropped row degrades to "local copy kept", never to data loss.
 */
export function validateCloudRows(value: unknown, dated: boolean): CloudRow[] {
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  const out: CloudRow[] = [];
  for (const row of value as any[]) {
    if (!object(row)) continue;
    const name = row.store_name;
    if (typeof name !== "string" || !(SYNCED_STORES as readonly string[]).includes(name) || seen.has(name)) continue;
    if (dated && (typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at)))) continue;
    let sanitized = false;
    try {
      sanitized = validateCloudPayload(name, row.payload);
    } catch (err) {
      console.warn(`[bytune] cloud row for "${name}" was unusable and was skipped:`,
        err instanceof Error ? err.message : err);
      continue;
    }
    seen.add(name);
    out.push({
      store_name: name,
      payload: row.payload,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : undefined,
      sanitized,
    });
  }
  return out;
}
