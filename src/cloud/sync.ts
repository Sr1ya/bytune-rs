/**
 * Cloud backup — a port of ByTune's electron/sync.ts, run in the main window.
 *
 * Replicates the synced stores to Supabase for signed-in users. The local copy is always the working
 * source of truth: writes push out (debounced), sign-in merges/pulls in. Cloud request failure is never
 * treated as "empty account" — local data is kept, the failure is surfaced in sync status, and pushes
 * retry. Any pull that overwrites local data writes a backup of the losing version first (data/backups,
 * the backend keeps the newest few per store), so sync can never silently destroy data.
 *
 * Device-owned data (download registry, machine paths, this machine's settings) is stripped before
 * upload and re-attached from the local copy on pull — it never travels.
 *
 * Account switching: sync-meta records the last account that synced here. Signing in as a DIFFERENT
 * account wipes local account-owned stores first (they're safe in the previous account's cloud space)
 * so data can never leak from account A into account B. Guest → first account keeps local data and
 * migrates it up.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SYNCED_STORES } from "../lib/config";
import { backupStore, readStore, tell, writeStore } from "./backend";
import { getClient, liveUserId, sessionInfo } from "./auth";
import { validateCloudRows } from "./cloudPayload";
import { serializeData } from "./queue";
import {
  DEVICE_SETTINGS_FIELDS,
  mergeArtistMeta,
  mergeLibrary,
  mergeListening,
  mergeListeningHistory,
  mergeRecentSearches,
  mergeSettings,
  mergeSyncMeta,
  stripDeviceSettings,
} from "./syncMerge";

const PUSH_DEBOUNCE_MS = 10_000;
const RETRY_MS = 30_000;
const HISTORY_STORE = "listening-history";
/** What of Replay's history travels: the newest months that fit (ByTune's stats.fitForSync). */
const SYNC_BUDGET_BYTES = 6 * 1024 * 1024;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncAt: number | null = null;
let lastError: string | null = null;
let syncing = false;
let restoreSeq = 0;
let restoredStores: string[] = [];

interface StoreMeta {
  syncedAt: number;
  changedAt: number;
}
interface SyncMeta {
  stores: Record<string, StoreMeta>;
  lastUserId?: string;
}

/** In-memory mirror of sync-meta — updated on every local write. */
let meta: SyncMeta = { stores: {} };

function noteRestored(stores: string[]): void {
  if (stores.length === 0) return;
  restoredStores = stores;
  restoreSeq += 1;
  tell("sync:restored", { stores, seq: restoreSeq });
}

export async function loadMeta(): Promise<SyncMeta> {
  const raw = (await readStore("sync-meta")) as unknown;
  if (!raw || typeof raw !== "object") return { stores: {} };
  const obj = raw as Record<string, unknown>;
  const stores: Record<string, StoreMeta> = {};
  if (obj.stores && typeof obj.stores === "object") {
    for (const [k, v] of Object.entries(obj.stores as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const m = v as Record<string, unknown>;
        stores[k] = { syncedAt: Number(m.syncedAt) || 0, changedAt: Number(m.changedAt) || 0 };
      }
    }
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "lastUserId") continue;
      if (typeof v === "number") stores[k] = { syncedAt: v, changedAt: 0 };
    }
  }
  return { stores, lastUserId: typeof obj.lastUserId === "string" ? obj.lastUserId : undefined };
}

/** Boot: the meta on disk becomes the session's mirror. */
export async function initSync(): Promise<void> {
  meta = mergeSyncMeta(await loadMeta(), meta);
}

/**
 * A store going from clean to dirty reaches disk immediately: `changedAt > syncedAt` is what tells
 * the next boot "this store has local edits the cloud has not seen". Later writes to an already-dirty
 * store only move `changedAt` in memory; every push saves meta, and quitting saves it too.
 */
function saveMeta(): Promise<void> {
  return writeStore("sync-meta", meta).catch((err) => console.warn("[bytune] sync-meta save failed:", err));
}

