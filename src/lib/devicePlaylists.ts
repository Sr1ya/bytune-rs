/**
 * Songs from this computer never sync: they can't play anywhere else. A
 * playlist keeps them on this device and syncs the rest of its songs
 * (electron/sync.ts leaves them out of the account copy and puts them back
 * after a restore); a playlist made only of them stays on this device
 * altogether. Every way of putting songs into a playlist goes through here.
 */
import { useLibrary, type Playlist } from "../stores/library";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { shortTitle } from "./format";
import { useSession } from "./session";

export const isLocalSong = (t: Track): boolean => t.id.startsWith("local:");

/** Every song is from this computer: the playlist stays on this device altogether. */
export const staysOnDevice = (p: Playlist): boolean => p.tracks.length > 0 && p.tracks.every(isLocalSong);

/** The first time in a session it's a popup; after that a toast, so adding ten songs isn't ten popups. */
let explained = false;
function tell(body: string): void {
  if (explained) {
    useUI.getState().toast(body, "info", 6000);
    return;
  }
  explained = true;
  useUI.getState().openDialog({ title: "Kept on this device", body, notice: true, confirmLabel: "OK", onConfirm: () => undefined });
}

/** What happens to the songs from this computer just put into these playlists. */
function explain(playlists: Playlist[], local: Track[]): void {
  if (playlists.length === 1 && staysOnDevice(playlists[0])) {
    tell(`"${playlists[0].name}" stays on this device: all its songs are from this computer, so it doesn't sync.`);
    return;
  }
  const songs = local.length === 1 ? `"${shortTitle(local[0].title)}" stays` : `These ${local.length} songs stay`;
  const where = playlists.length === 1 ? `"${playlists[0].name}" syncs` : "the playlists sync";
  tell(`${songs} on this device. Songs from this computer don't sync, so ${where} to your account without ${local.length === 1 ? "it" : "them"}.`);
}

/**
 * Put songs into playlists. Signed in, songs from this computer come with a
 * word that they stay on this device while the rest of the playlist syncs
 * (without an account nothing syncs, so nothing to say). `told` means that
 * message went out, so the caller adds none of its own.
 */
export function addSongsToPlaylists(playlistIds: string[], tracks: Track[]): { added: number; told: boolean } {
  let added = 0;
  const gotLocal: Playlist[] = [];
  for (const id of playlistIds) {
    const went = tracks.filter((t) => useLibrary.getState().addToPlaylist(id, t));
    added += went.length;
    const p = useLibrary.getState().playlists.find((pl) => pl.id === id);
    if (p && went.some(isLocalSong)) gotLocal.push(p);
  }
  if (!gotLocal.length || useSession.getState().mode !== "account") return { added, told: false };
  explain(gotLocal, tracks.filter(isLocalSong));
  return { added, told: true };
}

/** A new playlist for these songs. */
export function newPlaylistWith(name: string, tracks: Track[]): Playlist {
  const created = useLibrary.getState().createPlaylist(name);
  for (const t of tracks) useLibrary.getState().addToPlaylist(created.id, t);
  const playlist = useLibrary.getState().playlists.find((p) => p.id === created.id) ?? created;
  if (useSession.getState().mode === "account" && tracks.some(isLocalSong)) explain([playlist], tracks.filter(isLocalSong));
  return playlist;
}
