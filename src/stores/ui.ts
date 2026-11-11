/** Transient UI state: navigation, panels, toasts, context menu, dialogs. */
import type { LucideIcon } from "lucide-react";
import { create } from "zustand";
import type { SearchFilter, Track } from "../types";

export type ViewName =
  | "home"
  | "explore"
  | "search"
  | "library"
  | "playlists"
  | "playlist"
  /** a folder of the listener's playlists (param: its id) */
  | "folder"
  | "ytplaylist"
  | "album"
  | "artist"
  | "downloads"
  | "local"
  | "replay"
  | "podcast"
  | "podcasts"
  | "mood"
  | "settings"
  /** a playlist being imported (lib/importSongs) */
  | "import"
  /** the connected Spotify account's playlists; with a param, one of them (its id, or "liked") */
  | "spotify";

export interface View {
  name: ViewName;
  /** playlist id / album id / etc. */
  param?: string;
}

/** One history slot: the view plus the content scroll it was left at, so
    back/forward can put the user exactly where they were (Settings → local
    folder → back must not land at the top of Settings again). */
export interface NavEntry {
  view: View;
  /** scrollTop of the #view-scroll container when this view was left */
  scroll: number;
}

/** What a menu acts on (a song, a playlist, an album, an artist): drawn at its top, lit by its cover. */
export interface MenuSubject {
  title: string;
  subtitle?: string;
  thumb?: string | null;
  /** an artist: a round picture */
  round?: boolean;
}

export interface MenuItem {
  label?: string;
  /** a second line under the label; the row then shows its icon in a tile (the Create menu) */
  note?: string;
  icon?: LucideIcon;
  /** extra classes for the icon (e.g. fill-accent for a filled pin) */
  iconClassName?: string;
  danger?: boolean;
  disabled?: boolean;
  /** one of a set of choices: true on the chosen one (a check at the right), false on the rest */
  checked?: boolean;
  /** `checked` is this row's own on/off, not one choice among the set (a checkbox: several can be on) */
  toggle?: boolean;
  separatorBefore?: boolean;
  /** section label — rendered as a non-interactive caption */
  header?: boolean;
  /** what the menu acts on: drawn as the menu's header, above everything else, wherever it sits */
  subject?: MenuSubject;
  /** nested menu — opens on hover/click, one at a time */
  children?: MenuItem[];
  action?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /** treat y as the BOTTOM edge — the menu opens upward (playbar buttons) */
  above?: boolean;
  /** treat x as the RIGHT edge — the menu right-aligns to it (settings selects) */
  alignRight?: boolean;
  /** who opened it, so a button can show itself pressed while its menu is up */
  owner?: string;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error" | "warning";
  /** ms before auto-dismiss. The Toasts layer owns the timer (hover pauses it)
      and plays the exit animation before calling dismissToast. */
  duration?: number;
}

/** A modal request — replaces browser prompt()/confirm() with the ByTune dialog. */
export interface DialogRequest {
  title: string;
  body?: string;
  /** when set, the dialog shows a text input pre-filled with this value */
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** only tells the user something: one button, no Cancel */
  notice?: boolean;
  /** a multi-line text field (Enter adds a line, Ctrl/Cmd+Enter confirms) */
  multiline?: boolean;
  onConfirm: (value: string) => void;
}

export interface UIState {
  view: View;
  navPast: NavEntry[];
  navFuture: NavEntry[];
  /** Scroll offset to restore into #view-scroll on the next back/forward
      render — set by goBack/goForward, consumed by App's layout effect. */
  pendingScroll: number | null;
  searchQuery: string;
  searchFilter: SearchFilter;
  /** Right panel mode: song details (default), the Queue sheet, or Rooms. */
  rightPanel: "details" | "queue" | "room";
  /** Synced lyrics rendered in the centre pane over the current view. */
  lyricsCenter: boolean;
  nowPlayingOpen: boolean;
  /** Plain OS fullscreen (F11): the window covers the screen and the taskbar
      is gone; the app's own top bar stays visible. Mirrored from the main
      process — the renderer never writes it. */
  osFullscreen: boolean;
  toasts: Toast[];
  contextMenu: ContextMenuState | null;
  dialog: DialogRequest | null;
  /** songs waiting for the "Add to playlists" picker */
  playlistPicker: Track[] | null;
  /** Artwork URL the pointer is hovering — drives the middle panel's wash.
      null = at rest, the wash wears the playing track's colour. */
  tintThumb: string | null;
  /** Bumped by the TopBar refresh button — Home drops its caches and
      re-orchestrates the feed (see lib/recs/feed + lib/recs/profile). */
  homeReloadNonce: number;
  /** Bumped to re-run the CURRENT view's data lifecycle: App keys the view
      container on it, so a bump remounts the page and its fetch effects. */
  viewReloadNonce: number;