/** Called inside the data queue after outgoing work has completed (an account switch). */
export async function resetSyncState(userId?: string): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  meta = { stores: {}, lastUserId: userId };
  lastSyncAt = null;
  lastError = null;
  restoredStores = [];
  await saveMeta();
}

/** Quitting: record every local edit made this session as unsynced, so the next boot pushes it. */
export function flushMeta(): Promise<void> {
  return saveMeta();
}

function storeMeta(name: string): StoreMeta {
  return meta.stores[name] ?? { syncedAt: 0, changedAt: 0 };
}

export function isSyncedStore(name: string): boolean {
  return (SYNCED_STORES as readonly string[]).includes(name);
}

export type SyncState = "idle" | "syncing" | "pending" | "error";

export function syncStatus() {
  const state: SyncState = syncing ? "syncing" : lastError ? "error" : timers.size > 0 ? "pending" : "idle";
  return { mode: sessionInfo().mode, lastSyncAt, restoreSeq, restoredStores, state, lastError, pending: timers.size };
}

/** Called on every local write of a store (the page's, and Replay's from the backend). */
export function noteLocalWrite(name: string): void {
  if (!isSyncedStore(name)) return;
  if (sessionInfo().mode !== "account") return;
  const m = storeMeta(name);
  meta.stores[name] = { ...m, changedAt: Date.now() };
  if (m.changedAt <= m.syncedAt) void saveMeta(); // clean → dirty: the edge the next boot must see
  schedulePush(name);
}

function schedulePush(name: string, delayMs = PUSH_DEBOUNCE_MS): void {
  const prev = timers.get(name);
  if (prev) clearTimeout(prev);
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      void serializeData(() => pushStore(name)).catch((err) => onSyncFailure(err, name));
    }, delayMs)
  );
}

/** A failed push never drops the change — surface it and retry later. */
function onSyncFailure(err: unknown, name?: string): void {
  lastError = err instanceof Error ? err.message : String(err);
  console.warn(`[bytune] sync${name ? ` ${name}` : ""} failed (will retry):`, lastError);
  if (!retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushPending();
    }, RETRY_MS);
  }
}

/** A sync failure outside the push path (a sign-in or sign-out backup), so the account card says so. */
export function noteSyncFailure(err: unknown): void {
  lastError = err instanceof Error ? err.message : String(err);
}

/** A store envelope with one state key left out. */
function withoutKey(envelope: unknown, key: string): unknown {
  const e = envelope as { state?: Record<string, unknown> };
  if (!e?.state || !(key in e.state)) return envelope;
  const { [key]: _drop, ...state } = e.state;
  return { ...(envelope as object), state };
}

/** A track without its absolute file path (older local songs carried one). */
function withoutPath(track: unknown): unknown {
  if (!track || typeof track !== "object" || !("localPath" in track)) return track;
  const { localPath: _path, ...rest } = track as Record<string, unknown>;
  return rest;
}

/** Replay's newest months that fit the cloud row (local retention is untouched). */
function fitForSync(payload: unknown): unknown {
  const buckets = (payload as { state?: { buckets?: unknown } } | null)?.state?.buckets;
  if (!Array.isArray(buckets)) return payload;
  const size = (b: unknown[]): number => new TextEncoder().encode(JSON.stringify({ state: { buckets: b }, version: 1 })).length;
  let out = buckets;
  while (out.length > 0 && size(out) > SYNC_BUDGET_BYTES) out = out.slice(1);
  if (out === buckets) return payload;
  return { ...(payload as object), state: { buckets: out } };
}

