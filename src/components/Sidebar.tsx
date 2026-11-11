/**
 * Sidebar — the whole left panel is "Your Library", Spotify-style.
 *
 * One glass pill: a "Your Library" header (create button only) and a
 * scrollable list of the user's library — Liked Songs, Downloads,
 * playlists, folders, artists and Local Music. Main navigation lives in
 * the top bar (home beside the search field).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SPOTIFY_CONNECT } from "../lib/features";
import {
  Download,
  Folder,
  Heart,
  Library,
  ListPlus,
  Music2,
  Pin,
  PinOff,
  User,
} from "lucide-react";
import { isPinned, useLibrary, type PinnedSingleKey, type Playlist } from "../stores/library";
import { playingFromRow, usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { EqBars } from "./primitives";
import { FitText } from "./FitText";
import { shortTitle } from "../lib/format";
import { addSongsToPlaylists, staysOnDevice } from "../lib/devicePlaylists";
import { upgradeArtwork } from "../lib/artwork";
import { CreateMenu } from "./CreateMenu";
import { askForNewFolder, folderMenuItems, rowIsOpen } from "../lib/collection";
import { playlistOwnItems } from "../lib/trackActions";
import { draggingFromPlaylist, dragHasAlbum, dragHasArtist, dragHasPlaylist, dragHasTrack, readAlbum, readArtist, readPlaylist, readTrack, type AlbumPayload, type ArtistPayload, type PlaylistPayload } from "../lib/dnd";
import { requireBridge } from "../lib/bridge";
import { downloadAll, startDownload } from "../lib/downloads";
import { DOWNLOADS_COVER, LIKED_COVER, LOCAL_COVER, REPLAY_COVER } from "../lib/libraryCovers";
import { askToConnectSpotify, useSpotify } from "../lib/spotify";
import { useEdgeFades } from "../lib/useEdgeFades";
import { arrange, moveKey } from "../lib/libraryOrder";
import { useSortable, type SortableRowProps } from "../lib/useSortable";
import { SpotifyIcon } from "./SpotifyIcon";
import type { Track } from "../types";

const SPOTIFY_ROW = "__spotify__";

/* ============================================================ nav */

interface LibRow {
  id: string;
  title: string;
  subtitle: string;
  thumb?: string;
  kind: "playlist" | "artist" | "folder" | "local" | "downloads" | "replay" | "spotify";
  /** artist-imported playlists open the artist page instead of the list */
  artistId?: string;
  /** playlists: the folder they're filed in; folders: their own id */
  folderId?: string;
  /** Liked / Downloads / Local shortcut rows carry their pin state */
  pinned?: boolean;
  /** which shortcut pin this row toggles (liked / downloads / local) */
  singleKey?: PinnedSingleKey;
}

/** One place in the list: a row, or a folder with its open playlists, moved together. */
interface Entry {
  /** "single:<key>", "artist:<id>", "playlist:<id>" or "folder:<id>" (lib/libraryOrder) */
  key: string;
  rows: LibRow[];
}