  navigate(view: View): void;
  /** Swap the current view in place, with no history step: a Settings category. Back still leaves
      Settings in one step, and the entry keeps the category for when you come back to it. */
  replaceView(view: View): void;
  /** Show Settings, on `section` when given (a Settings category id). Already open: bring it into
      view (a lyrics overlay may be covering it) without stacking a second Settings entry. */
  openSettings(section?: string): void;
  /** The profile button: open Settings, or close it when it's what you're looking at (back to
      where you were; home when there's nowhere to go back to). */
  toggleSettings(): void;
  goBack(): void;
  goForward(): void;
  setSearchQuery(q: string): void;
  setSearchFilter(f: SearchFilter): void;
  toggleQueue(): void;
  toggleRoom(): void;
  toggleLyrics(): void;
  toggleNowPlaying(): void;
  setOsFullscreen(fs: boolean): void;
  closePanels(): void;
  toast(message: string, kind?: Toast["kind"], duration?: number): void;
  dismissToast(id: number): void;
  setTintThumb(url: string | null): void;
  openContextMenu(x: number, y: number, items: MenuItem[], options?: { above?: boolean; alignRight?: boolean; owner?: string }): void;
  closeContextMenu(): void;
  openDialog(req: DialogRequest): void;
  closeDialog(): void;
  openPlaylistPicker(tracks: Track[]): void;
  closePlaylistPicker(): void;
  bumpHomeReload(): void;
  bumpViewReload(): void;
  clearPendingScroll(): void;
}

let toastSeq = 1;

/** Leaving a card waits this long before the wash goes back to the playing track: crossing the gap to
 *  the next card goes straight to its colour, without a flash of the playing track's in between. */
const TINT_LET_GO_MS = 160;
let tintLetGo: ReturnType<typeof setTimeout> | undefined;

/**
 * Spread onto any card or row that represents playable art (song, album,
 * artist, playlist): while the pointer is over it, the middle panel's glow
 * shows that artwork (see components/CoverGlow). Leaving the card hands the
 * glow back to the playing track.
 */
export function tintHoverHandlers(thumb: string | null | undefined) {
  return {
    onMouseEnter: (): void => {
      clearTimeout(tintLetGo);
      useUI.getState().setTintThumb(thumb ?? null);
    },
    onMouseLeave: (): void => {
      clearTimeout(tintLetGo);
      tintLetGo = setTimeout(() => useUI.getState().setTintThumb(null), TINT_LET_GO_MS);
    },
  };
}

function sameView(a: View, b: View): boolean {
  return a.name === b.name && a.param === b.param;
}

/** The content scroller lives outside React (App's #view-scroll); the nav
    stack reads its offset here so every navigate/back/forward site gets
    scroll memory without each caller passing it along. */
function readViewScroll(): number {
  try {
    return document.getElementById("view-scroll")?.scrollTop ?? 0;
  } catch {
    return 0;
  }
}