/** Device-owned fields never leave the machine. */
function stripForUpload(name: string, data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const envelope = data as { state?: Record<string, unknown>; version?: number };
  if (!envelope.state) return data;
  if (name === "library") {
    const { downloads: _drop, ...keep } = envelope.state;
    const tracks = (list: unknown): unknown => (Array.isArray(list) ? list.map(withoutPath) : list);
    return {
      ...envelope,
      state: {
        ...keep,
        liked: tracks(keep.liked),
        history: tracks(keep.history),
        // Songs from this computer never leave it: a playlist uploads without them, and one made
        // only of them doesn't upload at all.
        playlists: Array.isArray(keep.playlists)
          ? keep.playlists
              .filter((p) => !staysOnDevice(p))
              .map((p) => {
                if (!p || typeof p !== "object") return p;
                const { device: _device, ...rest } = p as Record<string, unknown>;
                return { ...rest, tracks: tracksOf(p).filter((t) => !isLocalTrack(t)).map(withoutPath) };
              })
          : keep.playlists,
      },
    };
  }
  if (name === "settings") return stripDeviceSettings(data);
  if (name === HISTORY_STORE) return fitForSync(data);
  return data;
}

const idOf = (item: unknown): unknown => (item as { id?: unknown } | null)?.id;
const isLocalTrack = (t: unknown): boolean => typeof idOf(t) === "string" && (idOf(t) as string).startsWith("local:");
const tracksOf = (p: unknown): unknown[] => {
  const list = (p as { tracks?: unknown } | null)?.tracks;
  return Array.isArray(list) ? list : [];
};
/** Every song is from this computer: the playlist stays on this device altogether. */
const staysOnDevice = (p: unknown): boolean => tracksOf(p).length > 0 && tracksOf(p).every(isLocalTrack);

/** The cloud copy's songs, with this device's songs from this computer put back where they were. */
function withLocalSongs(remote: unknown[], here: unknown[]): unknown[] {
  const out = remote.filter((t) => !isLocalTrack(t));
  let anchor: unknown = null;
  let run = 0;
  for (const t of here) {
    if (!isLocalTrack(t)) {
      anchor = idOf(t);
      run = 0;
      continue;
    }
    const at = anchor === null ? -1 : out.findIndex((o) => idOf(o) === anchor);
    out.splice(at + 1 + run, 0, t);
    run += 1;
  }
  return out;
}

/** Local device-owned fields, re-attached after any pull. */
async function localDeviceState(name: string): Promise<Record<string, unknown>> {
  const local = (await readStore(name)) as { state?: Record<string, unknown> } | null;
  const state = local?.state ?? {};
  if (name === "library") {
    const playlists = Array.isArray(state.playlists) ? state.playlists.filter((p) => tracksOf(p).some(isLocalTrack)) : [];
    return { downloads: state.downloads ?? {}, localPlaylists: playlists };
  }
  if (name === "settings") {
    const out: Record<string, unknown> = {};
    for (const f of DEVICE_SETTINGS_FIELDS) {
      if (state[f] !== undefined) out[f] = state[f];
    }
    return out;
  }
  return {};
}

/** A cloud copy that replaces a local store, with this device's own fields put back. */
function withDeviceState(name: string, payload: unknown, device: Record<string, unknown>): unknown {
  const state = (payload as { state?: Record<string, unknown> })?.state;
  if (!state || Object.keys(device).length === 0) return payload;
  if (name !== "library") return { ...(payload as object), state: { ...state, ...device } };
  const { localPlaylists, ...fields } = device;
  const mine = Array.isArray(localPlaylists) ? localPlaylists : [];
  const here = new Map(mine.map((p) => [idOf(p), p]));
  const remote = Array.isArray(state.playlists) ? state.playlists : [];
  const remoteIds = new Set(remote.map(idOf));
  const playlists = [
    ...mine.filter((p) => staysOnDevice(p) && !remoteIds.has(idOf(p))),
    ...remote.map((p) => (here.has(idOf(p)) ? { ...(p as object), tracks: withLocalSongs(tracksOf(p), tracksOf(here.get(idOf(p)))) } : p)),
  ];
  return { ...(payload as object), state: { ...state, ...fields, playlists } };
}