function LibraryPill() {
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const folders = useLibrary((s) => s.folders);
  const followedArtists = useLibrary((s) => s.followedArtists);
  const downloads = useLibrary((s) => s.downloads);
  const pinnedSingles = useLibrary((s) => s.pinnedSingles);
  const spotifyConnected = useSpotify((s) => s.status.connected);
  const spotifyProblem = useSpotify((s) => s.status.problem);
  const spotifyPlaylists = useSpotify((s) => s.playlists);
  const navigate = useUI((s) => s.navigate);
  /** the page open in the middle panel: its row stays lit */
  const view = useUI((s) => s.view);
  const openDialog = useUI((s) => s.openDialog);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const playingFrom = usePlayer(playingFromRow);

  const libraryOrder = useLibrary((s) => s.libraryOrder);
  /** the scrolling list, and the rows inside it that a drag reorders */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  useEdgeFades(scrollRef);
  /** the row a drag is currently hovering — drives the drop highlight */
  const [dropHover, setDropHover] = useState<string | null>(null);
  /** a playlist drag is over the library panel — import-anywhere affordance */
  const [libHover, setLibHover] = useState(false);
  /** the row a drop just landed on — drives the pulse */
  const [pulse, setPulse] = useState<string | null>(null);
  /**
   * The panel glow runs on a dragover-driven TTL: every dragover over the
   * panel (they fire continuously under the cursor) refreshes a 600ms
   * window; no events ⇒ it expires. Counters can drift — Chromium fires
   * dragleave without a matching dragenter — but dragover cannot lie.
   */
  const glowTimer = useRef<number | null>(null);
  const refreshGlow = (): void => {
    setLibHover(true);
    if (glowTimer.current !== null) window.clearTimeout(glowTimer.current);
    glowTimer.current = window.setTimeout(() => setLibHover(false), 600);
  };
  const clearGlow = (): void => {
    if (glowTimer.current !== null) {
      window.clearTimeout(glowTimer.current);
      glowTimer.current = null;
    }
    setLibHover(false);
  };

  // A drag that ends anywhere (dropped outside a target) clears hover state.
  useEffect(() => {
    const clear = (): void => {
      clearGlow();
      setDropHover(null);
    };
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      clearGlow();
    };
  }, []);

  // Spotify's library contents: Liked Songs, Downloads, the user's playlists,
  // folders (collapsible), followed artists and Local Music. Recently-played
  // history is NOT library material — it lives in the queue panel's
  // "Recently played" tab.
  // Shortcut rows: Liked, Spotify and Replay are pinned by default, Downloads and
  // Local Music not; an unpinned one sits at the bottom of the list (re-pin from
  // its right-click menu).
  const doneDownloads = Object.values(downloads).filter((d) => d.status === "done");
  const singlePinned = (k: PinnedSingleKey): boolean => isPinned(pinnedSingles, k);

  const likedRow: LibRow = {
    id: "__liked__",
    title: "Liked Songs",
    subtitle: `Playlist · ${liked.length} ${liked.length === 1 ? "track" : "tracks"}`,
    // The four collections ByTune keeps carry sleeves of their own, the same from the first day.
    thumb: LIKED_COVER,
    kind: "playlist",
    pinned: singlePinned("liked"),
    singleKey: "liked",
  };
  const downloadsRow: LibRow = {
    id: "__downloads__",
    title: "Downloads",
    subtitle: `Playlist · ${doneDownloads.length} ${doneDownloads.length === 1 ? "track" : "tracks"}`,
    thumb: DOWNLOADS_COVER,
    kind: "downloads",
    pinned: singlePinned("downloads"),
    singleKey: "downloads",
  };
  const localRow: LibRow = {
    id: "__local__",
    title: "Local Music",
    subtitle: "On this device",
    thumb: LOCAL_COVER,
    kind: "local",
    pinned: singlePinned("local"),
    singleKey: "local",
  };
  // Always listed: connected, it opens the account's playlists; not yet, it asks to connect.
  const spotifyLists = spotifyPlaylists.length;
  const spotifyRow: LibRow = {
    id: SPOTIFY_ROW,
    title: "Spotify",
    subtitle: !spotifyConnected
      ? "Connect your playlists"
      : spotifyProblem
        ? "Needs reconnecting"
        : spotifyLists // 0 until the first read: Liked Songs is always one
          ? `Connected · ${spotifyLists} ${spotifyLists === 1 ? "playlist" : "playlists"}`
          : "Connected",
    kind: "spotify",
    pinned: singlePinned("spotify"),
    singleKey: "spotify",
  };
  // Replay: listening stats, otherwise only reachable from Settings.
  const replayRow: LibRow = {
    id: "__replay__",
    title: "Replay",
    subtitle: "Your listening stats",
    thumb: REPLAY_COVER,
    kind: "replay",
    pinned: singlePinned("replay"),
    singleKey: "replay",
  };
  const singles: LibRow[] = [likedRow, ...(SPOTIFY_CONNECT ? [spotifyRow] : []), replayRow, downloadsRow, localRow];

  // A playlist of nothing but songs from this computer stays here, and says so where "Playlist" would be.
  const subtitleOf = (p: Playlist): string =>
    `${staysOnDevice(p) ? "On this device" : "Playlist"} · ${p.tracks.length} ${p.tracks.length === 1 ? "track" : "tracks"}`;
  const playlistRow = (p: Playlist): LibRow => ({
    id: p.id,
    title: p.name,
    subtitle: subtitleOf(p),
    thumb: p.artistThumb ?? p.tracks[0]?.thumb,
    kind: "playlist",
    artistId: p.artistId,
    ...(p.folderId ? { folderId: p.folderId } : {}),
  });
  const unfiled = playlists.filter((p) => !p.folderId);
  // Pinned rows stay on top where they are; every row below moves by drag, in the order last
  // dragged (lib/libraryOrder), a folder together with its open playlists.
  const fixed: Entry[] = [
    ...singles.filter((r) => r.pinned).map((r) => ({ key: `single:${r.singleKey}`, rows: [r] })),
    ...unfiled.filter((p) => p.pinned).map((p) => ({ key: `playlist:${p.id}`, rows: [playlistRow(p)] })),
  ];
  const movable: Entry[] = [
    ...followedArtists.map((a) => ({ key: `artist:${a.id}`, rows: [{ id: a.id, title: a.name, subtitle: "Artist", thumb: a.thumb, kind: "artist" as const }] })),
    ...unfiled.filter((p) => !p.pinned).map((p) => ({ key: `playlist:${p.id}`, rows: [playlistRow(p)] })),
    // A folder is one row: it opens its page in the middle panel (FolderView), where its playlists are.
    ...folders.map((f) => {
      const filed = playlists.filter((p) => p.folderId === f.id);
      return {
        key: `folder:${f.id}`,
        rows: [{ id: f.id, title: f.name, subtitle: `Folder · ${filed.length} ${filed.length === 1 ? "playlist" : "playlists"}`, kind: "folder" as const, folderId: f.id }],
      };
    }),
    ...singles.filter((r) => !r.pinned).map((r) => ({ key: `single:${r.singleKey}`, rows: [r] })),
  ];
  const byKey = new Map(movable.map((e) => [e.key, e]));
  const entries: Entry[] = [...fixed, ...arrange(movable.map((e) => e.key), libraryOrder ?? []).map((k) => byKey.get(k)!)];
  const sortable = useSortable({
    signature: entries.map((e) => `${e.key}:${e.rows.length}`).join("|"),
    listRef: rowsRef,
    scrollRef,
    clamp: (_from, target) => Math.max(fixed.length, target),
    canDrag: (i) => i >= fixed.length,
    onCommit: (from, target) => {
      const keys = entries.slice(fixed.length).map((e) => e.key);
      useLibrary.getState().setLibraryOrder(moveKey(keys, from - fixed.length, target - fixed.length));
    },
  });

  /* ---------------------------------------------------------- drag & drop */

  /** Import a YouTube playlist as a real library playlist (same name). */
  const importPlaylist = async (pl: PlaylistPayload, folderId?: string): Promise<void> => {
    const ui = useUI.getState();
    ui.toast(`Importing “${pl.title}”…`);
    try {
      const page = await requireBridge().getPlaylist(pl.id);
      const name = (page.title || pl.title).trim() || "Imported playlist";
      const seen = new Set<string>();
      const tracks = (page.tracks ?? []).filter((t: Track) =>
        seen.has(t.id) ? false : (seen.add(t.id), true)
      );
      if (!tracks.length) throw new Error("no tracks");
      const n = tracks.length;
      const created = useLibrary.getState().importPlaylist(name, tracks, folderId);
      ui.toast(`“${created.name}” · ${n} ${n === 1 ? "song" : "songs"} added to your library`, "success");
    } catch {
      ui.toast(`Couldn't import “${pl.title}”`, "error");
    }
  };

  /** A dropped artist is FOLLOWED — the library shows their photo and the
      row opens their profile page (it never becomes a playlist). */
  const followDroppedArtist = (ar: ArtistPayload): void => {
    const added = useLibrary.getState().followArtist({ id: ar.id, name: ar.name, thumb: ar.thumb });
    const toast = useUI.getState().toast;
    if (added) toast(`Added “${ar.name}” to your library`, "success");
    else toast(`“${ar.name}” is already in your library`);
  };

  /** Import a YouTube album as a real library playlist (same name). */
  const importAlbum = async (al: AlbumPayload, folderId?: string): Promise<void> => {
    const ui = useUI.getState();
    ui.toast(`Importing “${shortTitle(al.title)}”…`);
    try {
      const page = await requireBridge().getAlbum(al.id);
      const name = (page.album?.title || al.title).trim() || "Imported album";
      const seen = new Set<string>();
      const tracks = (page.tracks ?? []).filter((t: Track) =>
        seen.has(t.id) ? false : (seen.add(t.id), true)
      );
      if (!tracks.length) throw new Error("no tracks");
      const n = tracks.length;
      const created = useLibrary.getState().importPlaylist(name, tracks, folderId);
      ui.toast(`“${created.name}” · ${n} ${n === 1 ? "song" : "songs"} added to your library`, "success");
    } catch {
      ui.toast(`Couldn't import “${shortTitle(al.title)}”`, "error");
    }
  };

  /** A dropped playlist payload that matches a local playlist is a FILING
      gesture (sidebar/library card → folder), not a YouTube import. */
  const localPlaylistName = (id: string): string | null =>
    useLibrary.getState().playlists.find((p) => p.id === id)?.name ?? null;

  const fileLocalPlaylist = (id: string, folderId: string): void => {
    const lib = useLibrary.getState();
    const toast = useUI.getState().toast;
    const name = localPlaylistName(id);
    if (!name) return;
    lib.setPlaylistFolder(id, folderId);
    toast(`Moved “${name}” into the folder`, "success");
    setPulse(folderId);
    window.setTimeout(() => setPulse((cur) => (cur === folderId ? null : cur)), 650);
  };

  /** A dropped track lands on Liked Songs or one of the user's playlists. */
  const dropTrackOn = (r: LibRow, track: Track): void => {
    const lib = useLibrary.getState();
    const toast = useUI.getState().toast;
    if (r.id === "__liked__") {
      if (lib.isLiked(track.id)) {
        toast(`“${shortTitle(track.title)}” is already in your Liked Songs`);
      } else {
        lib.toggleLike(track);
        toast(`Added “${shortTitle(track.title)}” to Liked Songs`, "success");
      }
    } else {
      const p = lib.playlists.find((pl) => pl.id === r.id);
      if (!p) return;
      const { added, told } = addSongsToPlaylists([r.id], [track]);
      if (!told) {
        toast(
          added
            ? `Added “${shortTitle(track.title)}” to “${p.name}”`
            : `“${shortTitle(track.title)}” is already in “${p.name}”`
        );
      }
    }
    setPulse(r.id);
    window.setTimeout(() => setPulse((cur) => (cur === r.id ? null : cur)), 650);
  };

  /** A dropped track on the Downloads row starts a download — same gesture
      as dropping on Liked Songs, but for offline saves. */
  const dropTrackOnDownloads = (track: Track): void => {
    void startDownload(track);
    setPulse("__downloads__");
    window.setTimeout(() => setPulse((cur) => (cur === "__downloads__" ? null : cur)), 650);
  };

  /** A dropped album on a playlist row appends the whole release. */
  const dropAlbumOn = async (r: LibRow, al: AlbumPayload): Promise<void> => {
    const lib = useLibrary.getState();
    const toast = useUI.getState().toast;
    try {
      const page = await requireBridge().getAlbum(al.id);
      const tracks = page.tracks ?? [];
      if (!tracks.length) throw new Error("no tracks");
      if (r.id === "__liked__") {
        let added = 0;
        for (const t of tracks) {
          if (!lib.isLiked(t.id)) {
            lib.toggleLike(t);
            added += 1;
          }
        }
        toast(
          added > 0
            ? `Added ${added} ${added === 1 ? "song" : "songs"} from “${al.title}” to Liked Songs`
            : `“${al.title}” is already in your Liked Songs`,
          added > 0 ? "success" : undefined
        );
      } else {
        const p = lib.playlists.find((pl) => pl.id === r.id);
        if (!p) return;
        let added = 0;
        for (const t of tracks) {
          if (lib.addToPlaylist(r.id, t)) added += 1;
        }
        toast(
          added > 0
            ? `Added ${added} ${added === 1 ? "song" : "songs"} from “${al.title}” to “${p.name}”`
            : `“${al.title}” is already in “${p.name}”`,
          added > 0 ? "success" : undefined
        );
      }
    } catch {
      toast(`Couldn't add “${shortTitle(al.title)}” here`, "error");
    }
    setPulse(r.id);
    window.setTimeout(() => setPulse((cur) => (cur === r.id ? null : cur)), 650);
  };

  /**
   * Hovering a folder with a song mid-drag opens the folder's page after a
   * beat, so the drag can go on to one of its playlists there: one gesture,
   * no re-drag. The highlight is immediate (onRowDragOver); only the opening
   * waits, the way file managers do.
   */
  const expandTimer = useRef<number | null>(null);
  const cancelPendingExpand = (): void => {
    if (expandTimer.current !== null) {
      window.clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  };
  const openFolder = (folderId: string): void => navigate({ name: "folder", param: folderId });
  const scheduleExpand = (folderId: string): void => {
    const v = useUI.getState().view;
    if (v.name === "folder" && v.param === folderId) return;
    if (expandTimer.current !== null) return;
    expandTimer.current = window.setTimeout(() => {
      expandTimer.current = null;
      openFolder(folderId);
    }, 650);
  };
  useEffect(() => {
    const clear = (): void => {
      cancelPendingExpand();
      setDropHover(null);
    };
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  const onRowDragOver = (e: React.DragEvent, r: LibRow): void => {
    const isTrack = dragHasTrack(e);
    const isAlbum = dragHasAlbum(e);
    const isPlaylist = dragHasPlaylist(e);
    // Playlist rows (+ Downloads) take tracks and whole albums. __liked__
    // carries kind "playlist".
    // A song dragged from its own playlist's page isn't offered back to that playlist.
    const acceptsTracks =
      (r.kind === "playlist" || r.kind === "downloads") && (isTrack || isAlbum) && !draggingFromPlaylist(r.id);
    // Folders take playlists and albums (file/import into the folder). A
    // track hovering a folder previews the folder and opens it so the drag
    // can land on a playlist inside — the same gesture, no second attempt.
    const acceptsCollections = r.kind === "folder" && (isPlaylist || isAlbum);
    const previewsFolder = r.kind === "folder" && isTrack && !isPlaylist && !isAlbum;
    if (!acceptsTracks && !acceptsCollections && !previewsFolder) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDropHover(r.id);
    if (previewsFolder) scheduleExpand(r.id);
  };

  const onRowDragLeave = (e: React.DragEvent, r: LibRow): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropHover((cur) => (cur === r.id ? null : cur));
      cancelPendingExpand();
    }
  };

  const onRowDrop = (e: React.DragEvent, r: LibRow): void => {
    cancelPendingExpand();
    if ((r.kind === "playlist" || r.kind === "downloads") && (dragHasTrack(e) || dragHasAlbum(e))) {
      e.preventDefault();
      e.stopPropagation();
      setDropHover(null);
      if (dragHasAlbum(e)) {
        const al = readAlbum(e);
        if (!al) return;
        if (r.kind === "downloads") {
          // An album dropped on Downloads downloads every song on it.
          void requireBridge()
            .getAlbum(al.id)
            .then((page) => downloadAll(page.tracks ?? [], `"${page.album?.title || al.title}"`))
            .catch(() => useUI.getState().toast("Couldn't open that album to download it", "error"));
          return;
        }
        void dropAlbumOn(r, al);
        return;
      }
      const track = readTrack(e);
      if (!track) return;
      if (r.kind === "downloads") dropTrackOnDownloads(track);
      else dropTrackOn(r, track);
      return;
    }
    if (r.kind === "folder" && (dragHasPlaylist(e) || dragHasAlbum(e))) {
      e.preventDefault();
      e.stopPropagation();
      setDropHover(null);
      if (dragHasAlbum(e)) {
        const al = readAlbum(e);
        if (al) void importAlbum(al, r.id);
        return;
      }
      const pl = readPlaylist(e);
      if (!pl) return;
      // Local playlists are filed; YouTube playlists are imported.
      if (localPlaylistName(pl.id)) fileLocalPlaylist(pl.id, r.id);
      else void importPlaylist(pl, r.id);
      return;
    }
    if (r.kind === "folder" && dragHasTrack(e)) {
      // Folders hold playlists, not songs: open the folder's page so the next
      // drag can land on a playlist there, and say so once.
      e.preventDefault();
      e.stopPropagation();
      setDropHover(null);
      openFolder(r.id);
      setPulse(r.id);
      window.setTimeout(() => setPulse((cur) => (cur === r.id ? null : cur)), 650);
      useUI.getState().toast(`“${r.title}” holds playlists — drop onto one of them`, "info");
    }
  };

  const onClickRow = (r: LibRow): void => {
    switch (r.kind) {
      case "artist":
        navigate({ name: "artist", param: r.id });
        break;
      case "playlist":
        if (r.id === "__liked__") navigate({ name: "library", param: "liked" });
        else if (r.artistId) navigate({ name: "artist", param: r.artistId });
        else navigate({ name: "playlist", param: r.id });
        break;
      case "downloads":
        navigate({ name: "downloads" });
        break;
      case "folder":
        openFolder(r.id);
        break;
      case "local":
        navigate({ name: "local" });
        break;
      case "replay":
        navigate({ name: "replay" });
        break;
      case "spotify":
        if (spotifyConnected) navigate({ name: "spotify" });
        else askToConnectSpotify();
        break;
    }
  };

  /** Right-click a row: pin/unpin shortcuts, playlist options, folder options. */
  const onRowContextMenu = (e: React.MouseEvent, r: LibRow): void => {
    if (r.singleKey) {
      e.preventDefault();
      e.stopPropagation();
      const pinned = singlePinned(r.singleKey);
      openContextMenu(e.clientX, e.clientY, [
        {
          label: pinned ? "Unpin" : "Pin to top",
          icon: pinned ? PinOff : Pin,
          action: () => useLibrary.getState().togglePinSingle(r.singleKey!),
        },
      ]);
      return;
    }
    if (r.kind === "artist") {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, [
        {
          label: "Remove from your library",
          danger: true,
          action: () => {
            useLibrary.getState().unfollowArtist(r.id);
            useUI.getState().toast(`Removed “${r.title}” from your library`);
          },
        },
      ]);
      return;
    }
    if (r.kind === "playlist" && r.id !== "__liked__") {
      const playlist = playlists.find((p) => p.id === r.id);
      if (!playlist) return;
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, [
        {
          label: playlist.pinned ? "Unpin playlist" : "Pin playlist",
          // slashed pin = "currently pinned, click to undo" (Spotify's model)
          icon: playlist.pinned ? PinOff : Pin,
          action: () => useLibrary.getState().togglePinPlaylist(playlist.id),
        },
        ...playlistOwnItems(playlist),
      ]);
      return;
    }
    if (r.kind === "folder") {
      const folder = folders.find((f) => f.id === r.id);
      if (!folder) return;
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, folderMenuItems(folder));
    }
  };

  /** Right-click the library panel itself — Spotify's create menu. Rows stop
      propagation so they keep their own menus; everywhere else (header, empty
      space) offers playlist/folder creation, each asking for a name first so
      nothing empty lands in the library. */
  const onLibraryContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      {
        label: "Create playlist",
        icon: ListPlus,
        action: () => {
          const suggested = `My Playlist #${useLibrary.getState().playlists.length + 1}`;
          openDialog({
            title: "New playlist",
            body: "Give your playlist a name.",
            initialValue: suggested,
            placeholder: "Playlist name",
            confirmLabel: "Create",
            onConfirm: (value) => {
              const p = useLibrary.getState().createPlaylist(value.trim() || suggested);
              navigate({ name: "playlist", param: p.id });
            },
          });
        },
      },
      {
        label: "Create folder",
        icon: Folder,
        action: askForNewFolder,
      },
    ]);
  };

  function renderRow(r: LibRow, drag: SortableRowProps | undefined): ReactNode {
    const filed = r.kind === "folder" ? playlists.filter((p) => p.folderId === r.id) : [];
    // A folder plays when one of its playlists (or the folder itself) does.
    const isCurrent =
      playingFrom !== null && (playingFrom === r.id || playingFrom === r.artistId || filed.some((p) => p.id === playingFrom));
    const open = rowIsOpen(r, view);
    /** a folder's face: its playlists' covers, four up once it has four */
    const folderArt = [...new Set(filed.map((p) => p.artistThumb ?? p.tracks[0]?.thumb).filter((t): t is string => !!t))].slice(0, 4);
    return (
      <div
        key={`${r.kind}-${r.id}`}
        {...drag}
        role="button"
        tabIndex={0}
        aria-current={open ? "page" : undefined}
        onClick={() => onClickRow(r)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            onClickRow(r);
          } else drag?.onKeyDown(e);
        }}
        onContextMenu={(e) => onRowContextMenu(e, r)}
        onDragOver={(e) => onRowDragOver(e, r)}
        onDragLeave={(e) => onRowDragLeave(e, r)}
        onDrop={(e) => onRowDrop(e, r)}
        // The open page's row keeps the hover's light, a touch stronger, so it reads as "you're here".
        className={`fit-host group w-full flex items-center gap-3 p-2 rounded-lg text-left cursor-pointer select-none ${
          open ? "bg-ink-hi/[0.08]" : "hover:bg-ink-hi/[0.05]"
        } active:bg-ink-hi/[0.1] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
          dropHover === r.id ? "ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.08] scale-[1.02]" : ""
        } ${
          pulse === r.id ? "animate-drop-pulse" : ""
        }`}
      >
        {r.kind === "artist" ? (
          r.thumb ? (
            <img
              src={upgradeArtwork(r.thumb)}
              alt=""
              draggable={false}
              className="w-12 h-12 rounded-full object-cover art-hairline shrink-0"
            />
          ) : (
            <span className="w-12 h-12 rounded-full bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
              <User className="w-5 h-5 text-ink-hi/55" />
            </span>
          )
        ) : r.kind === "folder" ? (
          folderArt.length === 4 ? (
            <span className="w-12 h-12 rounded-md overflow-hidden art-hairline shrink-0 grid grid-cols-2">
              {folderArt.map((src) => (
                <img key={src} src={upgradeArtwork(src)} alt="" draggable={false} className="w-full h-full object-cover" />
              ))}
            </span>
          ) : folderArt.length ? (
            <img src={upgradeArtwork(folderArt[0])} alt="" draggable={false} className="w-12 h-12 rounded-md object-cover art-hairline shrink-0" />
          ) : (
            <span className="w-12 h-12 rounded-md bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
              <Folder className="w-5 h-5 text-ink-hi/55" />
            </span>
          )
        ) : r.kind === "spotify" ? (
          <span className="w-12 h-12 rounded-md bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
            <SpotifyIcon className="w-6 h-6" />
          </span>
        ) : r.thumb ? (
          <img src={upgradeArtwork(r.thumb)} alt="" draggable={false} className="w-12 h-12 rounded-md object-cover art-hairline shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-md bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
            {r.kind === "downloads" ? (
              <Download className="w-4 h-4 text-ink-hi/35" />
            ) : r.kind === "playlist" ? (
              <Music2 className="w-4 h-4 text-ink-hi/35" />
            ) : (
              <Heart className="w-4 h-4 text-ink-hi/35" />
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <FitText text={r.title} className="text-[14px] font-semibold text-ink-hi" />
          <FitText text={r.subtitle} className="text-[12.5px] text-ink-hi/55 mt-0.5" />
        </div>
        {isCurrent && <EqBars />}
        {((r.singleKey && r.pinned) ||
          (r.kind === "playlist" &&
            !r.singleKey &&
            playlists.find((p) => p.id === r.id)?.pinned)) && (
          <Pin className="w-3.5 h-3.5 text-accent shrink-0 fill-accent/20" aria-label="Pinned" />
        )}
      </div>
    );
  }

  return (
    <div
      className={`relative flex-1 min-h-0 flex flex-col glass-pill rounded-2xl overflow-hidden shadow-pill transition-shadow ${
        libHover ? "shadow-[0_0_44px_rgb(var(--accent)/0.14)]" : ""
      }`}
      onContextMenu={onLibraryContextMenu}
      onDragOver={(e) => {
        if (!dragHasPlaylist(e) && !dragHasArtist(e) && !dragHasAlbum(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        refreshGlow();
      }}
      onDragLeave={(e) => {
        if (dragHasPlaylist(e) || dragHasArtist(e) || dragHasAlbum(e)) refreshGlow();
      }}
      onDrop={(e) => {
        clearGlow();
        const isPlaylist = dragHasPlaylist(e);
        const isArtist = !isPlaylist && dragHasArtist(e);
        const isAlbum = !isPlaylist && !isArtist && dragHasAlbum(e);
        if (!isPlaylist && !isArtist && !isAlbum) return;
        e.preventDefault();
        if (isPlaylist) {
          const pl = readPlaylist(e);
          if (!pl) return;
          // Local playlists dropped on the panel background are already
          // home — filing happens on folders, not here.
          const name = localPlaylistName(pl.id);
          if (name) {
            useUI.getState().toast(`“${name}” is already in your library`);
            return;
          }
          void importPlaylist(pl);
        } else if (isAlbum) {
          const al = readAlbum(e);
          if (al) void importAlbum(al);
        } else {
          const ar = readArtist(e);
          if (ar) followDroppedArtist(ar);
        }
      }}
    >
      {/* The whole-panel glow while a playlist/artist hovers over the panel. */}
      {libHover && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 rounded-2xl ring-2 ring-inset ring-accent/50 bg-accent/[0.05]"
        />
      )}
      {/* Header */}
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <button
          onClick={() => navigate({ name: "library" })}
          className="flex items-center gap-2 text-[14px] font-semibold text-ink-hi/75 hover:text-ink-hi transition-colors"
        >
          <Library className="w-4 h-4" />
          Your Library
        </button>
        <div className="ml-auto flex items-center gap-1">
          {/* + opens Spotify's create dropdown — Playlist / Folder, no modal. */}
          <CreateMenu />
        </div>
      </div>

      {/* Rows — drops bubble to the panel root, which imports playlists and
          artists anywhere they land; specific rows handle their own targets. */}
      <div ref={scrollRef} className="edge-fades flex-1 min-h-0 overflow-y-auto px-2 pb-2 pt-1">
        {entries.length === 0 ? (
          <div className="px-3 py-8 text-center text-[13px] text-ink-hi/55">
            Nothing here yet — play a track to fill your library.
          </div>
        ) : (
          <div ref={rowsRef} className="space-y-0.5">
            {entries.map((entry, i) => (
              <div
                key={entry.key}
                style={sortable.styleFor(i)}
                tabIndex={-1}
                // Alt+↑/↓ refocuses the moved entry: hand that on to its row.
                onFocus={(e) => {
                  if (e.target === e.currentTarget) (e.currentTarget.firstElementChild as HTMLElement | null)?.focus();
                }}
                className="space-y-0.5 rounded-lg outline-none"
              >
                {entry.rows.map((r, j) => renderRow(r, j === 0 && i >= fixed.length ? sortable.rowProps(i) : undefined))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ root */

export function Sidebar() {
  return (
    <aside className="w-[328px] shrink-0 flex flex-col min-h-0">
      <LibraryPill />
    </aside>
  );
}
