/**
 * How you use Home: which kinds of rows you play from, and the songs you
 * marked "Not interested". The feed (lib/recs/sections) lets the rows you use
 * rise — taps fade with a 10-day half-life, so the order follows what you do
 * now — and keeps hidden songs off Home while their artist steps back.
 *
 * On this device and per account (electron/data-transition), wiped by Reset
 * data, never synced.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import { DAY_MS, artistKeyOf, fadedCount } from "../lib/recs/taste";
import type { Track } from "../types";

export const TAP_HALF_LIFE = 10 * DAY_MS;
/** A "Not interested" song stays off Home this long. */
const HIDE_FOR_MS = 180 * DAY_MS;
const MAX_HIDDEN = 500;

interface Faded {
  n: number;
  at: number;
}

interface HomeEngagementState {
  /** row kind → taps, faded as of `at` */
  taps: Record<string, Faded>;
  /** song id → when it was marked "Not interested" */
  hiddenTracks: Record<string, number>;
  /** artist key → "Not interested" marks on their songs, faded as of `at` */
  hiddenArtists: Record<string, Faded>;
  /** bumped on every hide — Home rebuilds at once; taps wait for the next visit */
  hiddenVersion: number;
  tap(kind: string): void;
  hide(track: Track): void;
}

export const useHomeEngagement = create<HomeEngagementState>()(
  persist(
    (set, get) => ({
      taps: {},
      hiddenTracks: {},
      hiddenArtists: {},
      hiddenVersion: 0,

      tap(kind) {
        if (!kind) return;
        const now = Date.now();
        const taps = { ...get().taps, [kind]: { n: fadedCount(get().taps[kind], now, TAP_HALF_LIFE) + 1, at: now } };
        set({ taps });
      },

      hide(track) {
        const now = Date.now();
        const hiddenTracks: Record<string, number> = { [track.id]: now };
        // Newest first; expired marks and the overflow drop off.
        for (const [id, at] of Object.entries(get().hiddenTracks).sort((a, b) => b[1] - a[1])) {
          if (id !== track.id && now - at < HIDE_FOR_MS && Object.keys(hiddenTracks).length < MAX_HIDDEN) hiddenTracks[id] = at;
        }
        const key = artistKeyOf(track.artist);
        const hiddenArtists = { ...get().hiddenArtists };
        if (key) hiddenArtists[key] = { n: fadedCount(hiddenArtists[key], now, 30 * DAY_MS) + 1, at: now };
        set({ hiddenTracks, hiddenArtists, hiddenVersion: get().hiddenVersion + 1 });
      },
    }),
    {
      name: "home-engagement",
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ taps: s.taps, hiddenTracks: s.hiddenTracks, hiddenArtists: s.hiddenArtists }) as unknown as HomeEngagementState,
    }
  )
);

/** Taps per row kind as of `now`. */
export function tapsNow(taps: Readonly<Record<string, Faded>>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(taps).map(([kind, f]) => [kind, fadedCount(f, now, TAP_HALF_LIFE)]));
}

/** The "Not interested" songs still in force. */
export function hiddenNow(hiddenTracks: Readonly<Record<string, number>>, now: number): Set<string> {
  return new Set(Object.entries(hiddenTracks).filter(([, at]) => now - at < HIDE_FOR_MS).map(([id]) => id));
}
