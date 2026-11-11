/**
 * The collection pages (Liked Songs, a folder, Downloads, Local Music, your playlists): the covers
 * their cover wall shows, the facts under their title, which left-panel row is the page open in the
 * middle panel, and folders: a new one opens in the middle panel to be filled, and a playlist or album
 * dropped on one is filed or imported into it.
 */
import type { DragEvent } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { dragHasAlbum, dragHasPlaylist, readAlbum, readPlaylist } from "./dnd";
import { requireBridge } from "./bridge";
import { fmtTotal, plural, shortTitle } from "./format";
import { useLibrary, type LibraryFolder } from "../stores/library";
import { useUI, type MenuItem, type View } from "../stores/ui";
import type { Track } from "../types";

/** A folder's options (left panel, Your Library, its page): rename it, or delete it, its playlists going back to Your Library. */
export function folderMenuItems(folder: LibraryFolder, afterDelete?: () => void): MenuItem[] {
  return [
    {
      label: "Rename folder",
      icon: Pencil,
      action: () =>
        useUI.getState().openDialog({
          title: "Rename folder",
          initialValue: folder.name,
          placeholder: "Folder name",
          confirmLabel: "Save",
          onConfirm: (value) => useLibrary.getState().renameFolder(folder.id, value),
        }),
    },
    {
      label: "Delete folder",
      icon: Trash2,
      danger: true,
      action: () => {
        useLibrary.getState().deleteFolder(folder.id);
        afterDelete?.();
      },
    },
  ];
}

/** Up to `count` covers for a cover wall: each distinct cover once, in order, then round again. */
export function wallCovers(thumbs: ReadonlyArray<string | null | undefined>, count: number): string[] {
  const distinct = [...new Set(thumbs.filter((t): t is string => !!t))];
  return distinct.length ? Array.from({ length: count }, (_, i) => distinct[i % distinct.length]) : [];
}

export interface CollectionFacts {
  songs: string;
  /** "7 hr 12 min"; null when no song's length is known */
  length: string | null;
  /** the artist with the most songs here, when that's 3 or more */
  topArtist: { name: string; songs: number } | null;
}

/**
 * How many songs, how long, and who's in it most. A song counts for its lead artist (its artist id),
 * named by the shortest credit among their songs: "The Weeknd", not "The Weeknd, Daft Punk", and
 * never cut at a comma ("Tyler, The Creator"). Without an id, only identical credits count together.
 */
export function collectionFacts(tracks: Track[]): CollectionFacts {
  const seconds = tracks.reduce((sum, t) => sum + (t.duration > 0 ? t.duration : 0), 0);
  const artists = new Map<string, { name: string; songs: number }>();
  for (const t of tracks) {
    if (!t.artist) continue;
    const key = t.artistId || t.artist;
    const seen = artists.get(key);
    if (!seen) artists.set(key, { name: t.artist, songs: 1 });
    else {
      seen.songs++;
      if (t.artist.length < seen.name.length) seen.name = t.artist;
    }
  }
  let topArtist: CollectionFacts["topArtist"] = null;
  for (const a of artists.values()) if (a.songs >= 3 && a.songs > (topArtist?.songs ?? 0)) topArtist = a;
  return { songs: plural(tracks.length, "song", "songs"), length: seconds > 0 ? fmtTotal(seconds) : null, topArtist };
}

/** Whether a left-panel row is the page open in the middle panel. */
export function rowIsOpen(row: { id: string; kind: string; artistId?: string }, view: View): boolean {
  switch (view.name) {
    case "library":
      return (view.param === "liked" && row.id === "__liked__") || (view.param === "downloaded" && row.kind === "downloads");
    case "downloads":
    case "local":
    case "replay":
    case "spotify":
      return row.kind === view.name;
    case "playlist":
    case "folder":
      return row.kind === view.name && row.id === view.param;
    case "artist":
      return (row.kind === "artist" && row.id === view.param) || (row.kind === "playlist" && !!row.artistId && row.artistId === view.param);
    default:
      return false;
  }
}

/** Asks for a name (the numbered default filled in), then makes the folder and opens it to be filled. */
export function askForNewFolder(): void {
  const suggested = `New Folder ${useLibrary.getState().folders.length + 1}`;
  useUI.getState().openDialog({
    title: "New folder",
    body: "Give your folder a name.",
    initialValue: suggested,
    placeholder: "Folder name",
    confirmLabel: "Create",
    onConfirm: (value) => {
      const folder = useLibrary.getState().createFolder(value.trim() || suggested);
      useUI.getState().navigate({ name: "folder", param: folder.id });
    },
  });
}

/** A playlist or album dropped on a folder: one of yours is filed in it; one from YouTube is imported into it. */
export function dropOnFolder(e: DragEvent, folder: LibraryFolder): void {
  if (!dragHasPlaylist(e) && !dragHasAlbum(e)) return;
  e.preventDefault();
  e.stopPropagation();
  const lib = useLibrary.getState();
  const ui = useUI.getState();
  const imported = (title: string, tracks: Track[]): void => {
    const seen = new Set<string>();
    const unique = tracks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    if (!unique.length) throw new Error("no tracks");
    const created = lib.importPlaylist(title, unique, folder.id);
    ui.toast(`“${created.name}” · ${unique.length} songs added to “${folder.name}”`, "success");
  };
  if (dragHasPlaylist(e)) {
    const pl = readPlaylist(e);
    if (!pl) return;
    const own = lib.playlists.find((p) => p.id === pl.id);
    if (own) {
      if (own.folderId === folder.id) return;
      lib.setPlaylistFolder(pl.id, folder.id);
      ui.toast(`Moved “${pl.title}” into “${folder.name}”`, "success");
      return;
    }
    ui.toast(`Importing “${pl.title}”…`);
    void requireBridge()
      .getPlaylist(pl.id)
      .then((page) => imported((page.title || pl.title).trim() || "Imported playlist", page.tracks ?? []))
      .catch(() => ui.toast(`Couldn't import “${pl.title}”`, "error"));
    return;
  }
  const al = readAlbum(e);
  if (!al) return;
  ui.toast(`Importing “${shortTitle(al.title)}”…`);
  void requireBridge()
    .getAlbum(al.id)
    .then((page) => imported((page.album?.title || al.title).trim() || "Imported album", page.tracks ?? []))
    .catch(() => ui.toast(`Couldn't import “${shortTitle(al.title)}”`, "error"));
}
