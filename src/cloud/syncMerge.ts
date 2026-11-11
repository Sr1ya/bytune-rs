/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Record-level merge for synced stores — pure functions, unit-testable.
 * ByTune's electron/sync-merge.ts, unchanged but for its imports.
 *
 * Philosophy: the store-level "newest wins" rule is safe for whole-store
 * replacement, but when BOTH sides changed since the last sync we merge
 * records where semantics allow it (likes, playlists, history, searches,
 * skip tallies) so independent edits on two devices survive. Device-owned
 * fields (download registry, machine paths) never travel to the cloud at
 * all — merge re-attaches the local copy untouched.
 *
 * All functions operate on the zustand-persist envelope: { state, version }.
 * Inputs may be arbitrary JSON (never trusted) — every function defensively
 * falls back to the local copy when a payload has the wrong shape.
 */

import { readDeletionSync, joinDeletionSync, compactDeletionSync, mergeDeletionRecords,
  membershipSurvives, searchKey, deletionKey } from "../lib/deletion-sync";

type Envelope = { state?: Record<string, unknown>; version?: number } | null | unknown;

function stateOf(payload: Envelope): Record<string, unknown> {
  if (payload && typeof payload === "object" && (payload as any).state && typeof (payload as any).state === "object") {
    return (payload as any).state as Record<string, unknown>;
  }
  return {};
}

function envelope(state: Record<string, unknown>, version = 0): { state: Record<string, unknown>; version: number } {
  return { state, version };
}

/** Never downgrade a zustand envelope (library's existing schema is v1). */
function mergedVersion(a: Envelope, b: Envelope, minimum = 0): number {
  const valid = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  return Math.max(minimum, valid((a as any)?.version), valid((b as any)?.version));
}

const trackId = (t: any): string => (t && typeof t === "object" && typeof t.id === "string" ? t.id : "");

/* ------------------------------------------------------------------ */
/* Library — liked, playlists, folders, follows, history               */
/* ------------------------------------------------------------------ */

/**
 * Merge two library states using explicit membership timestamps. Absence is
 * not deletion; legacy records union. Adds order newest-first, stable id ties;
 * metadata edits resolve by timestamp then canonical JSON. `downloads` and
 * other device-owned fields come only from `localDevice` — the cloud copy
 * can never overwrite or inject them.
 */