/** Merge a fresh cloud payload into the local store when both sides changed. */
async function mergeStore(name: string, local: unknown, remote: unknown): Promise<{ state: Record<string, unknown>; version: number } | null> {
  const localDevice = await localDeviceState(name);
  switch (name) {
    case "library":
      return mergeLibrary(local, remote, localDevice);
    case "listening-signals":
      return mergeListening(local, remote);
    case "listening-history":
      return mergeListeningHistory(local, remote);
    case "artist-meta-cache":
      return mergeArtistMeta(local, remote);
    case "recent-searches":
      return mergeRecentSearches(local, remote);
    case "settings":
      return mergeSettings(local, remote, localDevice);
    default:
      return null;
  }
}

async function pushStore(name: string, sb?: SupabaseClient, userId?: string): Promise<void> {
  const sbc = sb ?? getClient();
  // Cloud writes must act as a live, verified identity — never the stale profile fallback.
  const uid = userId ?? (await liveUserId());
  if (!sbc || !uid) return;
  const data = await readStore(name);
  if (data == null) return;
  const { error } = await sbc
    .from("user_data")
    .upsert(
      { user_id: uid, store_name: name, payload: stripForUpload(name, data), updated_at: new Date().toISOString() },
      { onConflict: "user_id,store_name" }
    );
  if (error) throw new Error(error.message);
  meta.stores[name] = { syncedAt: Date.now(), changedAt: Date.now() };
  await saveMeta();
  lastSyncAt = Date.now();
  lastError = null;
}

/**
 * Full two-way merge, run after sign-in / at boot. Per store:
 *  - only local → push up (guest migration, fresh edits)
 *  - only cloud  → pull down (new device, reset)
 *  - both        → record-level merge where semantics allow, else newest wins
 * Every overwrite of local data is backed up first.
 */
export function syncNow(): Promise<{ pushed: string[]; pulled: string[]; merged: string[] }> {
  return serializeData(syncNowExclusive);
}

export async function syncNowExclusive(): Promise<{ pushed: string[]; pulled: string[]; merged: string[] }> {
  const sbc = getClient();
  const userId = await liveUserId();
  if (!sbc || !userId || syncing) return { pushed: [], pulled: [], merged: [] };
  syncing = true;
  const restored = new Set<string>();
  try {
    const { data: rows, error } = await sbc.from("user_data").select("store_name,payload,updated_at").eq("user_id", userId);
    if (error) throw new Error("Cloud backup could not be read.");
    const validatedRows = validateCloudRows(rows, true);
    meta = mergeSyncMeta(await loadMeta(), meta);
    if (meta.lastUserId && meta.lastUserId !== userId) {
      // Account switch — wipe local account-owned stores so A's data can never leak into B.
      for (const name of SYNCED_STORES) {
        const local = await readStore(name);
        if (local != null) {
          await backupStore(name, local);
          await writeStore(name, null);
        }
        restored.add(name);
        delete meta.stores[name];
      }
    }
    meta.lastUserId = userId;
    await saveMeta();

    const cloud = new Map<string, { payload: unknown; updatedAt: number; sanitized: boolean }>();
    for (const row of validatedRows) {
      cloud.set(String(row.store_name), {
        payload: row.payload,
        updatedAt: new Date(String(row.updated_at)).getTime(),
        sanitized: row.sanitized === true,
      });
    }

    const pushed: string[] = [];
    const pulled: string[] = [];
    const merged: string[] = [];
    for (const name of SYNCED_STORES) {
      // (Replay's backend writes what it holds in memory before this read: cloud:read flushes it.)
      const local = await readStore(name);
      const m = storeMeta(name);
      const remoteRow = cloud.get(name);
      const remote = remoteRow ? { payload: remoteRow.payload, updatedAt: remoteRow.updatedAt } : undefined;
      const cloudHealed = remoteRow?.sanitized === true;
      // A store never synced but holding local data counts as locally changed (guest → account).
      const localChanged = local != null && (m.changedAt > m.syncedAt || m.syncedAt === 0);
      const remoteChanged = remote != null && remote.updatedAt > m.syncedAt;

      if (local == null && remote) {
        await writeStore(name, remote.payload);
        restored.add(name);
        meta.stores[name] = { syncedAt: remote.updatedAt, changedAt: remote.updatedAt };
        pulled.push(name);
        if (cloudHealed) await pushStore(name, sbc, userId);
        continue;
      }
      if (local == null || !remote) {
        if (local != null) {
          await pushStore(name, sbc, userId);
          pushed.push(name);
        }
        continue;
      }
      if (remoteChanged && localChanged) {
        await backupStore(name, local);
        await backupStore(name, remote.payload);
        // A fresh install's first sync: its AutoPlay value is only the new default, so the
        // account's own choice wins rather than being overwritten on every device.
        const firstSettings = name === "settings" && m.syncedAt === 0 && local && typeof local === "object";
        const localForMerge = firstSettings ? withoutKey(local, "autoplay") : local;
        const mergedEnvelope = await mergeStore(name, localForMerge, remote.payload);
        const next = mergedEnvelope ?? (remote.updatedAt > m.syncedAt ? remote.payload : local);
        await writeStore(name, next);
        restored.add(name);
        await pushStore(name, sbc, userId);
        meta.stores[name] = { syncedAt: Date.now(), changedAt: Date.now() };
        merged.push(name);
        continue;
      }
      if (remoteChanged) {
        await backupStore(name, local);
        const payload = withDeviceState(name, remote.payload, await localDeviceState(name));
        await writeStore(name, payload);
        restored.add(name);
        meta.stores[name] = { syncedAt: remote.updatedAt, changedAt: remote.updatedAt };
        pulled.push(name);
        if (cloudHealed) await pushStore(name, sbc, userId);
        continue;
      }
      if (localChanged) {
        await backupStore(name, remote.payload);
        await pushStore(name, sbc, userId);
        pushed.push(name);
      }
    }
    await saveMeta();
    lastSyncAt = Date.now();
    lastError = null;
    return { pushed, pulled, merged };
  } finally {
    syncing = false;
    noteRestored([...restored]);
  }
}

