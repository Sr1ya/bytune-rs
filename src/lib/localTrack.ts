import type { LocalTrack } from "../shared/backend-types";
import type { Track } from "../types";

/** A file on this device as a song the player and lists use. */
export function localToTrack(t: LocalTrack): Track & { mtime: number } {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    thumb: t.art ?? "",
    // No localPath: the `local:` id already marks and routes local songs, and
    // these tracks end up in likes, playlists and history, which sync — an
    // absolute path (C:\Users\<name>\…) must never reach the account.
    mtime: t.mtime,
  };
}