export function mergeLibrary(
  localPayload: Envelope,
  remotePayload: Envelope,
  localDevice: Record<string, unknown>
): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);

  const am = readDeletionSync(local.deletionSync), bm = readDeletionSync(remote.deletionSync);
  const joined = joinDeletionSync(am, bm);
  const liked = mergeDeletionRecords(local.liked, remote.liked, am, bm, joined, "liked", trackId);
  const history = mergeDeletionRecords(local.history, remote.history, am, bm, joined, "history", trackId, undefined, 200);
  const folders = mergeDeletionRecords(local.folders, remote.folders, am, bm, joined, "folders", trackId);
  const followedArtists = mergeDeletionRecords(local.followedArtists, remote.followedArtists, am, bm, joined, "followedArtists", trackId);
  const localPlaylists = Array.isArray(local.playlists) ? local.playlists : [];
  const remotePlaylists = Array.isArray(remote.playlists) ? remote.playlists : [];
  // Track contents are merged independently, not part of the metadata tie
  // breaker (otherwise unioning children could change the next merge winner).
  const metadata = (items: any[]) => items.filter((item) => trackId(item)).map(({ tracks: _tracks, ...item }) => item);
  const playlists = mergeDeletionRecords<any>(metadata(localPlaylists), metadata(remotePlaylists), am, bm, joined, "playlists", trackId)
    .map((p) => {
      // A deleted/rejected parent cannot supply old children on recreation.
      const tracks = (items: any[], meta: typeof am) => membershipSurvives(meta, joined, "playlists", p.id)
        ? items.filter((item) => trackId(item) === p.id).flatMap((item) => Array.isArray(item.tracks) ? item.tracks : []) : [];
      const survivors = mergeDeletionRecords(tracks(localPlaylists, am), tracks(remotePlaylists, bm),
        am, bm, joined, "tracks", trackId, p.id);
      const side = (items: any[]) => items.find((item) => trackId(item) === p.id);
      const [lp, rp] = [side(localPlaylists), side(remotePlaylists)];
      const next = { ...p, tracks: inPlaylistOrder(survivors, am, bm, p.id, lp, rp) };
      const orderedAt = Math.max(Number(lp?.orderedAt) || 0, Number(rp?.orderedAt) || 0);
      if (orderedAt) next.orderedAt = orderedAt;
      else delete next.orderedAt;
      // Deleted folders unfile, never delete their playlists.
      if (next.folderId && !folders.some((f) => f.id === next.folderId)) delete next.folderId;
      return next;
    });

  // Shortcut pins: this device's choice wins, except a set saved before the current defaults (no
  // v2, "pinned" for every row) loses to a v2 set from the cloud. Missing keys read as the defaults
  // (isPinned in src/stores/library.ts).
  const localPins = (local.pinnedSingles ?? {}) as Record<string, unknown>;
  const remotePins = (remote.pinnedSingles ?? {}) as Record<string, unknown>;
  const pinnedSingles = remotePins.v2 && !localPins.v2 ? { ...localPins, ...remotePins } : { ...remotePins, ...localPins };

  const state = {
    ...remote, ...local, liked, history, playlists, folders, followedArtists, pinnedSingles,
    // Device-owned: always the local copy, never the cloud's.
    downloads: localDevice.downloads ?? local.downloads ?? {},
  };
  return envelope({ ...state, deletionSync: compactDeletionSync(joined, state) }, mergedVersion(localPayload, remotePayload, 1));
}

/**
 * A merged playlist's song order. When either side has put the songs in its
 * own order (orderedAt), the newer order wins and songs it doesn't know yet
 * follow in the order they were added. Otherwise playlists play in the order
 * songs were added (oldest first) — sorting newest first reversed every
 * playlist on a two-sided merge. A pure, symmetric function of both sides, so
 * every device converges on the same order and re-merging changes nothing.
 * Songs without stamps (older data) tie at 0 and fall back to id order.
 */
function inPlaylistOrder(
  survivors: any[],
  am: ReturnType<typeof readDeletionSync>,
  bm: ReturnType<typeof readDeletionSync>,
  playlistId: string,
  local?: any,
  remote?: any
): any[] {
  const addedAt = (id: string): number =>
    Math.max(am.adds[deletionKey("tracks", id, playlistId)] ?? 0, bm.adds[deletionKey("tracks", id, playlistId)] ?? 0);
  const byAdded = (x: any, y: any): number =>
    addedAt(trackId(x)) - addedAt(trackId(y)) || (trackId(x) < trackId(y) ? -1 : trackId(x) > trackId(y) ? 1 : 0);
  const order = (p: any): string[] => (Array.isArray(p?.tracks) ? p.tracks.map(trackId) : []);
  const [la, ra] = [Number(local?.orderedAt) || 0, Number(remote?.orderedAt) || 0];
  if (!la && !ra) return [...survivors].sort(byAdded);
  // Newer explicit order wins; equal stamps fall back to a fixed tie-break.
  const lo = order(local).join("\u0000");
  const ro = order(remote).join("\u0000");
  const base = la > ra || (la === ra && lo <= ro) ? order(local) : order(remote);
  const rank = new Map(base.map((id, i) => [id, i]));
  const known = survivors.filter((t) => rank.has(trackId(t))).sort((x, y) => rank.get(trackId(x))! - rank.get(trackId(y))!);
  const fresh = survivors.filter((t) => !rank.has(trackId(t))).sort(byAdded);
  return [...known, ...fresh];
}

/* ------------------------------------------------------------------ */
/* Listening signals — skip tallies, take the max per artist           */
/* ------------------------------------------------------------------ */

