/** Library state: liked tracks, playlists, history and download registry. */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { coalescedStorage } from "../lib/persist";
import { recordDeletionChanges } from "../lib/deletion-sync";
import type { DeletionChange, DeletionSync } from "../lib/deletion-sync";
import type { Track } from "../types";

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
  /** pinned playlists sort first */
  pinned?: boolean;
  /** library folder this playlist lives in, when filed */
  folderId?: string;
  /** set when the playlist was imported from an artist drop — clicking it
      opens the artist page and the artist's photo stands in as cover */
  artistId?: string;
  artistThumb?: string;
  /** when the listener last put the songs in their own order — the newest
      order wins a two-device merge (electron/sync-merge.ts inPlaylistOrder) */
  orderedAt?: number;
}

/** An artist the user dropped into their library — a follow, not a playlist. */
export interface FollowedArtist {
  id: string;
  name: string;
  thumb?: string;
  followedAt: number;
}

/** A user-created library folder that groups playlists. */
export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: number;
}

export type DownloadStatus = "queued" | "downloading" | "done" | "failed";

export interface DownloadItem {
  track: Track;
  path: string | null;
  status: DownloadStatus;
  /** 0..1, only meaningful while downloading */
  progress: number;
  downloaded: number;
  total: number;
}

/** Pinnable library shortcuts — Liked Songs, Downloads, Local Music. */
export type PinnedSingleKey = "liked" | "spotify" | "replay" | "downloads" | "local";
/** The sidebar's shortcut rows, in their order. */
export const SINGLE_KEYS: PinnedSingleKey[] = ["liked", "spotify", "replay", "downloads", "local"];
const PIN_DEFAULTS: Record<PinnedSingleKey, boolean> = { liked: true, spotify: true, replay: true, downloads: false, local: false };
/**
 * Pins as stored. `v2` marks a set written since Spotify and Replay became pinnable (2026-11-03).
 * An older set saved "pinned" for every row whether chosen or not, so only its unpins still count.
 */
export type PinnedSingles = Partial<Record<PinnedSingleKey, boolean>> & { v2?: boolean };

export function isPinned(pins: PinnedSingles | null | undefined, key: PinnedSingleKey): boolean {
  if (pins?.v2) return pins[key] ?? PIN_DEFAULTS[key];
  return pins?.[key] === false ? false : PIN_DEFAULTS[key];
}

interface LibraryState {
  liked: Track[];
  playlists: Playlist[];
  folders: LibraryFolder[];
  /** artists the user dropped into their library */
  followedArtists: FollowedArtist[];
  history: Track[];
  downloads: Record<string, DownloadItem>;
  /** pin state for the shortcut rows (read it with isPinned) */
  pinnedSingles: PinnedSingles;
  /** the order of Your Library's movable rows, as last dragged (lib/libraryOrder; [] = default) */
  libraryOrder?: string[];
  /** deletion/version metadata replicated with the library (see deletion-sync.ts) */
  deletionSync?: DeletionSync;

  isLiked(id: string): boolean;
  toggleLike(track: Track): void;
  togglePinSingle(key: PinnedSingleKey): void;
  setLibraryOrder(keys: string[]): void;
  createPlaylist(name: string): Playlist;
  /** A new playlist holding imported songs — never overwrites an existing one. */
  importPlaylist(name: string, tracks: Track[], folderId?: string): Playlist;
  renamePlaylist(id: string, name: string): void;
  togglePinPlaylist(id: string): void;
  deletePlaylist(id: string): void;
  addToPlaylist(playlistId: string, track: Track): boolean;
  removeFromPlaylist(playlistId: string, trackId: string): void;
  /** Move one song inside a playlist (drag, or Move up/down). */
  moveInPlaylist(playlistId: string, from: number, to: number): void;
  getPlaylist(id: string): Playlist | null;
  createFolder(name: string): LibraryFolder;
  renameFolder(id: string, name: string): void;
  deleteFolder(id: string): void;
  setPlaylistFolder(playlistId: string, folderId: string | null): void;
  pushHistory(track: Track): void;
  clearHistory(): void;
  /** Forget one song from Recently played — on every device, via its tombstone. */
  removeFromHistory(id: string): void;
  followArtist(artist: { id: string; name: string; thumb?: string }): boolean;
  unfollowArtist(id: string): void;
  setDownload(id: string, item: DownloadItem): void;
  patchDownload(id: string, patch: Partial<DownloadItem>): void;
  removeDownload(id: string): void;
}

