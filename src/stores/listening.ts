/**
 * Listening outcome signals — the "didn't want this" counterweight to play
 * counts. The audio engine reports a track's fate when the listener leaves
 * it early; we tally skips per artist so the recommendation engine can
 * demote artists the user keeps skipping (stores/listening → lib/recs).
 *
 * Deliberately tiny: one map keyed by lowercased artist name plus a version
 * counter the profile layer uses as a cheap change signal.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import type { Track } from "../types";

export interface SkipEntry {
  count: number;
  updatedAt: number;
}

interface ListeningState {
  /** lowercased artist name → skip tally */
  skips: Record<string, SkipEntry>;
  /** bumped on every recorded outcome — lets consumers react without diffing */
  version: number;

  recordSkip(track: Track): void;
  skipCount(artist: string): number;
}

const MAX_ARTISTS = 300;

export function artistKey(artist: string): string {
  return artist.trim().toLowerCase();
}

export const useListening = create<ListeningState>()(
  persist(
    (set, get) => ({
      skips: {},
      version: 0,

      recordSkip(track) {
        if (!track.artist || track.artist.trim().toLowerCase() === "unknown artist") return;
        const key = artistKey(track.artist);
        const skips = { ...get().skips };
        const cur = skips[key] ?? { count: 0, updatedAt: 0 };
        skips[key] = { count: cur.count + 1, updatedAt: Date.now() };

        // Keep the tally bounded — drop the stillest entries first.
        const keys = Object.keys(skips);
        if (keys.length > MAX_ARTISTS) {
          keys
            .sort((a, b) => skips[a].updatedAt - skips[b].updatedAt)
            .slice(0, keys.length - MAX_ARTISTS)
            .forEach((k) => delete skips[k]);
        }

        set({ skips, version: get().version + 1 });
      },

      skipCount(artist) {
        return get().skips[artistKey(artist)]?.count ?? 0;
      },
    }),
    {
      name: "listening-signals",
      storage: createJSONStorage(() => storage),
    }
  )
);

/** The audio engine's skip rule, shared with the listening journal (lib/recs/taste). */
export { isEarlyExit } from "../lib/recs/taste";
