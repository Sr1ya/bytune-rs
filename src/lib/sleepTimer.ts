/**
 * Sleep timer: stop the music after a while, or when the song that's playing
 * ends. The last 10 seconds fade out — the engine multiplies its volume by
 * `level` — and then playback pauses. "End of this song" also stops a
 * crossfade, repeat or AutoPlay from carrying on (lib/audio.ts checks
 * `endOfSong`). Nothing is saved: closing ByTune turns the timer off.
 */
import { create } from "zustand";
import { usePlayer } from "../stores/player";
import { stopHere } from "../stores/room";

export const SLEEP_FADE_MS = 10_000;
export const SLEEP_MAX_MINUTES = 12 * 60;

/** Volume multiplier with `remainingMs` left before the music stops. */
export function sleepFadeLevel(remainingMs: number): number {
  return Math.min(1, Math.max(0, remainingMs / SLEEP_FADE_MS));
}

/** What's left on the timer: "4:05" or "1:02:03". */
export function formatSleepLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Minutes typed into "Custom": "90", "1:30" or "1h 30m". Null when it isn't a time. */
export function parseSleepMinutes(input: string): number | null {
  const t = input.trim().toLowerCase();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  if (/^\d{1,4}$/.test(t)) return Number(t);
  const hm = /^(?:(\d{1,2})\s*h)?\s*(?:(\d{1,3})\s*m(?:in)?)?$/.exec(t);
  if (hm && (hm[1] || hm[2])) return Number(hm[1] ?? 0) * 60 + Number(hm[2] ?? 0);
  return null;
}

interface SleepState {
  /** performance.now() when the timer runs out; null when off or in end-of-song mode */
  endsAt: number | null;
  endOfSong: boolean;
  /** 1 normally, gliding to 0 over the final fade */
  level: number;
  start(minutes: number): void;
  startEndOfSong(): void;
  cancel(): void;
}

let ticker: number | null = null;

function stopTicker(): void {
  if (ticker != null) window.clearInterval(ticker);
  ticker = null;
}

function tick(): void {
  const s = useSleepTimer.getState();
  let level = 1;
  if (s.endsAt != null) {
    const left = s.endsAt - performance.now();
    if (left <= 0) {
      stopTicker();
      // In a room only this computer stops; the room plays on.
      stopHere({ until: "play" }, () => usePlayer.getState().setPlaying(false));
      useSleepTimer.setState({ endsAt: null });
      // Full volume again once the pause has glided out.
      window.setTimeout(() => useSleepTimer.setState({ level: 1 }), 500);
      return;
    }
    level = sleepFadeLevel(left);
  } else if (s.endOfSong) {
    const { position, duration } = usePlayer.getState();
    if (duration > 0) level = sleepFadeLevel((duration - position) * 1000);
  }
  if (level !== s.level) useSleepTimer.setState({ level });
}

export const useSleepTimer = create<SleepState>()((set) => ({
  endsAt: null,
  endOfSong: false,
  level: 1,
  start(minutes) {
    const m = Math.min(SLEEP_MAX_MINUTES, Math.max(1, Math.round(minutes)));
    stopTicker();
    set({ endsAt: performance.now() + m * 60_000, endOfSong: false, level: 1 });
    ticker = window.setInterval(tick, 250);
  },
  startEndOfSong() {
    stopTicker();
    set({ endsAt: null, endOfSong: true, level: 1 });
    ticker = window.setInterval(tick, 250);
  },
  cancel() {
    stopTicker();
    set({ endsAt: null, endOfSong: false, level: 1 });
  },
}));
