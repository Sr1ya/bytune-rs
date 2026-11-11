/** Album helpers (load + play / queue). */
import { requireBridge } from "./bridge";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

export async function fetchAlbum(albumId: string): Promise<{ title: string; artist: string; year?: string; thumb: string; tracks: Track[] }> {
  const { album, tracks } = await requireBridge().getAlbum(albumId);
  return { title: album.title, artist: album.artist, year: album.year, thumb: album.thumb, tracks };
}

export async function playAlbum(albumId: string): Promise<void> {
  try {
    const { tracks } = await requireBridge().getAlbum(albumId);
    if (!tracks.length) throw new Error("No playable tracks");
    usePlayer.getState().playQueue(tracks, 0);
  } catch {
    useUI.getState().toast("Couldn't load that album", "error");
  }
}

export async function queueAlbum(albumId: string, playNext: boolean): Promise<void> {
  try {
    const { tracks } = await requireBridge().getAlbum(albumId);
    usePlayer.getState().addToQueue(tracks, playNext);
    useUI.getState().toast(playNext ? "Album playing next" : "Album added to queue");
  } catch {
    useUI.getState().toast("Couldn't load that album", "error");
  }
}
