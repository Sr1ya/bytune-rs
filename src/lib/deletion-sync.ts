/**
 * Membership versions shared by the renderer and the pure cloud merge.
 *
 * Only explicit adds advance `adds`; renaming/pinning/moving uses `edits` and
 * cannot resurrect a deleted membership. A delete wins an equal-time add.
 * Legacy records have add time zero (absence is NOT a deletion).
 *
 * Tombstones are count-bounded, never time-expired. When compacted, `floor`
 * advances to the newest discarded deletion. A snapshot below that floor may
 * contribute only additions newer than the floor. Records already present in
 * a snapshot AT the floor are certified survivors, without fabricating newer
 * add times (which would incorrectly defeat concurrent deletes). Thus stale
 * cloud copies cannot resurrect compacted deletions. Trade-off: very old,
 * unsynced additions below the floor must be explicitly added again. This is
 * not an indefinitely-offline CRDT; that requires device acknowledgements or
 * unbounded tombstones. Whole-store replacement/reset must retain or knowingly
 * discard this metadata along with its account data.
 *
 * Metadata is O(live memberships + TOMBSTONE_LIMIT); clears have two fixed
 * slots. Clock values are monotonic within an observed snapshot, not a global
 * clock: offline devices with skewed clocks resolve by timestamp, delete on
 * ties. No merge consults wall time or invents an addition.
 */
export const TOMBSTONE_LIMIT = 512;
export type DeletionGroup = "liked" | "playlists" | "tracks" | "folders" | "followedArtists" | "history" | "searches";
export interface DeletionSync {
  schema: 1;
  clock: number;
  floor: number;
  adds: Record<string, number>;
  deletes: Record<string, number>;
  edits: Record<string, number>;
  clears: Record<string, number>;
}
export interface DeletionChange {
  kind: "add" | "delete" | "edit" | "clear";
  group: DeletionGroup;
  id?: string;
  parent?: string;
}
const groups = new Set(["liked", "playlists", "tracks", "folders", "followedArtists", "history", "searches"]);
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const time = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1 ? value : 0;
export const searchKey = (q: string): string => q.trim().toLowerCase();
export const deletionKey = (group: DeletionGroup, id: string, parent?: string): string =>
  JSON.stringify(group === "tracks" ? [group, parent ?? "", id] : [group, group === "searches" ? searchKey(id) : id]);

