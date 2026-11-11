/** Builds right-click / "more" menu items for tracks and playlists. */
import {
  Disc3,
  Download,
  FolderOpen,
  Heart,
  Link2,
  ListMusic,
  ListPlus,
  ListStart,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  User,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { downloadAll, startDownload } from "./downloads";
import { plural } from "./format";
import { playAlbum } from "./album";
import { playPlaylist } from "./playlist";
import { copyLink, youtubeAlbumLink, youtubePlaylistLink } from "./playlistShare";
import { requireBridge } from "./bridge";
import { useLibrary, type Playlist } from "../stores/library";
import { addSongsToPlaylists, newPlaylistWith } from "./devicePlaylists";
import { usePlayer } from "../stores/player";
import { useUI, type MenuItem } from "../stores/ui";
import type { BrowseItem, Track } from "../types";

export function trackMenuItems(track: Track): MenuItem[] {
  const lib = useLibrary.getState();
  const ui = useUI.getState();
  const liked = lib.isLiked(track.id);
  const dl = lib.downloads[track.id];
  const done = dl?.status === "done";

  const items: MenuItem[] = [
    {
      label: "Play now",
      icon: Play,
      action: () => usePlayer.getState().playTrack(track),
    },
    {
      label: "Play next",
      icon: ListStart,
      action: () => {
        usePlayer.getState().addToQueue(track, true);
        useUI.getState().toast("Playing next");
      },
    },
    {
      label: "Add to queue",
      icon: ListPlus,
      action: () => {
        const added = usePlayer.getState().addToQueue(track);
        useUI.getState().toast(added ? "Added to queue" : "Already in your queue");
      },
    },
    {
      separatorBefore: true,
      label: liked ? "Remove from Liked" : "Add to Liked",
      icon: Heart,
      action: () => useLibrary.getState().toggleLike(track),
    },
  ];

  const playlists = lib.playlists.slice(0, 6);
  for (const p of playlists) {
    items.push({
      label: `Add to "${p.name}"`,
      action: () => {
        const { added, told } = addSongsToPlaylists([p.id], [track]);
        if (!told) useUI.getState().toast(added ? `Added to "${p.name}"` : "Already in this playlist");
      },
    });
  }
  if (lib.playlists.length > 1) {
    items.push({
      label: "Add to playlists",
      icon: ListPlus,
      action: () => useUI.getState().openPlaylistPicker([track]),
    });
  }
  items.push({
    label: "New playlist",
    icon: ListMusic,
    action: () => {
      // Name it before it exists — cancel creates nothing and the track
      // stays where it was. Blank confirm keeps the numbered default.
      const suggested = `Playlist ${useLibrary.getState().playlists.length + 1}`;
      useUI.getState().openDialog({
        title: "New playlist",
        body: `Add "${track.title}" to a new playlist.`,
        initialValue: suggested,
        placeholder: "Playlist name",
        confirmLabel: "Create",
        onConfirm: (value) => {
          const playlist = newPlaylistWith(value.trim() || suggested, [track]);
          useUI.getState().navigate({ name: "playlist", param: playlist.id });
        },
      });
    },
  });

  // A local file is already on disk and has no YouTube page: no Download,
  // no Copy link (both used to fail, or copy a broken watch?v=local:… URL).
  const local = !!track.localPath || track.id.startsWith("local:");
  if (!local) {
    items.push({
      separatorBefore: true,
      label: done ? "Show in folder" : "Download",
      icon: done ? FolderOpen : Download,
      action: () => {
        if (done && dl?.path) {
          requireReveal(dl.path);
        } else {
          void startDownload(track);
        }
      },
    });
  }

  if (track.artistId) {
    items.push({
      separatorBefore: true,
      label: "Go to artist",
      icon: User,
      action: () => useUI.getState().navigate({ name: "artist", param: track.artistId }),
    });
  }
  if (track.albumId) {
    items.push({
      separatorBefore: !track.artistId,
      label: "Go to album",
      icon: Disc3,
      action: () => useUI.getState().navigate({ name: "album", param: track.albumId }),
    });
  }

  if (!local) {
    items.push({
      label: "Copy link",
      icon: Link2,
      action: () => {
        void navigator.clipboard
          .writeText(`https://music.youtube.com/watch?v=${track.id}`)
          .then(() => useUI.getState().toast("Link copied"))
          .catch(() => useUI.getState().toast("Couldn't copy link", "error"));
      },
    });
  }

  // The song itself, drawn at the menu's top (ContextMenu lifts it there): last here, so menus that
  // put their own rows before these keep them first.
  items.push({ subject: { title: track.title, subtitle: track.artist, thumb: track.thumb } });
  return items;
}

function requireReveal(path: string): void {
  if (window.bytune) window.bytune.revealPath(path);
}

export function playlistMenuItems(playlist: Playlist, track: Track): MenuItem[] {
  const tracks = useLibrary.getState().getPlaylist(playlist.id)?.tracks ?? playlist.tracks;
  const at = tracks.findIndex((t) => t.id === track.id);
  const move = (to: number): void => useLibrary.getState().moveInPlaylist(playlist.id, at, to);
  const last = tracks.length - 1;
  const moves: MenuItem[] =
    at < 0 || tracks.length < 2
      ? []
      : [
          { label: "Move up", icon: ArrowUp, disabled: at === 0, action: () => move(at - 1) },
          { label: "Move down", icon: ArrowDown, disabled: at === last, action: () => move(at + 1) },
          { label: "Move to top", disabled: at === 0, action: () => move(0) },
          { label: "Move to bottom", disabled: at === last, action: () => move(last) },
        ];
  return [
    ...moves,
    {
      label: "Remove from this playlist",
      icon: Trash2,
      danger: true,
      separatorBefore: moves.length > 0,
      action: () => {
        useLibrary.getState().removeFromPlaylist(playlist.id, track.id);
        useUI.getState().toast("Removed from playlist");
      },
    },
    ...trackMenuItems(track),
  ];
}

export function playlistHeaderItems(playlist: Playlist): MenuItem[] {
  return [
    {
      label: "Rename",
      icon: Pencil,
      action: () => {
        useUI.getState().openDialog({
          title: "Rename playlist",
          initialValue: playlist.name,
          placeholder: "Playlist name",
          confirmLabel: "Rename",
          onConfirm: (value) => {
            if (value.trim()) useLibrary.getState().renamePlaylist(playlist.id, value);
          },
        });
      },
    },
    {
      label: "Delete playlist",
      icon: Trash2,
      danger: true,
      action: () => {
        useUI.getState().openDialog({
          title: `Delete "${playlist.name}"?`,
          body: "This can't be undone. The tracks themselves aren't affected.",
          confirmLabel: "Delete",
          danger: true,
          onConfirm: () => {
            useLibrary.getState().deletePlaylist(playlist.id);
            useUI.getState().navigate({ name: "playlists" });
            useUI.getState().toast("Playlist deleted", "info");
          },
        });
      },
    },
    // Drawn at the menu's top; last here because PlaylistView takes Rename and Delete by position.
    {
      subject: {
        title: playlist.name,
        subtitle: `Playlist · ${plural(playlist.tracks.length, "song", "songs")}`,
        thumb: playlist.artistThumb ?? playlist.tracks[0]?.thumb,
      },
    },
  ];
}

/** File a playlist into a library folder (or back out to the top level). */
export function playlistFolderItems(playlist: Playlist): MenuItem[] {
  const folders = useLibrary.getState().folders;
  if (!folders.length) return [];
  // Which folder it's in, as a choice: the current one checked, any other moves it there.
  const items: MenuItem[] = [
    { label: "Folder", header: true, separatorBefore: true },
    ...folders.map((f) => ({
      label: f.name,
      icon: FolderOpen,
      checked: f.id === playlist.folderId,
      action: () => useLibrary.getState().setPlaylistFolder(playlist.id, f.id),
    })),
  ];
  return items;
}

/**
 * A playlist's menu rows after any pin row: Rename, Delete, the folder choice. Inside a folder,
 * "Remove from folder" takes Delete's place under Rename, in red, and Delete moves to the bottom in
 * white: the row under Rename is the one pressed by mistake, and out of a folder is only a move.
 */
export function playlistOwnItems(playlist: Playlist): MenuItem[] {
  const [rename, remove, subject] = playlistHeaderItems(playlist);
  const folder = playlistFolderItems(playlist);
  if (!playlist.folderId || !folder.length) return [rename, remove, subject, ...folder];
  return [
    rename,
    {
      label: "Remove from folder",
      icon: FolderOpen,
      danger: true,
      action: () => useLibrary.getState().setPlaylistFolder(playlist.id, null),
    },
    subject,
    ...folder,
    { ...remove, danger: false, separatorBefore: true },
  ];
}

export function historyMenuItems(track: Track): MenuItem[] {
  return [
    {
      label: "Remove from Recently played",
      icon: Trash2,
      danger: true,
      action: () => useLibrary.getState().removeFromHistory(track.id),
    },
    ...trackMenuItems(track),
  ];
}

/** "Clear recently played", behind a confirm — it clears every signed-in device too. */
export function confirmClearHistory(): void {
  useUI.getState().openDialog({
    title: "Clear Recently played?",
    body: "Your recently played songs will be removed. Replay keeps its stats.",
    confirmLabel: "Clear",
    danger: true,
    onConfirm: () => useLibrary.getState().clearHistory(),
  });
}

export function downloadMenuItems(track: Track, path: string | null): MenuItem[] {
  return [
    {
      label: "Show in folder",
      icon: FolderOpen,
      action: () => {
        if (path) requireReveal(path);
      },
    },
    {
      label: "Retry download",
      icon: RotateCcw,
      action: () => void startDownload(track),
    },
  ];
}

/** Right-click on an album, playlist or artist result: play, queue, download, share. */
export function browseMenuItems(item: BrowseItem): MenuItem[] {
  const ui = useUI.getState();
  const tracksOf = async (): Promise<Track[]> =>
    item.type === "album"
      ? ((await requireBridge().getAlbum(item.browseId)).tracks ?? [])
      : ((await requireBridge().getPlaylist(item.browseId)).tracks ?? []);
  const failed = (): void => ui.toast("Couldn't load those songs", "error");
  if (item.type === "artist") {
    return [
      { label: "Open artist", icon: User, action: () => ui.navigate({ name: "artist", param: item.browseId }) },
      {
        label: "Copy link",
        icon: Link2,
        action: () => copyLink(`https://music.youtube.com/channel/${encodeURIComponent(item.browseId)}`),
      },
      { subject: { title: item.title, subtitle: "Artist", thumb: item.thumb, round: true } },
    ];
  }
  if (item.type !== "album" && item.type !== "playlist") return [];
  const album = item.type === "album";
  return [
    { subject: { title: item.title, subtitle: item.subtitle || (album ? "Album" : "Playlist"), thumb: item.thumb } },
    {
      label: "Play",
      icon: Play,
      action: () => void (album ? playAlbum(item.browseId) : playPlaylist(item.browseId)),
    },
    {
      label: "Play next",
      icon: ListStart,
      action: () => void tracksOf().then((t) => usePlayer.getState().addToQueue(t, true)).catch(failed),
    },
    {
      label: "Add to queue",
      icon: ListPlus,
      action: () => void tracksOf().then((t) => usePlayer.getState().addToQueue(t)).catch(failed),
    },
    {
      label: "Download all",
      icon: Download,
      separatorBefore: true,
      action: () => void tracksOf().then((t) => downloadAll(t, `"${item.title}"`)).catch(failed),
    },
    {
      label: "Copy link",
      icon: Link2,
      action: () => copyLink(album ? youtubeAlbumLink(item.browseId) : youtubePlaylistLink(item.browseId)),
    },
  ];
}
