/**
 * Contract between the main window (playback host) and the native PiP
 * miniplayer window. Snapshots flow main → PiP over `pip:state`; commands
 * flow PiP → main over `pip:command` (relayed by the main process).
 */

/** The slice of the current track the compact player renders. */
export interface PipTrackInfo {
  id: string;
  title: string;
  artist: string;
  album: string;
  thumb: string;
}

export interface PipSnapshot {
  track: PipTrackInfo | null;
  playing: boolean;
  buffering: boolean;
  /** seconds */
  position: number;
  /** seconds */
  duration: number;
  /** 0..1 */
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  liked: boolean;
}

export type PipCommand =
  | { type: "toggle" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "seek"; sec: number }
  | { type: "volume"; v: number }
  | { type: "mute" }
  | { type: "shuffle" }
  | { type: "repeat" }
  | { type: "like" }
  /** the shown song's album or artist page, in the main window */
  | { type: "open"; to: "album" | "artist" };