export function mergeListening(localPayload: Envelope, remotePayload: Envelope): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);
  const a = (local.skips ?? {}) as Record<string, { count?: number; updatedAt?: number }>;
  const b = (remote.skips ?? {}) as Record<string, { count?: number; updatedAt?: number }>;
  const skips: Record<string, { count: number; updatedAt: number }> = {};
  for (const [artist, entry] of Object.entries({ ...a, ...b })) {
    const la = a[artist];
    const rb = b[artist];
    const count = Math.max(la?.count ?? 0, rb?.count ?? 0);
    if (count <= 0) continue;
    skips[artist] = { count, updatedAt: Math.max(la?.updatedAt ?? 0, rb?.updatedAt ?? 0) };
  }
  return envelope({
    ...remote,
    ...local,
    skips,
    version: Math.max(Number(local.version) || 0, Number(remote.version) || 0),
  }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* Recent searches — versioned membership, newest addition first       */
/* ------------------------------------------------------------------ */

export function mergeRecentSearches(localPayload: Envelope, remotePayload: Envelope): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);
  const am = readDeletionSync(local.deletionSync), bm = readDeletionSync(remote.deletionSync);
  const joined = joinDeletionSync(am, bm);
  const searches = mergeDeletionRecords<string>(local.searches, remote.searches, am, bm, joined, "searches",
    (q) => typeof q === "string" ? searchKey(q) : "", undefined, 8);
  const state = { ...remote, ...local, searches };
  return envelope({ ...state, deletionSync: compactDeletionSync(joined, state) }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* Settings — newest wins for account fields, device fields preserved  */
/* ------------------------------------------------------------------ */

/** Fields that describe THIS machine — stripped before upload, never pulled. */
/** Settings that belong to this machine: paths, and the output device id
 *  (another computer's audio device id means nothing here), and what closing
 *  this computer's window does. */
export const DEVICE_SETTINGS_FIELDS = ["downloadDir", "localMusicFolder", "audioSinkId", "lyricsOffset", "closeToTray"] as const;

export function stripDeviceSettings(payload: Envelope): { state: Record<string, unknown>; version: number } {
  const state = stateOf(payload);
  const clean = { ...state };
  for (const f of DEVICE_SETTINGS_FIELDS) delete clean[f];
  return envelope(clean, Number((payload as any)?.version) || 0);
}

export function mergeSettings(
  localPayload: Envelope,
  remotePayload: Envelope,
  localDevice: Record<string, unknown>
): { state: Record<string, unknown>; version: number } {
  const remote = stripDeviceSettings(remotePayload);
  const local = stateOf(localPayload);
  return envelope({ ...remote.state, ...local, ...localDevice }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* Listening history (Replay) — per month bucket, max per record        */
/* ------------------------------------------------------------------ */

/**
 * Merge two Replay month-bucket sets. Listening time is additive on one
 * device but must not double count across devices, so per record the side
 * with more listened ms wins (same policy as mergeListening's skip tallies).
 * Hours-of-day and per-day totals are maxed per slot for the same reason.
 */
export function mergeListeningHistory(localPayload: Envelope, remotePayload: Envelope): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);
  const toMap = (v: unknown): Map<string, any> => {
    const out = new Map<string, any>();
    for (const b of Array.isArray(v) ? v : []) {
      if (b && typeof b === "object" && typeof (b as any).month === "string") out.set((b as any).month, b);
    }
    return out;
  };
  const a = toMap(local.buckets);
  const b = toMap(remote.buckets);

  const mergeNamed = (x: any, y: any): any => (!x ? y : !y ? x : (y.ms ?? 0) > (x.ms ?? 0) ? y : x);
  /** Per record (one track, artist or album) — comparing whole maps kept only
   *  this device's map and dropped the other device's listening. */
  const mergeRecords = (x: unknown, y: unknown): Record<string, any> => {
    const xs = x && typeof x === "object" ? (x as Record<string, any>) : {};
    const ys = y && typeof y === "object" ? (y as Record<string, any>) : {};
    const out: Record<string, any> = {};
    for (const key of new Set([...Object.keys(xs), ...Object.keys(ys)])) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = mergeNamed(xs[key], ys[key]);
    }
    return out;
  };
  const buckets: any[] = [];
  for (const [month, lb] of a) {
    const rb = b.get(month);
    if (!rb) { buckets.push(lb); continue; }
    buckets.push({
      month,
      tracks: mergeRecords(lb.tracks, rb.tracks),
      artists: mergeRecords(lb.artists, rb.artists),
      albums: mergeRecords(lb.albums, rb.albums),
      hours: Array.from({ length: 24 }, (_v, i) => Math.max(Number(lb?.hours?.[i]) || 0, Number(rb?.hours?.[i]) || 0)),
      days: (() => {
        const days: Record<string, number> = {};
        for (const [d, ms] of Object.entries({ ...(rb?.days ?? {}), ...(lb?.days ?? {}) })) {
          days[d] = Math.max(Number((rb?.days ?? {})[d]) || 0, Number((lb?.days ?? {})[d]) || 0);
        }
        return days;
      })(),
    });
  }
  for (const [month, rb] of b) if (!a.has(month)) buckets.push(rb);
  buckets.sort((x, y) => (x.month < y.month ? -1 : 1));

  return envelope({ ...remote, ...local, buckets }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* Artist identity cache — union by name, freshest resolution wins      */
/* ------------------------------------------------------------------ */

export function mergeArtistMeta(localPayload: Envelope, remotePayload: Envelope): { state: Record<string, unknown>; version: number } {
  const local = stateOf(localPayload);
  const remote = stateOf(remotePayload);
  const a = (local.byName ?? {}) as Record<string, { resolvedAt?: number }>;
  const b = (remote.byName ?? {}) as Record<string, { resolvedAt?: number }>;
  const byName: Record<string, { resolvedAt?: number }> = {};
  for (const [name, meta] of [...Object.entries(a), ...Object.entries(b)]) {
    const cur = byName[name];
    if (!cur || (meta?.resolvedAt ?? 0) > (cur.resolvedAt ?? 0)) byName[name] = meta;
  }
  return envelope({ ...remote, ...local, byName }, mergedVersion(localPayload, remotePayload));
}

/* ------------------------------------------------------------------ */
/* sync-meta — merge the running session's mirror with the disk copy   */
/* ------------------------------------------------------------------ */

export interface SyncMetaEntry {
  syncedAt: number;
  changedAt: number;
}

export interface SyncMetaSnapshot {
  stores: Record<string, SyncMetaEntry>;
  lastUserId?: string;
}

/**
 * mergeSyncMeta(disk, memory) → the meta a sync run should use. Per store the
 * FRESHEST timestamps win: `changedAt` records "this store has local edits the
 * cloud has not seen", so letting a stale on-disk copy roll it backwards is
 * exactly how a store edited moments before a concurrent sync stops looking
 * modified — and a stale cloud copy then wins the next pull comparison.
 * `lastUserId` comes from memory, which reflects any runtime account switch.
 */
export function mergeSyncMeta(disk: SyncMetaSnapshot, memory: SyncMetaSnapshot): SyncMetaSnapshot {
  const stores: Record<string, SyncMetaEntry> = {};
  const names = new Set([...Object.keys(disk.stores ?? {}), ...Object.keys(memory.stores ?? {})]);
  for (const name of names) {
    const a = disk.stores?.[name];
    const b = memory.stores?.[name];
    stores[name] = {
      syncedAt: Math.max(a?.syncedAt ?? 0, b?.syncedAt ?? 0),
      changedAt: Math.max(a?.changedAt ?? 0, b?.changedAt ?? 0),
    };
  }
  return { stores, lastUserId: memory.lastUserId ?? disk.lastUserId };
}
