/** Playlist helpers (fetch + play). */
import { requireBridge } from "./bridge";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

export async function playPlaylist(playlistId: string): Promise<void> {
  const ui = useUI.getState();
  try {
    ui.toast("Loading playlist…");
    const { tracks } = await requireBridge().getPlaylist(playlistId);
    if (!tracks.length) throw new Error("No playable tracks");
    usePlayer.getState().playQueue(tracks, 0);
  } catch {
    useUI.getState().toast("Couldn't load that playlist", "error");
  }
}
