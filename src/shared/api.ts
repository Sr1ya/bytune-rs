/**
 * The bridge between the React UI and the Rust backend (src-tauri).
 *
 * ByTune's Electron preload exposed `window.bytune` and routed every call over
 * `ipcRenderer` channels such as "music:search". This file keeps that exact API
 * surface so the UI runs unchanged, but sends each call to a single Tauri command
 * (`ipc`) that dispatches on the same channel names in Rust (src-tauri/src/ipc.rs).
 * Backend → UI pushes arrive as Tauri events named after the old channels.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import type {
  DownloadProgress, ImportedPlaylist, ImportSong, MoodPage, PodcastPage, PodcastShelf, RadioPage, RoomChange, RoomView, SearchSuggestion,
  SpotifyPlaylistInfo, SpotifyStatus, Track,
} from "../types";
import type { LocalTrack, UpdateState } from "./backend-types";

/** A request/response call: resolves with the handler's value, rejects with its error message. */
async function call<T = any>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await invoke("ipc", { channel, args })) as T;
  } catch (err) {
    throw new Error(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
  }
}

/** Fire-and-forget, like ipcRenderer.send. */
function send(channel: string, ...args: unknown[]): void {
  void invoke("ipc", { channel, args }).catch(() => undefined);
}

/** Subscribe to a backend event; the returned function unsubscribes (safe before listen resolves). */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let dead = false;
  void listen<T>(channel, (e) => cb(e.payload)).then((u) => {
    if (dead) u();
    else unlisten = u;
  });
  return () => {
    dead = true;
    unlisten?.();
  };
}

let appVersion = "0.1.0";

/** The OS, in Node's spelling (what ByTune's UI was written against): the title bar, caption buttons
    and a few settings differ by platform. Read off the webview, which knows where it runs. */
function detectPlatform(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(ua)) return "darwin";
  if (/Windows/.test(ua)) return "win32";
  return "linux";
}
void getVersion().then((v) => {
  appVersion = v;
  api.versions.app = v;
}).catch(() => undefined);