/** Manual "Back up now" — push every synced store immediately. */
export function backupNow(): Promise<void> {
  return serializeData(async () => {
    const sbc = getClient();
    const userId = await liveUserId();
    if (!sbc || !userId) throw new Error("Sign in first.");
    for (const name of SYNCED_STORES) await pushStore(name, sbc, userId);
    lastSyncAt = Date.now();
    lastError = null;
  });
}

/** Manual "Restore from cloud" — cloud always wins (except device-owned fields). */
export function restoreNow(): Promise<string[]> {
  return serializeData(async () => {
    const sbc = getClient();
    const userId = await liveUserId();
    if (!sbc || !userId) throw new Error("Sign in first.");
    const { data: rows, error } = await sbc.from("user_data").select("store_name,payload").eq("user_id", userId);
    if (error) throw new Error("Cloud backup could not be read.");
    const validatedRows = validateCloudRows(rows, false);
    const pulled: string[] = [];
    try {
      for (const row of validatedRows) {
        const name = String(row.store_name);
        if (!isSyncedStore(name)) continue;
        const local = await readStore(name);
        await backupStore(name, local);
        const payload = withDeviceState(name, row.payload, await localDeviceState(name));
        await writeStore(name, payload);
        pulled.push(name);
        meta.stores[name] = { syncedAt: Date.now(), changedAt: Date.now() };
        if (row.sanitized) await pushStore(name, sbc, userId);
      }
      await saveMeta();
      lastSyncAt = Date.now();
      return pulled;
    } finally {
      noteRestored(pulled);
    }
  });
}

/** Flush pending pushes right away (sign-out, quit, retry timer). */
export async function flushPending(): Promise<void> {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  for (const [, t] of timers) clearTimeout(t);
  timers.clear();
  try {
    if (sessionInfo().userId) await syncNow();
  } catch (err) {
    onSyncFailure(err);
  }
}

/** Replay's history was written by the backend (its 30 s flush). (When the cloud replaces that store,
    `cloud:write` makes the backend drop its in-memory copy, as ByTune's stats.reloadStore did.) */
export function noteHistoryWritten(): void {
  noteLocalWrite(HISTORY_STORE);
}
