/**
 * The room the listener is in, as main last told it (lib/rooms keeps it current). A store of its
 * own so the player, the audio engine and AutoPlay can ask "in a room?" without depending on the
 * room logic, which depends on them.
 */
import { create } from "zustand";
import type { RoomView } from "../types";

export const useRoom = create<{ view: RoomView; busy: boolean }>(() => ({ view: { state: null, me: null, offsetMs: 0 }, busy: false }));

export const inRoom = (): boolean => useRoom.getState().view.state !== null;

/**
 * Why this computer stopped on its own while a room plays on: until the listener presses play (the
 * output went away, the sleep timer), or for one song it can't play (it plays the room's next one).
 */
export type LocalStop = { until: "play" } | { until: "next song"; song: string };

let stopping: LocalStop | null = null;

/** A stop only this computer makes: in a room it stays here, and the room plays on. */
export function stopHere(why: LocalStop, change: () => void): void {
  stopping = why;
  try {
    change();
  } finally {
    stopping = null;
  }
}

export const stoppingHere = (): LocalStop | null => stopping;
