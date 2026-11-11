/**
 * Lyric timing: synced lyrics run on the element position as it is, plus the
 * listener's own corrections (this song's nudge, this device's setting), as
 * in BitChord. Nothing is shifted automatically: measuring where the music
 * starts and moving every line there put songs with a quiet intro and a long
 * instrumental outro out of sync (Daylight ran 15.7 s late).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useSettings } from "../stores/settings";
import { storage } from "./persist";

/* ----------------------------- manual timing ----------------------------- */

/** One press of [ or ]: this much earlier or later. */
export const LYRICS_NUDGE_STEP = 0.25;
const NUDGE_LIMIT_SEC = 10;
/** Songs remembered; the oldest nudge goes first. */
const NUDGE_KEEP = 500;

/** A song's nudge after one more step (0 drops it); the oldest entries go past the cap. */
export function nextNudges(nudges: Record<string, number>, id: string, delta: number): Record<string, number> {
  const value = Math.round(Math.min(NUDGE_LIMIT_SEC, Math.max(-NUDGE_LIMIT_SEC, (nudges[id] ?? 0) + delta)) * 100) / 100;
  const rest = Object.entries(nudges).filter(([key]) => key !== id);
  const kept = value === 0 ? rest : [...rest, [id, value] as [string, number]];
  return Object.fromEntries(kept.slice(-NUDGE_KEEP));
}

/** "0.25 s later", "1 s earlier", or "In sync". Positive = lyrics later. */
export function describeLyricsShift(seconds: number): string {
  if (!seconds) return "In sync";
  return `${Math.round(Math.abs(seconds) * 100) / 100} s ${seconds > 0 ? "later" : "earlier"}`;
}

interface LyricsNudgeState {
  /** track id → seconds this song's lyrics run later (+) or earlier (−) */
  nudges: Record<string, number>;
  nudge(id: string, delta: number): void;
  resetNudge(id: string): void;
}

/** Per-song timing the listener set by hand. Kept on this device only. */
export const useLyricsNudge = create<LyricsNudgeState>()(
  persist(
    (set, get) => ({
      nudges: {},
      nudge: (id, delta) => set({ nudges: nextNudges(get().nudges, id, delta) }),
      resetNudge: (id) => set({ nudges: nextNudges(get().nudges, id, -(get().nudges[id] ?? 0)) }),
    }),
    { name: "lyrics-nudges", storage: createJSONStorage(() => storage) },
  ),
);

/** Seconds to subtract from the element position for lyrics: this song's nudge and this device's timing. */
export function useLyricsOffset(id: string | null | undefined): number {
  const nudge = useLyricsNudge((s) => s.nudges[id ?? ""] ?? 0);
  const device = useSettings((s) => s.lyricsOffset);
  return nudge + device;
}
