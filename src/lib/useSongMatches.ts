/**
 * Matches songs from elsewhere (a Spotify playlist, an imported list) to YouTube Music, four at a
 * time, filling the page in as answers come. Answers are kept for the session (main remembers them
 * for longer), so coming back is instant; leaving the page stops whatever hasn't started.
 */
import { useEffect, useState } from "react";
import { requireBridge } from "./bridge";
import type { ImportSong, Track } from "../types";

export type MatchState =
  | { state: "matching" }
  | { state: "matched"; track: Track }
  /** YouTube Music has no song that is this one */
  | { state: "missing" }
  /** the search itself failed (offline); retried on request */
  | { state: "failed" };

const known = new Map<string, MatchState>();
const keyOf = (s: ImportSong, prefer: string): string => `${s.spotifyId ?? `${s.title}|${s.artist}|${s.duration}`}|${prefer}`;

export function useSongMatches(songs: ImportSong[] | null, prefer: string, attempt: number): MatchState[] {
  const [states, setStates] = useState<MatchState[]>([]);
  useEffect(() => {
    if (!songs) {
      setStates([]);
      return;
    }
    let live = true;
    const out: MatchState[] = songs.map((s) => known.get(keyOf(s, prefer)) ?? { state: "matching" });
    setStates([...out]);
    const todo = out.flatMap((s, i) => (s.state === "matching" ? [i] : []));
    let cursor = 0;
    let frame = 0;
    // One render per frame, however many answers land in it.
    const show = (): void => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        if (live) setStates([...out]);
      });
    };
    const worker = async (): Promise<void> => {
      while (live && cursor < todo.length) {
        const i = todo[cursor++];
        try {
          const track = await requireBridge().matchSong(songs[i], prefer);
          out[i] = track ? { state: "matched", track } : { state: "missing" };
          known.set(keyOf(songs[i], prefer), out[i]);
        } catch {
          out[i] = { state: "failed" };
        }
        show();
      }
    };
    for (let n = 0; n < 4; n++) void worker();
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [songs, prefer, attempt]);
  return states;
}
