/**
 * About-the-artist data for the playing track — the Spotify-panel card.
 *
 * Resolves the artist page the same way the app resolves artist imagery:
 * by the track's artist id when it has one, otherwise by an artist search on
 * the name (never for placeholder credits — "Unknown artist" has no one
 * behind it). The editorial blurb, photo and listener counts come from the
 * same artist page the artist screen shows.
 *
 * Resolutions live in a disk-backed cache (same channel as the artist
 * identity and bundle caches), so reopening the app paints the panel
 * instantly from the last session instead of waiting on a network round
 * trip. The Home feed's bundle refreshes seed this cache too — see
 * seedArtistAbout.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "./persist";
import type { Track } from "../types";

export interface ArtistAbout {
  artistId: string;
  name: string;
  thumb: string | null;
  /** The "About the artist" editorial blurb, when YouTube wrote one. */
  description: string | null;
  /** "332M monthly audience" off the page header — re-worded for display. */
  monthlyListeners: string | null;
  subscriberCount: string | null;
}

const JUNK_ARTIST = "unknown artist";
const MAX_ABOUT = 120;

interface AboutEntry {
  about: ArtistAbout | null;
  at: number;
}

interface AboutCacheState {
  byKey: Record<string, AboutEntry>;
  /** Bumped on rehydrate and on every write — the panel re-reads when the
      disk-backed cache lands (cold start) or a seed arrives. */
  version: number;
  put(key: string, about: ArtistAbout | null): void;
  bump(): void;
}

export const useAboutCache = create<AboutCacheState>()(
  persist(
    (set, get) => ({
      byKey: {},
      version: 0,
      put(key, about) {
        const byKey = { ...get().byKey, [key]: { about, at: Date.now() } };
        const keys = Object.keys(byKey);
        if (keys.length > MAX_ABOUT) {
          keys
            .sort((a, b) => byKey[a].at - byKey[b].at)
            .slice(0, keys.length - MAX_ABOUT)
            .forEach((k) => delete byKey[k]);
        }
        set({ byKey, version: get().version + 1 });
      },
      bump() {
        set({ version: get().version + 1 });
      },
    }),
    {
      name: "artist-about-cache",
      storage: createJSONStorage(() => storage),
      onRehydrateStorage: () => (state) => {
        state?.bump();
      },
    }
  )
);

async function resolveAbout(track: Track): Promise<ArtistAbout | null> {
  try {
    let id = track.artistId ?? null;
    let name = track.artist;
    if (!id) {
      if (!track.artist || track.artist.trim().toLowerCase() === JUNK_ARTIST) return null;
      const res = (await window.bytune?.search(track.artist)) as {
        artists?: Array<{ id?: string; name?: string }>;
      } | null;
      const top = res?.artists?.[0];
      if (!top?.id) return null;
      id = top.id;
      name = top.name || track.artist;
    }
    if (!window.bytune?.getArtist || !id) return null;
    const page = (await window.bytune.getArtist(id)) as {
      artist?: { name?: string; thumb?: string };
      description?: string | null;
      monthlyListeners?: string | null;
      subscriberCount?: string | null;
    } | null;
    if (!page?.artist) return null;
    return {
      artistId: id,
      name: page.artist.name || name,
      thumb: page.artist.thumb ?? null,
      description: page.description ?? null,
      monthlyListeners: page.monthlyListeners ?? null,
      subscriberCount: page.subscriberCount ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Seed the about cache from an artist-page fetch made elsewhere — the Home
 * feed's bundle refreshes read the same page this panel needs, so the
 * playing panel is instant even for artists it has never resolved itself.
 */
export function seedArtistAbout(
  page: {
    artist?: { name?: string; thumb?: string };
    description?: string | null;
    monthlyListeners?: string | null;
    subscriberCount?: string | null;
  },
  artistId: string,
  fallbackName = ""
): void {
  if (!page?.artist || !artistId) return;
  useAboutCache.getState().put(artistId, {
    artistId,
    name: page.artist.name || fallbackName,
    thumb: page.artist.thumb ?? null,
    description: page.description ?? null,
    monthlyListeners: page.monthlyListeners ?? null,
    subscriberCount: page.subscriberCount ?? null,
  });
}

/** The playing track's artist about-card data, cached per artist. */
export function useArtistAbout(track: Track | null): ArtistAbout | null {
  // A podcast episode's "artist" is its show: there is no artist to look up.
  const key = track && !track.episode ? track.artistId ?? `name:${track.artist}` : "";
  const cacheVersion = useAboutCache((s) => s.version);
  const [data, setData] = useState<ArtistAbout | null>(() => {
    if (!key) return null;
    return useAboutCache.getState().byKey[key]?.about ?? null;
  });

  useEffect(() => {
    if (!track || !key) return;
    const hit = useAboutCache.getState().byKey[key];
    if (hit) {
      setData(hit.about);
      return;
    }
    let cancelled = false;
    setData(null);
    void resolveAbout(track).then((res) => {
      useAboutCache.getState().put(key, res);
      if (!cancelled) setData(res);
    });
    return () => {
      cancelled = true;
    };
    // cacheVersion: the disk-backed cache rehydrating (cold start) or a seed
    // landing must re-read before falling back to the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cacheVersion]);

  return data;
}

/** "332M monthly audience" → the chip text the app shows everywhere else. */
export function monthlyListenersLabel(about: ArtistAbout | null): string | null {
  const count = about?.monthlyListeners?.split(" ")[0];
  return count ? `${count} monthly listeners` : null;
}
