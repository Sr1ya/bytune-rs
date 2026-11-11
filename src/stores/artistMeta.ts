/**
 * Artist identity cache — name → { id, photo }.
 *
 * Listening stats aggregate artists by name only; the Home feed needs their
 * YouTube artist page (for navigation, photos and discography candidates).
 * Resolutions are looked up once and cached for weeks, persisted through the
 * desktop bridge so restarts never re-search the same names.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import { requireBridge } from "../lib/bridge";

export interface ArtistMeta {
  id: string;
  /** The found artist's own spelling ("Mumford & Sons"); "" when the search gave none. */
  name?: string;
  thumb: string | null;
  resolvedAt: number;
}

interface ArtistMetaState {
  byName: Record<string, ArtistMeta>;
  put(nameKey: string, meta: ArtistMeta): void;
}

const MAX_ENTRIES = 400;
const FRESH_MS = 30 * 86_400_000;

export const useArtistMeta = create<ArtistMetaState>()(
  persist(
    (set, get) => ({
      byName: {},

      put(nameKey, meta) {
        const byName = { ...get().byName, [nameKey]: meta };
        // Bounded: drop the oldest resolutions first.
        const keys = Object.keys(byName);
        if (keys.length > MAX_ENTRIES) {
          keys
            .sort((a, b) => byName[a].resolvedAt - byName[b].resolvedAt)
            .slice(0, keys.length - MAX_ENTRIES)
            .forEach((k) => delete byName[k]);
        }
        set({ byName });
      },
    }),
    {
      name: "artist-meta-cache",
      storage: createJSONStorage(() => storage),
    }
  )
);

/** Cached artist photo/id for a name, or null — never throws. */
export function peekArtistMeta(name: string): ArtistMeta | null {
  const hit = useArtistMeta.getState().byName[name.trim().toLowerCase()];
  return hit ?? null;
}

/**
 * Resolve an artist name to its YouTube identity. Free path first (the
 * store), then one search. Results persist; failures stay null and are
 * retried on a later run. `withName` searches again for an entry cached
 * before the found artist's name was kept.
 */
export async function resolveArtistMeta(name: string, withName = false): Promise<ArtistMeta | null> {
  const key = name.trim().toLowerCase();
  if (!key || key === "unknown artist") return null;
  const cached = useArtistMeta.getState().byName[key];
  if (cached && Date.now() - cached.resolvedAt < FRESH_MS && (!withName || cached.name !== undefined)) return cached;
  try {
    const res = await requireBridge().search(name);
    const top = res.artists?.[0];
    if (!top?.id) return null;
    const meta: ArtistMeta = { id: top.id, name: top.name || "", thumb: top.thumb ?? null, resolvedAt: Date.now() };
    useArtistMeta.getState().put(key, meta);
    return meta;
  } catch {
    return null;
  }
}
