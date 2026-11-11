/**
 * Listening journal — what became of each song you started: when the listen
 * ended, how long you heard it, and whether you finished it, heard part of it
 * or skipped it early. The Home algorithm's short-term memory
 * (lib/recs/taste.ts), recorded by the audio engine at the one moment a
 * listen's outcome is known (the track switch).
 *
 * On this device and per account (electron/data-transition), wiped by Reset
 * data, never synced. Bounded to the last 600 listens and 60 days; podcast
 * episodes and click-throughs under four seconds never enter it.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import { DAY_MS, outcomeOf, type JournalEntry } from "../lib/recs/taste";
import type { Track } from "../types";

const MAX_ENTRIES = 600;
const KEEP_MS = 60 * DAY_MS;

interface JournalState {
  /** oldest first */
  entries: JournalEntry[];
  /** bumped on every recorded listen — a cheap change signal */
  version: number;
  record(track: Track, heardSec: number, at?: number): void;
}

/** Just what replaying needs: no lyrics, palettes or artist photos in the journal. */
function trimmed(t: Track): Track {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    thumb: t.thumb,
    ...(t.artistId ? { artistId: t.artistId } : {}),
    ...(t.album ? { album: t.album } : {}),
    ...(t.albumId ? { albumId: t.albumId } : {}),
    ...(t.explicit ? { explicit: true } : {}),
    ...(t.localPath ? { localPath: t.localPath } : {}),
  };
}

export const useJournal = create<JournalState>()(
  persist(
    (set, get) => ({
      entries: [],
      version: 0,

      record(track, heardSec, at = Date.now()) {
        if (!track?.id || track.episode) return;
        const out = outcomeOf(heardSec, track.duration);
        if (!out) return;
        const kept = get().entries.filter((e) => at - e.at < KEEP_MS);
        const entries = [...kept, { track: trimmed(track), at, heard: Math.round(heardSec), out }].slice(-MAX_ENTRIES);
        set({ entries, version: get().version + 1 });
      },
    }),
    {
      name: "listen-journal",
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ entries: s.entries }) as unknown as JournalState,
    }
  )
);