function validKey(key: string): boolean {
  try {
    const parts = JSON.parse(key);
    return Array.isArray(parts) && groups.has(parts[0]) && parts.length === (parts[0] === "tracks" ? 3 : 2)
      && parts.slice(1).every((part: unknown) => typeof part === "string" && part.length > 0);
  } catch { return false; }
}
function times(value: unknown, clears = false): Record<string, number> {
  return Object.fromEntries(Object.entries(object(value)).filter(([key, value]) =>
    (clears ? key === "history" || key === "searches" : validKey(key)) && time(value) > 0
  ).sort(([a], [b]) => compare(a, b)));
}
export function readDeletionSync(value: unknown): DeletionSync {
  const raw = object(value);
  if (raw.schema !== 1) return { schema: 1, clock: 0, floor: 0, adds: {}, deletes: {}, edits: {}, clears: {} };
  const adds = times(raw.adds), deletes = times(raw.deletes), edits = times(raw.edits), clears = times(raw.clears, true);
  let clock = Math.max(time(raw.clock), time(raw.floor));
  for (const map of [adds, deletes, edits, clears]) for (const t of Object.values(map)) clock = Math.max(clock, t);
  return { schema: 1, clock, floor: time(raw.floor), adds, deletes, edits, clears };
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function maxTimes(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compare)
    .map((key) => [key, Math.max(a[key] ?? 0, b[key] ?? 0)]));
}
/** Do not compact until records have been filtered using ALL input markers. */
export function joinDeletionSync(a: DeletionSync, b: DeletionSync): DeletionSync {
  return { schema: 1, clock: Math.max(a.clock, b.clock), floor: Math.max(a.floor, b.floor),
    adds: maxTimes(a.adds, b.adds), deletes: maxTimes(a.deletes, b.deletes),
    edits: maxTimes(a.edits, b.edits), clears: maxTimes(a.clears, b.clears) };
}
function liveKeys(state: unknown): Set<string> {
  const s = object(state), keys = new Set<string>();
  for (const group of groups) {
    if (group === "tracks") continue;
    for (const item of Array.isArray(s[group]) ? s[group] : []) {
      const id = group === "searches" ? (typeof item === "string" ? searchKey(item) : "") : object(item).id;
      if (typeof id !== "string" || !id) continue;
      keys.add(deletionKey(group as DeletionGroup, id));
      if (group === "playlists") for (const track of Array.isArray(item.tracks) ? item.tracks : []) {
        if (typeof track?.id === "string" && track.id) keys.add(deletionKey("tracks", track.id, id));
      }
    }
  }
  return keys;
}
export function compactDeletionSync(meta: DeletionSync, state: unknown): DeletionSync {
  const live = liveKeys(state);
  const tombstones = Object.entries(meta.deletes).sort(([ak, at], [bk, bt]) => bt - at || compare(ak, bk));
  let floor = meta.floor;
  for (const [, t] of tombstones.slice(TOMBSTONE_LIMIT)) floor = Math.max(floor, t);
  const keepLive = (map: Record<string, number>) => Object.fromEntries(Object.entries(map)
    .filter(([key]) => live.has(key)).sort(([a], [b]) => compare(a, b)));
  return { ...meta, floor, adds: keepLive(meta.adds), edits: keepLive(meta.edits),
    deletes: Object.fromEntries(tombstones.filter(([, t]) => t > floor).sort(([a], [b]) => compare(a, b))) };
}
/** Called ONLY for user mutations, never for an unchanged hydration/merge. */
export function recordDeletionChanges(state: unknown, next: object, changes: DeletionChange[]): DeletionSync {
  const s = object(state), meta = readDeletionSync(s.deletionSync);
  const at = Math.max(Date.now(), meta.clock + 1);
  meta.clock = at;
  for (const change of changes) {
    if (change.kind === "clear") {
      if (change.group === "history" || change.group === "searches") meta.clears[change.group] = at;
      continue;
    }
    if (!change.id) continue;
    const key = deletionKey(change.group, change.id, change.parent);
    meta[change.kind === "add" ? "adds" : change.kind === "delete" ? "deletes" : "edits"][key] = at;
  }
  return compactDeletionSync(meta, { ...s, ...next });
}

/** Stable JSON tie-breaker: independent of object insertion order and locale. */
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined)
    .sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function membershipSurvives(meta: DeletionSync, joined: DeletionSync, group: DeletionGroup, id: string, parent?: string): boolean {
  const key = deletionKey(group, id, parent), added = meta.adds[key] ?? 0;
  return (meta.floor >= joined.floor || added > joined.floor)
    && added > (joined.deletes[key] ?? -1) && added > (joined.clears[group] ?? -1);
}
/** Timestamp order, stable id ties; latest metadata edit wins, then stable JSON. */
export function mergeDeletionRecords<T>(a: unknown, b: unknown, am: DeletionSync, bm: DeletionSync,
  joined: DeletionSync, group: DeletionGroup, idOf: (item: T) => string, parent?: string, cap?: number): T[] {
  const records = new Map<string, { item: T; added: number; edited: number }>();
  for (const [input, meta] of [[a, am], [b, bm]] as const) {
    for (const item of Array.isArray(input) ? input : []) {
      const id = idOf(item);
      if (!id || !membershipSurvives(meta, joined, group, id, parent)) continue;
      const key = deletionKey(group, id, parent), added = meta.adds[key] ?? 0;
      const edited = Math.max(added, meta.edits[key] ?? 0), old = records.get(id);
      const winner = !old || edited > old.edited || (edited === old.edited && canonical(item) < canonical(old.item));
      records.set(id, { item: winner ? item : old!.item, added: Math.max(added, old?.added ?? 0),
        edited: winner ? edited : old!.edited });
    }
  }
  return [...records.entries()].sort(([ak, a], [bk, b]) => b.added - a.added || compare(ak, bk))
    .slice(0, cap).map(([, value]) => value.item);
}