const api = {
  platform: detectPlatform(),
  versions: {
    app: appVersion,
    electron: "",
    chrome: "",
    node: "",
  },

  // Music (src-tauri/src/music.rs: raw InnerTube + rustypipe)
  search: (query: string, light = false) => call("music:search", query, light),
  searchPage: (query: string, filter: string) => call("music:searchPage", query, filter),
  searchMore: (token: string, filter: string) => call("music:searchMore", token, filter),
  suggestions: (query: string): Promise<{ items: SearchSuggestion[] }> => call("music:suggestions", query),
  getAlbum: (id: string) => call("music:album", id),
  getArtist: (id: string) => call("music:artist", id),
  getPlaylist: (id: string) => call("music:playlist", id),
  getPlaylistPage: (id: string) => call("music:playlistPage", id),
  getHome: () => call("music:home"),
  getRadio: (id: string, token?: string): Promise<RadioPage> => call("music:radio", id, token ?? null),
  getCharts: () => call("music:charts"),
  getMoods: () => call("music:moods"),
  getMoodCovers: (browseId: string, params: string): Promise<string[]> => call("music:moodCovers", browseId, params),
  getMoodPage: (browseId: string, params: string): Promise<MoodPage> => call("music:moodPage", browseId, params),
  marketInfo: () => call("market:current"),
  getLyrics: (track: { id: string; title: string; artist: string; album?: string; duration?: number }) => call("music:lyrics", track),
  enrichDurations: (ids: string[]) => call("music:enrich", ids),
  playbackEvent: (event: { type: string; track?: unknown; positionSec: number; playedSec: number; deltaMs: number }): Promise<void> =>
    call("playback:event", event).catch(() => undefined),
  statsSummary: (period: string) => call("stats:summary", period),
  getStreamUrl: (id: string, forceRotate = false, quality?: string) => call("music:stream", id, forceRotate, quality ?? null),
  localLibrary: () => call("library:get"),
  scanLibrary: (filterNonMusic = true) => call("library:scan", filterNonMusic),
  setLibraryFolders: (folders: string[]) => call("library:setFolders", folders),
  addLibraryFolders: (paths: string[]) => call("library:addFolders", paths),
  renameLibraryFolder: (folderPath: string, displayName: string) => call("library:renameFolder", folderPath, displayName),
  removeLibraryFolder: (folderPath: string) => call("library:removeFolder", folderPath),
  libraryFolderStatuses: () => call("library:folderStatuses"),
  localTrackUrl: (id: string) => call("library:trackurl", id),
  localArtBytes: async (thumb: string): Promise<Uint8Array | null> => {
    const bytes = await call<number[] | null>("library:artbytes", thumb);
    return bytes ? new Uint8Array(bytes) : null;
  },
  remoteArtBytes: async (url: string): Promise<Uint8Array | null> => {
    const bytes = await call<number[] | null>("art:remoteBytes", url);
    return bytes ? new Uint8Array(bytes) : null;
  },
  getCanvas: (q: { title: string; artist: string; album?: string }) => call("canvas:get", q),

  // Updates
  updateState: (): Promise<UpdateState> => call("updates:state"),
  checkForUpdates: (): Promise<void> => call("updates:check"),
  installUpdate: (): Promise<void> => call("updates:install"),
  restartToUpdate: (): Promise<void> => call("updates:restart"),
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => on("updates:changed", cb),

  // Window controls (frameless window — chrome drawn by the UI)
  windowMinimize: () => send("window:minimize"),
  windowMaximizeToggle: () => send("window:maximizeToggle"),
  windowClose: () => send("window:close"),
  isMaximized: () => call<boolean>("window:isMaximized"),
  introDone: () => send("window:introDone"),
  naturalScrolling: (): Promise<boolean | null> => call("input:naturalScrolling"),
  setOverlayChrome: (visible: boolean) => call("window:setOverlayChrome", visible),
  setFullScreen: (fs: boolean) => call("window:setFullScreen", fs),
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => on("window:maximized", cb),
  onFullScreenChange: (cb: (fullscreen: boolean) => void): (() => void) => on("window:fullscreen", cb),

  // Mini player (PiP): a second always-on-top window. State flows main → PiP and
  // commands PiP → main as app-wide events; the backend only opens/closes the window.
  pipToggle: () => call("pip:toggle"),
  pipIsOpen: () => call<boolean>("pip:isOpen"),
  pipClose: () => send("pip:close"),
  pipMinimize: () => send("pip:minimize"),
  pipSetCompact: (on: boolean) => send("pip:compact", on === true),
  pipShowMain: () => send("pip:show-main"),
  pipSendState: (snapshot: unknown) => void emit("pip:state", snapshot),
  pipSendCommand: (command: unknown) => void emit("pip:command", command),
  onPipState: (cb: (snapshot: unknown) => void): (() => void) => on("pip:state", cb),
  onPipCommand: (cb: (command: unknown) => void): (() => void) => on("pip:command", cb),
  onPipOpenChange: (cb: (open: boolean) => void): (() => void) => on("pip:open-changed", cb),
  onPipNeedState: (cb: () => void): (() => void) => on("pip:need-state", () => cb()),
  onPipCursorInside: (cb: (inside: boolean) => void): (() => void) => on("pip:cursor-inside", cb),

  // Persistence (JSON files in the app data directory)
  readData: async (name: string) => {
    try {
      return await call("data:read", name);
    } catch {
      return null;
    }
  },
  writeData: (name: string, data: unknown) => call("data:write", name, data),
  resetData: () => call("app:resetData"),

  // Backup export / import, playlist files (native dialogs in Rust)
  backupExport: () => call("backup:export"),
  playlistExport: (name: string, m3u8: string, json: string): Promise<{ path?: string; cancelled?: boolean }> =>
    call("playlist:export", name, m3u8, json),
  playlistImport: (): Promise<{ name: string; ext: string; text: string } | null> => call("playlist:import"),
  // Spotify: a public playlist link (no sign-in). Connecting a Spotify account isn't ported.
  spotifyPublicPlaylist: (link: string): Promise<ImportedPlaylist> => call("spotify:publicPlaylist", link),
  spotifyStatus: (): Promise<SpotifyStatus> => call("spotify:status"),
  spotifyConnect: (): Promise<SpotifyStatus> => call("spotify:connect"),
  spotifyDisconnect: (): Promise<SpotifyStatus> => call("spotify:disconnect"),
  spotifyPlaylists: (): Promise<SpotifyPlaylistInfo[]> => call("spotify:playlists"),
  spotifyPlaylist: (id: string): Promise<ImportedPlaylist> => call("spotify:playlist", id),
  matchSong: (song: ImportSong, prefer: string): Promise<Track | null> => call("match:song", song, prefer),
  // Rooms need accounts, which this port doesn't include yet: the backend reports no room.
  roomCurrent: (): Promise<RoomView> => call("room:current"),
  roomCreate: (): Promise<RoomView> => call("room:create"),
  roomJoin: (code: string): Promise<RoomView> => call("room:join", code),
  roomLeave: (): Promise<RoomView> => call("room:leave"),
  roomUpdate: (change: RoomChange): Promise<RoomView> => call("room:update", change),
  roomHostOnly: (on: boolean): Promise<RoomView> => call("room:hostOnly", on),
  roomMakeHost: (userId: string): Promise<RoomView> => call("room:makeHost", userId),
  roomRemove: (userId: string): Promise<RoomView> => call("room:remove", userId),
  roomStash: (snapshot: unknown): Promise<void> => call("room:stash", snapshot),
  roomUnstash: (): Promise<unknown> => call("room:unstash"),
  roomTakeInvite: (): Promise<string | null> => call("room:takeInvite"),
  onRoomState: (cb: (view: RoomView) => void): (() => void) => on("room:state", cb),
  onRoomInvite: (cb: () => void): (() => void) => on("room:invite", () => cb()),
  saveReplayImage: (png: Uint8Array, name: string): Promise<{ path?: string; cancelled?: boolean }> =>
    call("replay:saveImage", Array.from(png), name),
  copyReplayImage: (png: Uint8Array): Promise<boolean> => call("replay:copyImage", Array.from(png)),
  localGainDb: (id: string): Promise<number | null> => call("local:gainDb", id),
  getPodcast: (id: string): Promise<PodcastPage> => call("music:podcast", id),
  getPodcasts: (): Promise<PodcastShelf[]> => call("music:podcasts"),
  backupImport: () => call("backup:import"),

  // Accounts: this port runs as a local guest profile only (no Supabase).
  authGetSession: () => call("auth:getSession"),
  authSignUp: (username: string, password: string, displayName: string) => call("auth:signUp", username, password, displayName),
  authSignIn: (username: string, password: string) => call("auth:signIn", username, password),
  authSignInGoogle: () => call("auth:signInGoogle"),
  authContinueGuest: (displayName?: string) => call("auth:continueGuest", displayName ?? null),
  authClearGuestProfile: () => call("auth:clearGuestProfile"),
  authUsernameAvailable: (username: string) => call("auth:usernameAvailable", username),
  authSetUsername: (username: string, displayName?: string) => call("auth:setUsername", username, displayName ?? null),
  authSkipUsername: (displayName?: string) => call("auth:skipUsername", displayName ?? null),
  authSetDisplayName: (name: string) => call("auth:setDisplayName", name),
  authSignOut: () => call("auth:signOut"),
  onAuthChanged: (cb: (info: { mode: string | null; userId: string | null; username: string | null; freshInstall?: boolean }) => void): (() => void) =>
    on("auth:changed", cb),
  syncStatus: () => call("sync:status"),
  syncNow: () => call("sync:now"),
  syncBackupNow: () => call("sync:backupNow"),
  syncRestoreNow: () => call("sync:restoreNow"),
  onSyncRestored: (cb: (info: { stores: string[]; seq: number }) => void): (() => void) => on("sync:restored", cb),

  // Quitting: the backend asks the page to go quiet and save, and quits once it answers.
  onQuitRequest: (cb: () => void): (() => void) => on("app:quit", () => cb()),
  quitReady: () => send("app:quitReady"),
  /** The window was minimized or hidden (true), or is back (false): decorative motion rests meanwhile. */
  onWindowAsleep: (cb: (asleep: boolean) => void): (() => void) => on("window:asleep", cb),

  // Tray menu commands → UI; playback state UI → tray.
  onMenuCommand: (cb: (command: string) => void): (() => void) => on("menu:command", cb),
  menuPushState: (state: { playing: boolean; shuffle: boolean; repeat: "off" | "all" | "one" }) => send("menu:push-state", state),

  // MPRIS (media keys, desktop "now playing"): metadata out, actions back.
  mediaSetMetadata: (track: { title: string; artist: string; album: string; thumb: string } | null) => send("media:metadata", track),
  mediaSetPosition: (position: number, duration: number) => send("media:position", position, duration),
  onMediaAction: (cb: (a: { action: string; seekTime?: number }) => void): (() => void) => on("media:action", cb),

  // Audio files opened with ByTune (command line / "Open with")
  takeOpenedFiles: (): Promise<{ tracks: LocalTrack[]; unplayable: string[] }[]> => call("files:take"),
  onFilesOpened: (cb: () => void): (() => void) => on("files:opened", () => cb()),
  openedFiles: (): Promise<LocalTrack[]> => call("library:opened"),
  forgetOpenedFile: (id: string): Promise<LocalTrack[]> => call("library:forgetOpened", id),

  // Filesystem helpers
  defaultDownloadDir: () => call<string>("app:defaultDownloadDir"),
  pickFolder: () => call<string | null>("app:pickFolder"),
  revealPath: (p: string) => call("app:revealPath", p),
  openPath: (p: string) => call("app:openPath", p),

  // Downloads
  startDownload: (track: Track, dir?: string, quality?: string, exportCompat?: boolean) =>
    call("download:start", track, dir ?? null, quality ?? null, exportCompat === true),
  cancelDownload: (id: string) => call("download:cancel", id),
  downloadQueue: () => call("download:queue"),
  onDownloadEvent: (cb: (e: { type: string; id: string; downloaded?: number; total?: number; path?: string; reason?: string }) => void): (() => void) =>
    on("download:event", cb),
  onDownloadProgress: (cb: (p: DownloadProgress) => void): (() => void) => on("download:progress", cb),
};

export type ByTuneApi = typeof api;

declare global {
  interface Window {
    bytune?: ByTuneApi;
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Installs the bridge when running inside the Tauri shell (a plain browser gets no bridge, as before). */
export function installBridge(): void {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__ && !window.bytune) {
    window.bytune = api;
  }
}