export const useUI = create<UIState>((set, get) => ({
  view: { name: "home" },
  navPast: [],
  navFuture: [],
  pendingScroll: null,
  searchQuery: "",
  searchFilter: "all",
  rightPanel: "details" as "details" | "queue" | "room",
  lyricsCenter: false,
  nowPlayingOpen: false,
  osFullscreen: false,
  toasts: [],
  contextMenu: null,
  dialog: null,
  playlistPicker: null,
  tintThumb: null,
  homeReloadNonce: 0,
  viewReloadNonce: 0,

  navigate(view) {
    const { view: current, navPast, lyricsCenter } = get();
    if (sameView(current, view)) {
      // Same destination — but a lyrics overlay may still be hiding it.
      if (lyricsCenter) set({ lyricsCenter: false });
      return;
    }
    // Any navigation reveals the clicked content: the lyrics overlay must
    // not keep covering views the user explicitly navigated to. The wash
    // hover also dies with the pointer's card — React doesn't fire
    // mouseleave on unmount, so clear it here.
    set({
      view,
      navPast: [...navPast.slice(-40), { view: current, scroll: readViewScroll() }],
      navFuture: [],
      lyricsCenter: false,
      tintThumb: null,
      // A new page opens at its top; only back/forward return to a left scroll.
      pendingScroll: 0,
    });
  },

  replaceView(view) {
    if (sameView(get().view, view)) return;
    set({ view, pendingScroll: 0, lyricsCenter: false, tintThumb: null });
  },

  openSettings(section) {
    const { view } = get();
    if (view.name !== "settings") {
      get().navigate(section ? { name: "settings", param: section } : { name: "settings" });
      return;
    }
    set({ lyricsCenter: false });
    if (section) get().replaceView({ name: "settings", param: section });
  },

  toggleSettings() {
    const { view, lyricsCenter, navPast } = get();
    if (view.name !== "settings" || lyricsCenter) {
      get().openSettings();
      return;
    }
    if (navPast.length) get().goBack();
    else get().navigate({ name: "home" });
  },

  goBack() {
    const { navPast, navFuture, view } = get();
    const prev = navPast[navPast.length - 1];
    if (!prev) return;
    set({
      view: prev.view,
      navPast: navPast.slice(0, -1),
      navFuture: [{ view, scroll: readViewScroll() }, ...navFuture.slice(0, 40)],
      pendingScroll: prev.scroll,
      lyricsCenter: false,
    });
  },

  goForward() {
    const { navPast, navFuture, view } = get();
    const next = navFuture[0];
    if (!next) return;
    set({
      view: next.view,
      navPast: [...navPast, { view, scroll: readViewScroll() }],
      navFuture: navFuture.slice(1),
      pendingScroll: next.scroll,
      lyricsCenter: false,
    });
  },

  setSearchQuery(searchQuery) {
    set({ searchQuery });
  },

  setSearchFilter(searchFilter) {
    // A filter flip replaces the result rows in place; the pointer can end up
    // over a row that never sees a mouseenter (the DOM fires no mouseleave
    // when the hovered row unmounts), so hand the wash back to the playing
    // track here instead of leaving it stuck on a removed card's colour.
    set({ searchFilter, tintThumb: null });
  },

  toggleQueue() {
    set({ rightPanel: get().rightPanel === "queue" ? "details" : "queue" });
  },

  toggleRoom() {
    set({ rightPanel: get().rightPanel === "room" ? "details" : "room" });
  },

  toggleLyrics() {
    set({ lyricsCenter: !get().lyricsCenter });
  },

  toggleNowPlaying() {
    set({ nowPlayingOpen: !get().nowPlayingOpen });
  },

  setOsFullscreen(osFullscreen) {
    set({ osFullscreen });
  },

  closePanels() {
    set({ rightPanel: "details", lyricsCenter: false, nowPlayingOpen: false });
  },

  toast(message, kind = "info", duration = 4600) {
    // No self-removal timer here — ToastCard runs the countdown so hover can
    // pause it and the lift-out animation plays before dismissToast.
    const toast: Toast = { id: toastSeq++, message, kind, duration };
    set({ toasts: [...get().toasts, toast].slice(-4) });
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setTintThumb(tintThumb) {
    if (get().tintThumb === tintThumb) return;
    set({ tintThumb });
  },

  openContextMenu(x, y, items, options) {
    set({ contextMenu: { x, y, items, above: options?.above, alignRight: options?.alignRight, owner: options?.owner } });
  },

  closeContextMenu() {
    set({ contextMenu: null });
  },

  openDialog(req) {
    set({ dialog: req });
  },

  openPlaylistPicker(tracks) {
    set({ playlistPicker: tracks });
  },
  closePlaylistPicker() {
    set({ playlistPicker: null });
  },
  closeDialog() {
    set({ dialog: null });
  },

  bumpHomeReload() {
    set({ homeReloadNonce: get().homeReloadNonce + 1 });
  },

  bumpViewReload() {
    set({ viewReloadNonce: get().viewReloadNonce + 1 });
  },

  clearPendingScroll() {
    if (get().pendingScroll !== null) set({ pendingScroll: null });
  },
}));
