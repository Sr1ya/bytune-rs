/**
 * Connect Spotify as the page sees it: connected or not, the account's name, and its playlists
 * for the sidebar. The session itself never leaves main (electron/spotify.ts).
 */
import { create } from "zustand";
import { hasBridge, requireBridge } from "./bridge";
import { useUI } from "../stores/ui";
import type { SpotifyPlaylistInfo, SpotifyStatus } from "../types";

/** An IPC error's own message, without Electron's "Error invoking remote method" prefix. */
export function ipcMessage(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "";
  return text || fallback;
}

interface SpotifyState {
  status: SpotifyStatus;
  playlists: SpotifyPlaylistInfo[];
  /** the sign-in window is open */
  connecting: boolean;
  refresh(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export const useSpotify = create<SpotifyState>((set, get) => ({
  status: { connected: false },
  playlists: [],
  connecting: false,
  refresh: async () => {
    if (!hasBridge()) return;
    const bridge = requireBridge();
    const status = await bridge.spotifyStatus();
    set({ status, ...(status.connected ? {} : { playlists: [] }) });
    if (!status.connected) return;
    try {
      set({ playlists: await bridge.spotifyPlaylists() });
    } catch {
      // the failure is in the status now ("session has ended", "Spotify changed something")
    }
    set({ status: await bridge.spotifyStatus() });
  },
  connect: async () => {
    if (get().connecting) return;
    set({ connecting: true });
    try {
      set({ status: await requireBridge().spotifyConnect() });
      await get().refresh();
    } finally {
      set({ connecting: false });
    }
  },
  disconnect: async () => {
    set({ status: await requireBridge().spotifyDisconnect(), playlists: [] });
  },
}));

/**
 * Keeps the connected account's playlists current: read at start, again whenever ByTune comes back
 * to the front (a playlist just made in Spotify shows up), and every few minutes.
 */
export function watchSpotify(): () => void {
  let last = 0;
  const reread = (): void => {
    if (Date.now() - last < 15_000) return;
    last = Date.now();
    void useSpotify.getState().refresh().catch(() => undefined);
  };
  const whenConnected = (): void => {
    if (useSpotify.getState().status.connected) reread();
  };
  reread();
  window.addEventListener("focus", whenConnected);
  const timer = window.setInterval(whenConnected, 5 * 60_000);
  return () => {
    window.removeEventListener("focus", whenConnected);
    window.clearInterval(timer);
  };
}

/** Opens Spotify's sign-in and says how it went; true once connected. */
export async function connectSpotify(): Promise<boolean> {
  const ui = useUI.getState();
  try {
    await useSpotify.getState().connect();
  } catch (err) {
    ui.toast(ipcMessage(err, "Couldn't connect Spotify."), "error");
    return false;
  }
  const { status } = useSpotify.getState();
  if (status.problem) ui.toast(status.problem, "error");
  else if (status.connected) ui.toast(`Connected Spotify${status.name ? ` as ${status.name}` : ""}`, "success");
  return status.connected && !status.problem;
}

/** A playlist of the connected account on Spotify's web player ("liked": its Liked Songs). */
export function spotifyUrl(id: string): string {
  return id === "liked" ? "https://open.spotify.com/collection/tracks" : `https://open.spotify.com/playlist/${encodeURIComponent(id)}`;
}

/** Disconnect, asking first (Settings › Connected services, and the Spotify page's own menu). */
export function askToDisconnectSpotify(): void {
  const ui = useUI.getState();
  ui.openDialog({
    title: "Disconnect Spotify?",
    body: "ByTune forgets your Spotify session and its playlists here. Playlists you saved to your library stay.",
    confirmLabel: "Disconnect",
    danger: true,
    onConfirm: () => void useSpotify.getState().disconnect().then(() => ui.toast("Spotify disconnected")),
  });
}

/** The Spotify row while nothing is connected: asks first, then shows the playlists once connected. */
export function askToConnectSpotify(): void {
  useUI.getState().openDialog({
    title: "Connect Spotify",
    body: "Sign in to Spotify in a window of its own, and your playlists and Liked Songs show up here, played from YouTube Music. ByTune reads them the way Spotify's web player does, which isn't an official Spotify feature, so it may stop working.",
    confirmLabel: "Connect",
    onConfirm: () =>
      void connectSpotify().then((ok) => {
        if (ok) useUI.getState().navigate({ name: "spotify" });
      }),
  });
}
