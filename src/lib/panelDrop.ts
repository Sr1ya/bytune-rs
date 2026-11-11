/**
 * Panel-level drop routing — the whole middle surface (the rounded panel)
 * accepts song drops whenever the open page is a container that can hold
 * them: a playlist, Liked Songs, or the local folder view. Everything else
 * (home, search, artist pages…) stays a non-target and keeps the OS
 * "blocked" cursor.
 *
 * Only TRACK drags are accepted — artist/playlist/album drags pass through
 * untouched (see useTrackDrop). The hovering flag drives the full-panel
 * highlight App renders inside the main surface, same design as the
 * sidebar's row highlight (ring-accent/60 + ink tint).
 */
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { LocalFolderEntry } from "../shared/backend-types";
import type { Track } from "../types";
import { getDownload, startDownload } from "./downloads";
import { draggingFromPlaylist, useTrackDrop } from "./dnd";
import { addSongsToPlaylists } from "./devicePlaylists";
import { shortTitle } from "./format";

/** A song dropped on one of your playlists (the open one, or a card of it): added, or already there. */
export function addSongToPlaylist(playlistId: string, track: Track): void {
  const name = useLibrary.getState().playlists.find((p) => p.id === playlistId)?.name ?? "playlist";
  const { added, told } = addSongsToPlaylists([playlistId], [track]);
  if (!told) useUI.getState().toast(added ? `Added to "${name}"` : `Already in "${name}"`, added ? "success" : "info");
}

function likeTrack(track: Track): void {
  const lib = useLibrary.getState();
  if (lib.liked.some((t) => t.id === track.id)) {
    useUI.getState().toast("Already in Liked Songs", "info");
    return;
  }
  lib.toggleLike(track);
  useUI.getState().toast("Added to Liked Songs", "success");
}

/** A streamed song dropped on the folder page downloads straight into it. */
function downloadIntoLocalFolder(track: Track, target?: string | null): void {
  void (async () => {
    const lib = await window.bytune?.localLibrary();
    const entries = lib?.folders ?? [];
    // The open collection is the drop target; the overall fallback is the
    // first imported folder. Entries may still be legacy bare-string paths.
    const first = entries[0] as LocalFolderEntry | string | undefined;
    const fallback = typeof first === "string" ? first : first?.path;
    const folder = target && target !== "all" ? target : fallback;
    if (!folder) {
      useUI.getState().toast("Set up a local folder first", "info");
      return;
    }
    if (track.localPath || track.id.startsWith("local:")) {
      useUI.getState().toast("That song is already in your local library", "info");
      return;
    }
    await startDownload(track, folder);
    // startDownload refuses silently when the track is already saved or
    // already in flight — only claim the toast and watch for the file when a
    // download actually began, or the toast lied and the listener lingered
    // (rescanning on some future, unrelated download).
    if (getDownload(track.id)?.status !== "queued") {
      return;
    }
    useUI.getState().toast(`Downloading "${shortTitle(track.title)}" into the folder`, "success");
    // Rescan when the file lands, then tell the open view to refresh. Cancel
    // counts as terminal too — the listener must not outlive its download.
    const off = window.bytune?.onDownloadEvent?.((e) => {
      if (e.type === "done" || e.type === "failed" || e.type === "cancelled") {
        off?.();
        if (e.type === "done") {
          void window.bytune
            ?.scanLibrary(useSettings.getState().filterNonMusicAudio)
            .then((res) => window.dispatchEvent(new CustomEvent("bytune:local-library-updated", { detail: res })));
        }
      }
    });
  })().catch(() => undefined);
}

export function usePanelDrop(): {
  hovering: boolean;
  props: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  // The panel is only a target while the open page can hold songs.
  const accepts = (): boolean => {
    const v = useUI.getState().view;
    return (
      // A playlist's own song moves within its list; it is never added to it again.
      (v.name === "playlist" && !!v.param && !draggingFromPlaylist(v.param)) ||
      (v.name === "library" && v.param === "liked") ||
      v.name === "local"
    );
  };
  return useTrackDrop((track) => {
    const view = useUI.getState().view;
    if (view.name === "playlist" && view.param) addSongToPlaylist(view.param, track);
    else if (view.name === "library" && view.param === "liked") likeTrack(track);
    else if (view.name === "local") downloadIntoLocalFolder(track, view.param);
  }, accepts);
}