function uid(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

let hydrationLikes: Map<string, { track: Track; liked: boolean }> | null = null;
/** Buffered history actions: a track (played), null (cleared) or a removal. */
let hydrationHistory: Array<Track | null | { remove: string }> | null = null;

/** Membership and its version must persist atomically in the same write. */
function withChanges(
  set: (partial: Partial<LibraryState>) => void,
  get: () => LibraryState,
  next: Partial<LibraryState>,
  changes: DeletionChange[]
): void {
  set({ ...next, deletionSync: recordDeletionChanges(get(), next, changes) });
}

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      liked: [],
      playlists: [],
      folders: [],
      followedArtists: [],
      history: [],
      downloads: {},
      pinnedSingles: { ...PIN_DEFAULTS, v2: true },
      libraryOrder: [],

      setLibraryOrder(keys) {
        set({ libraryOrder: keys });
      },

      togglePinSingle(key) {
        const pins = get().pinnedSingles;
        const now = Object.fromEntries(SINGLE_KEYS.map((k) => [k, isPinned(pins, k)])) as Record<PinnedSingleKey, boolean>;
        set({ pinnedSingles: { ...now, [key]: !now[key], v2: true } });
      },

      isLiked(id) {
        return get().liked.some((t) => t.id === id);
      },

      toggleLike(track) {
        const { liked } = get();
        const wasLiked = liked.some((t) => t.id === track.id);
        // Replay the desired value, not a toggle against the restored value.
        hydrationLikes?.set(track.id, { track, liked: !wasLiked });
        if (wasLiked) {
          withChanges(set, get, { liked: liked.filter((t) => t.id !== track.id) },
            [{ kind: "delete", group: "liked", id: track.id }]);
        } else {
          withChanges(set, get, { liked: [track, ...liked] },
            [{ kind: "add", group: "liked", id: track.id }]);
        }
      },

      createPlaylist(name) {
        const playlist: Playlist = { id: uid(), name: name.trim() || "New Playlist", tracks: [], createdAt: Date.now() };
        withChanges(set, get, { playlists: [playlist, ...get().playlists] },
          [{ kind: "add", group: "playlists", id: playlist.id }]);
        return playlist;
      },

      importPlaylist(name, tracks, folderId) {
        // Always a NEW playlist: an import named like one of the listener's
        // own playlists used to replace that playlist's songs. A clash gets a
        // number instead, and every song is stamped so merges keep it.
        const taken = new Set(get().playlists.map((p) => p.name.trim().toLowerCase()));
        const base = name.trim() || "Imported playlist";
        let unique = base;
        for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${base} (${n})`;
        const seen = new Set<string>();
        const list = tracks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
        // orderedAt: songs added in one batch share an add stamp, so the import's
        // own order is what a merge keeps (electron/sync-merge.ts inPlaylistOrder).
        const now = Date.now();
        const playlist: Playlist = { id: uid(), name: unique, tracks: list, createdAt: now, orderedAt: now, ...(folderId ? { folderId } : {}) };
        withChanges(set, get, { playlists: [playlist, ...get().playlists] }, [
          { kind: "add", group: "playlists", id: playlist.id },
          ...list.map((t): DeletionChange => ({ kind: "add", group: "tracks", id: t.id, parent: playlist.id })),
        ]);
        return playlist;
      },

      renamePlaylist(id, name) {
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
        }, [{ kind: "edit", group: "playlists", id }]);
      },

      togglePinPlaylist(id) {
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)),
        }, [{ kind: "edit", group: "playlists", id }]);
      },

      deletePlaylist(id) {
        // The playlist's own tombstone already drops all of its songs on merge
        // (ids are never reused). A tombstone per song made a big playlist push
        // compaction past its limit and lifted the floor for every other record.
        const changes: DeletionChange[] = [{ kind: "delete", group: "playlists", id }];
        withChanges(set, get, { playlists: get().playlists.filter((p) => p.id !== id) }, changes);
      },

      addToPlaylist(playlistId, track) {
        const playlists = get().playlists.map((p) => {
          if (p.id !== playlistId) return p;
          if (p.tracks.some((t) => t.id === track.id)) return p;
          return { ...p, tracks: [...p.tracks, track] };
        });
        const target = get().playlists.find((p) => p.id === playlistId);
        const dup = target?.tracks.some((t) => t.id === track.id) ?? false;
        if (!target || dup) return false;
        withChanges(set, get, { playlists },
          [{ kind: "add", group: "tracks", id: track.id, parent: playlistId }]);
        return true;
      },

      removeFromPlaylist(playlistId, trackId) {
        const target = get().playlists.find((p) => p.id === playlistId);
        if (!target || !target.tracks.some((t) => t.id === trackId)) return;
        withChanges(set, get, {
          playlists: get().playlists.map((p) =>
            p.id === playlistId ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p
          ),
        }, [{ kind: "delete", group: "tracks", id: trackId, parent: playlistId }]);
      },

      moveInPlaylist(playlistId, from, to) {
        const target = get().playlists.find((p) => p.id === playlistId);
        if (!target || from === to || from < 0 || to < 0 || from >= target.tracks.length || to >= target.tracks.length) return;
        const tracks = [...target.tracks];
        const [moved] = tracks.splice(from, 1);
        tracks.splice(to, 0, moved);
        // Only the order changes: no metadata edit stamp, or this device's stale
        // name/folder would win the next merge. orderedAt alone carries the order.
        withChanges(set, get, {
          playlists: get().playlists.map((p) =>
            p.id === playlistId ? { ...p, tracks, orderedAt: Math.max(Date.now(), (p.orderedAt ?? 0) + 1) } : p
          ),
        }, []);
      },

      getPlaylist(id) {
        return get().playlists.find((p) => p.id === id) ?? null;
      },

      createFolder(name) {
        const folder: LibraryFolder = { id: uid(), name: name.trim() || "New Folder", createdAt: Date.now() };
        withChanges(set, get, { folders: [...get().folders, folder] },
          [{ kind: "add", group: "folders", id: folder.id }]);
        return folder;
      },

      renameFolder(id, name) {
        withChanges(set, get, {
          folders: get().folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)),
        }, [{ kind: "edit", group: "folders", id }]);
      },

      deleteFolder(id) {
        if (!get().folders.some((f) => f.id === id)) return;
        // The folder goes; its playlists come back to the top level.
        withChanges(set, get, {
          folders: get().folders.filter((f) => f.id !== id),
          playlists: get().playlists.map((p) => (p.folderId === id ? { ...p, folderId: undefined } : p)),
        }, [{ kind: "delete", group: "folders", id }]);
      },

      setPlaylistFolder(playlistId: string, folderId: string | null) {
        const target = get().playlists.find((p) => p.id === playlistId);
        const nextFolderId = folderId ?? undefined;
        if (target?.folderId === nextFolderId) return;
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === playlistId ? { ...p, folderId: nextFolderId } : p)),
        }, [{ kind: "edit", group: "playlists", id: playlistId }]);
      },

      pushHistory(track) {
        hydrationHistory?.push(track);
        const rest = get().history.filter((t) => t.id !== track.id);
        withChanges(set, get, { history: [track, ...rest].slice(0, 200) },
          [{ kind: "add", group: "history", id: track.id }]);
      },

      clearHistory() {
        hydrationHistory?.push(null);
        withChanges(set, get, { history: [] }, [{ kind: "clear", group: "history" }]);
      },

      removeFromHistory(id) {
        hydrationHistory?.push({ remove: id });
        withChanges(set, get, { history: get().history.filter((t) => t.id !== id) },
          [{ kind: "delete", group: "history", id }]);
      },

      followArtist(artist) {
    if (!artist.id) return false;
    if (get().followedArtists.some((a) => a.id === artist.id)) return false;
    withChanges(set, get, {
      followedArtists: [
        { id: artist.id, name: artist.name, thumb: artist.thumb, followedAt: Date.now() },
        ...get().followedArtists,
      ],
    }, [{ kind: "add", group: "followedArtists", id: artist.id }]);
    return true;
  },

  unfollowArtist(id) {
    withChanges(set, get, { followedArtists: get().followedArtists.filter((a) => a.id !== id) },
      [{ kind: "delete", group: "followedArtists", id }]);
  },

  setDownload(id, item) {
        set({ downloads: { ...get().downloads, [id]: item } });
      },

      patchDownload(id, patch) {
        const existing = get().downloads[id];
        if (!existing) return;
        set({ downloads: { ...get().downloads, [id]: { ...existing, ...patch } } });
      },

      removeDownload(id) {
        const next = { ...get().downloads };
        delete next[id];
        set({ downloads: next });
      },
    }),
    {
      name: "library",
      // Coalesced like the player store: download progress patches the
      // downloads registry several times a second, and an uncoalesced persist
      // would serialize the whole library (liked + playlists + history + the
      // full Track objects) to disk at that rate. Pending writes still flush
      // on pagehide/beforeunload, so close-time durability is unchanged.
      storage: coalescedStorage,
      version: 1,
      onRehydrateStorage: () => {
        const likes = hydrationLikes ?? new Map<string, { track: Track; liked: boolean }>();
        const history = hydrationHistory ?? [];
        hydrationLikes = likes;
        hydrationHistory = history;
        return (state) => {
          if (hydrationLikes !== likes) return;
          hydrationLikes = null;
          hydrationHistory = null;
          if (!state || (likes.size === 0 && history.length === 0)) return;
          // Hydration replaced the intermediate metadata too. Replay explicit
          // user intents against the restored clock, preserving their order.
          // These are real buffered actions, not newly inferred additions.
          let replay = state;
          for (const action of likes.values()) {
            const rest = replay.liked.filter((track) => track.id !== action.track.id);
            const next = { liked: action.liked ? [action.track, ...rest] : rest };
            replay = { ...replay, ...next, deletionSync: recordDeletionChanges(replay, next,
              [{ kind: action.liked ? "add" : "delete", group: "liked", id: action.track.id }]) };
          }
          for (const action of history) {
            const next = {
              history: action === null ? []
                : "remove" in action ? replay.history.filter((item) => item.id !== action.remove)
                : [action, ...replay.history.filter((item) => item.id !== action.id)].slice(0, 200),
            };
            replay = { ...replay, ...next, deletionSync: recordDeletionChanges(replay, next,
              [action === null ? { kind: "clear", group: "history" }
                : "remove" in action ? { kind: "delete", group: "history", id: action.remove }
                : { kind: "add", group: "history", id: action.id }]) };
          }
          useLibrary.setState({ liked: replay.liked, history: replay.history, deletionSync: replay.deletionSync });
        };
      },
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 1 || state.pinnedSingles == null) {
          return {
            ...state,
            pinnedSingles: { ...PIN_DEFAULTS, v2: true },
          };
        }
        return state;
      },
    }
  )
);
