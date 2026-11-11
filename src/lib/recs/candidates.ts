/**
 * Candidate generation — the raw material the section builder ranks.
 *
 * For each artist the taste profile cares about we resolve their YouTube
 * page once and keep it: top songs (mix/radio/station queues), album cards
 * ("Albums featuring songs you like") and the related-artists shelf
 * ("Fans might also like" — the seed of every "More like X" section).
 *
 * Bundles live in a module cache with a 12h TTL and in-flight dedupe, so a
 * burst of Home rebuilds never re-fetches the same artist, and sections can
 * rebuild instantly from cache whenever the underlying signals move.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { requireBridge } from "../../lib/bridge";
import { storage } from "../persist";
import { seedArtistAbout } from "../artistAbout";
import type { Album, Artist, ArtistPageData, HomeItem, Track } from "../../types";

export interface ArtistBundle {
  artistId: string;
  name: string;
  thumb: string | null;
  topSongs: Track[];
  albums: Album[];
  related: Artist[];
  fetchedAt: number;
}

const TTL_MS = 12 * 3_600_000;

/* ---------------------------------------------------- persisted bundle cache */
/* Bundles live in a disk-backed store (same channel as the artist-identity
   cache) with the 12h freshness TTL and in-flight dedupe as before — plus,
   the point of persistence: a fresh app launch paints every artist-derived
   cover (favorite artists, mixes, albums, stations, the About panel) straight
   from the last session's artist pages instead of re-fetching six artist
   pages over the network before a single cover shows. Entries past the TTL
   stay readable for that instant paint and are refreshed in the background
   by the next getArtistBundle call. */
const MAX_BUNDLES = 24;

interface BundleEntry {
  bundle: ArtistBundle;
  at: number;
}

interface BundleCacheState {
  byId: Record<string, BundleEntry>;
  /** Bumped on rehydrate and on every write — lets the Home feed repaint
      wave 0 the moment the disk-backed cache lands. */
  version: number;
  put(artistId: string, bundle: ArtistBundle): void;
  bump(): void;
}

export const useBundleCache = create<BundleCacheState>()(
  persist(
    (set, get) => ({
      byId: {},
      version: 0,
      put(artistId, bundle) {
        const byId = { ...get().byId, [artistId]: { bundle, at: Date.now() } };
        const keys = Object.keys(byId);
        if (keys.length > MAX_BUNDLES) {
          keys
            .sort((a, b) => byId[a].at - byId[b].at)
            .slice(0, keys.length - MAX_BUNDLES)
            .forEach((k) => delete byId[k]);
        }
        set({ byId, version: get().version + 1 });
      },
      bump() {
        set({ version: get().version + 1 });
      },
    }),
    {
      name: "artist-bundle-cache",
      storage: createJSONStorage(() => storage),
      onRehydrateStorage: () => (state) => {
        state?.bump();
      },
    }
  )
);

/** Reactive read of the cache generation — components watching this repaint
    when the disk-backed cache rehydrates or a background refresh lands. */
export function useBundleCacheVersion(): number {
  return useBundleCache((s) => s.version);
}

const inflight = new Map<string, Promise<ArtistBundle | null>>();

function harvest(page: ArtistPageData, artistId: string): ArtistBundle {
  const items: HomeItem[] = page.shelves.flatMap((s) => s.items);

  const albums: Album[] = [];
  const seenAlbums = new Set<string>();
  for (const item of items) {
    const album = item.kind === "album" ? item.album : undefined;
    if (!album || seenAlbums.has(album.id)) continue;
    seenAlbums.add(album.id);
    albums.push(album);
  }

  const related: Artist[] = [];
  const seenRelated = new Set<string>([artistId]);
  for (const item of items) {
    const artist = item.kind === "artist" ? item.artist : undefined;
    if (!artist || seenRelated.has(artist.id)) continue;
    seenRelated.add(artist.id);
    related.push(artist);
  }

  return {
    artistId,
    name: page.artist.name,
    thumb: page.artist.thumb ?? null,
    // Bounded for the persisted snapshot — mixes/stations/radios read the
    // top of this list, never the tail.
    topSongs: (page.songs ?? []).slice(0, 24),
    albums: albums.slice(0, 14),
    related: related.slice(0, 12),
    fetchedAt: Date.now(),
  };
}

export async function getArtistBundle(artistId: string): Promise<ArtistBundle | null> {
  if (!artistId) return null;
  const hit = useBundleCache.getState().byId[artistId];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bundle;

  const pending = inflight.get(artistId);
  if (pending) return pending;

  const task = (async () => {
    try {
      const page = await requireBridge().getArtist(artistId);
      if (!page?.artist) return null;
      const bundle = harvest(page, artistId);
      useBundleCache.getState().put(artistId, bundle);
      // The artist page carries the About-panel fields too — seed the
      // persisted about cache so the playing panel is instant for this
      // artist even if it has never resolved them itself.
      seedArtistAbout(page, artistId);
      return bundle;
    } catch {
      return null;
    } finally {
      inflight.delete(artistId);
    }
  })();
  inflight.set(artistId, task);
  return task;
}

/** Synchronous read of whatever is cached — lets the feed paint stale-first. */
export function peekBundle(artistId: string | null | undefined): ArtistBundle | null {
  if (!artistId) return null;
  return useBundleCache.getState().byId[artistId]?.bundle ?? null;
}

/** Enforce the entry cap (drop the least recently fetched). TTL-expired
 *  bundles deliberately survive pruning: they are the instant cold-start
 *  paint, and getArtistBundle refreshes them in the background. */
export function pruneBundles(): void {
  const { byId } = useBundleCache.getState();
  const keys = Object.keys(byId);
  if (keys.length <= MAX_BUNDLES) return;
  const next = { ...byId };
  keys
    .sort((a, b) => byId[a].at - byId[b].at)
    .slice(0, keys.length - MAX_BUNDLES)
    .forEach((k) => delete next[k]);
  useBundleCache.setState({ byId: next });
}
