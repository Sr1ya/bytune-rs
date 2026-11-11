import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { ContextMenu } from "./components/ContextMenu";
import { Dialog } from "./components/primitives";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { prefetchLyrics, LyricsCenter } from "./components/LyricsCenter";
import { NowPlaying } from "./components/NowPlaying";
import { PlaylistPicker } from "./components/PlaylistPicker";
import { Onboarding } from "./views/OnboardingView";
import { PlayerBar } from "./components/PlayerBar";
import { RightRail } from "./components/RightRail";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { engineBoot } from "./lib/audio";
import { installMotionRest } from "./lib/motionRest";
import { initAutoplay } from "./lib/autoplay";
import { setAmbientFromArtwork } from "./lib/ambient";
import { listenForDownloadProgress } from "./lib/downloads";
import { listenForOpenedFiles } from "./lib/openedFiles";
import { watchSpotify } from "./lib/spotify";
import { listenForRooms } from "./lib/rooms";
import { FileDropOverlay } from "./components/FileDropOverlay";
import { LYRICS_NUDGE_STEP, useLyricsNudge } from "./lib/lyricsOffset";
import { watchMenuCommands } from "./lib/menuCommands";
import { watchUpdateNotice } from "./lib/updates";
import { usePanelDrop } from "./lib/panelDrop";
import { CoverGlow } from "./components/CoverGlow";
import { PanelScrollbar } from "./components/PanelScrollbar";
import { watchSession, useSession } from "./lib/session";
import { watchSyncRestores } from "./lib/syncRestore";
import { createSwipeNav, scrollsSideways, SWIPE_LIFT_MS, type SwipeDir, type SwipeUpdate } from "./lib/swipeNav";
import { SwipeArrow, swipeArrow } from "./components/SwipeArrow";
import { takeOnboardingIntent } from "./lib/onboardingIntent";
import { startPipSync } from "./pip/pipSync";
import { usePlayer } from "./stores/player";
import { useLibrary } from "./stores/library";
import { useSettings } from "./stores/settings";
import { useUI } from "./stores/ui";
import { AlbumView } from "./views/AlbumView";
import { ArtistView } from "./views/ArtistView";
import { DownloadsView } from "./views/DownloadsView";
import { FolderView } from "./views/FolderView";
import { ExploreView } from "./views/ExploreView";
import { HomeView } from "./views/HomeView";
import { RemotePlaylistView } from "./views/RemotePlaylistView";
import { MatchedPlaylistView } from "./views/MatchedPlaylistView";
import { SpotifyView } from "./views/SpotifyView";
import { LibraryView } from "./views/LibraryView";import { LocalMusicView } from "./views/LocalMusicView";
import { PlaylistView } from "./views/PlaylistView";
import { ReplayView } from "./views/ReplayView";
import { PodcastView } from "./views/PodcastView";
import { PodcastsView } from "./views/PodcastsView";
import { MoodView } from "./views/MoodView";
import { SearchView } from "./views/SearchView";
import { SettingsView } from "./views/SettingsView";

function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          // On the Settings page Ctrl/Cmd+F searches the settings instead.
          const el = (document.getElementById("settings-filter") ??
            document.getElementById("global-search")) as HTMLInputElement | null;
          el?.focus();
          el?.select();
        }
        return;
      }
      // Chrome: in plain fullscreen, Escape leaves it — even while a field is
      // focused. (NowPlaying's own Escape path below closes the cinematic
      // view, which takes the fullscreen with it.)
      // A modal dialog is the topmost layer and owns the keyboard (Escape /
      // Enter via its own capture listener); without this guard Space toggled
      // playback behind a confirm dialog, and preventDefault kept the
      // focused Confirm button dead.
      // A menu or the playlist picker drives the keyboard while open: arrows and
      // Space must not also change the volume, seek or toggle playback.
      const layer = useUI.getState();
      if (layer.dialog || layer.contextMenu || layer.playlistPicker) return;
      if (e.key === "Escape") {
        const ui = useUI.getState();
        // A context menu is the topmost layer and owns Escape: its own
        // listener folds the submenu first, then dismisses the menu. Without
        // this guard the same keystroke also closed the queue/lyrics panels
        // underneath it.
        if (ui.contextMenu) return;
        if (ui.osFullscreen && !ui.nowPlayingOpen) {
          void window.bytune?.setFullScreen(false);
          return;
        }
      }
      if (typing) return;

      const ui = useUI.getState();
      if (e.key === "Escape") {
        if (ui.nowPlayingOpen) ui.toggleNowPlaying();
        else if (ui.rightPanel === "queue" || ui.rightPanel === "room" || ui.lyricsCenter) ui.closePanels();
        return;
      }

      // Held keys: only the plain arrow ramps (seek/volume) may repeat.
      // Every other shortcut machine-guns on key repeat — Space strobes
      // play/pause, KeyN strobes the fullscreen view, Shift+arrows skip a
      // whole track per repeat event.
      const isPlainArrow =
        !e.shiftKey &&
        !e.altKey &&
        (e.code === "ArrowRight" || e.code === "ArrowLeft" || e.code === "ArrowUp" || e.code === "ArrowDown");
      if (e.repeat && !isPlainArrow) return;

      const player = usePlayer.getState();
      switch (e.code) {
        case "Space":
          e.preventDefault();
          player.toggle();
          break;
        case "ArrowRight":
          if (e.altKey) {
            e.preventDefault();
            ui.goForward();
          } else if (e.shiftKey) player.next(true);
          else player.seek(player.position + 5);
          break;
        case "ArrowLeft":
          if (e.altKey) {
            e.preventDefault();
            ui.goBack();
          } else if (e.shiftKey) player.prev();
          else player.seek(player.position - 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          player.setVolume(player.volume + 0.05);
          break;
        case "ArrowDown":
          e.preventDefault();
          player.setVolume(player.volume - 0.05);
          break;
        case "KeyM":
          player.toggleMute();
          break;
        case "KeyS":
          player.toggleShuffle();
          break;
        case "KeyR":
          player.cycleRepeat();
          break;
        case "KeyQ":
          ui.toggleQueue();
          break;
        case "KeyL":
          ui.toggleLyrics();
          break;
        case "KeyN":
          ui.toggleNowPlaying();
          break;
        case "BracketLeft":
        case "BracketRight": {
          // This song's lyrics timing, while lyrics are on screen.
          const id = player.queue[player.index]?.id;
          if (!id || (!ui.lyricsCenter && !ui.nowPlayingOpen)) break;
          useLyricsNudge.getState().nudge(id, e.code === "BracketLeft" ? -LYRICS_NUDGE_STEP : LYRICS_NUDGE_STEP);
          break;
        }
        case "Slash": {
          e.preventDefault();
          // Like Ctrl/Cmd+F: select the old query so typing replaces it.
          const field = document.getElementById("global-search") as HTMLInputElement | null;
          field?.focus();
          field?.select();
          break;
        }
        default:
          break;
      }
    };
    // The mouse's back/forward side buttons walk the view history.
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) useUI.getState().goBack();
      else useUI.getState().goForward();
    };
    // So do two-finger trackpad swipes, as in Chrome: an arrow follows the
    // swipe out of the panel's edge, and letting go past the line takes the
    // step. Not under a dialog or a menu, nor in full-screen Now Playing,
    // where the page that would change is out of sight.
    const swipe = createSwipeNav();
    let settle = 0;
    const blocked = (): boolean => {
      const ui = useUI.getState();
      return !!(ui.dialog || ui.contextMenu || ui.playlistPicker || ui.nowPlayingOpen);
    };
    const apply = (u: SwipeUpdate | null): void => {
      if (!u) return;
      if (u.kind === "track") swipeArrow.track(u.dir, u.progress);
      else if (u.kind === "cancel" || blocked()) swipeArrow.cancel();
      else {
        swipeArrow.commit();
        const ui = useUI.getState();
        if (u.dir === "back") ui.goBack();
        else ui.goForward();
      }
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.defaultPrevented) return;
      const ui = useUI.getState();
      const open = !blocked();
      const can = (dir: SwipeDir): boolean => open && (dir === "back" ? ui.navPast.length > 0 : ui.navFuture.length > 0);
      apply(swipe.wheel(e, (dx) => scrollsSideways(e.target, dx), can, window.innerWidth));
      // The page never sees the fingers lift: a quiet wheel settles the swipe.
      window.clearTimeout(settle);
      settle = window.setTimeout(() => apply(swipe.quiet(performance.now())), SWIPE_LIFT_MS + 10);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel);
      window.clearTimeout(settle);
      swipeArrow.cancel();
    };
  }, []);
}

/** Artwork-driven ambience: recolors the app atmosphere per track. */
function useAmbient(): void {
  const current = usePlayer((s) => s.queue[s.index] ?? null);

  useEffect(() => {
    void setAmbientFromArtwork(current?.thumb ?? null);
  }, [current?.thumb]);

  // Warm the lyrics cache the moment a track starts, so the lyrics view
  // opens (or flips to the next song) with words already on screen.
  useEffect(() => {
    prefetchLyrics(current);
  }, [current?.id]);
}

/**
 * Applies the appearance settings that act on the whole shell: theme,
 * reduced motion / blur and the liquid-glass recipe land as classes on
 * <html>, so every surface honours them without each component reading the
 * setting itself.
 */
function useAppearance(): void {
  const reduceAnimation = useSettings((s) => s.reduceAnimation);
  const reduceDynamicBlur = useSettings((s) => s.reduceDynamicBlur);
  const liquidGlass = useSettings((s) => s.liquidGlass);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("reduce-motion", reduceAnimation);
    root.classList.toggle("reduce-blur", reduceDynamicBlur);
    root.classList.toggle("noglass", !liquidGlass);
  }, [reduceAnimation, reduceDynamicBlur, liquidGlass]);
}

function CurrentView(): ReactNode {
  const view = useUI((s) => s.view);
  switch (view.name) {
    case "home":
      return <HomeView />;
    case "explore":
      return <ExploreView />;
    case "search":
      return <SearchView />;
    case "library":
    case "playlists":
      return <LibraryView />;
    case "playlist":
      return <PlaylistView playlistId={view.param ?? ""} />;
    case "folder":
      return <FolderView folderId={view.param ?? ""} />;
    case "ytplaylist":
      return <RemotePlaylistView playlistId={view.param ?? ""} />;
    case "import":
      return <MatchedPlaylistView key={view.param} spotifyId={null} importId={view.param ?? ""} />;
    case "spotify":
      return view.param ? <MatchedPlaylistView key={view.param} spotifyId={view.param} /> : <SpotifyView />;
    case "album":
      return <AlbumView albumId={view.param ?? ""} />;
    case "artist":
      return <ArtistView artistId={view.param ?? ""} />;
    case "downloads":
      return <DownloadsView />;
    case "local":
      return <LocalMusicView />;
    case "replay":
      return <ReplayView />;
    case "podcast":
      return view.param ? <PodcastView id={view.param} /> : null;
    case "podcasts":
      return <PodcastsView />;
    case "mood":
      return view.param ? <MoodView params={view.param} /> : null;
    case "settings":
      return <SettingsView />;
    default:
      return <HomeView />;
  }
}

export default function App() {
  const viewName = useUI((s) => s.view.name);
  const viewReloadNonce = useUI((s) => s.viewReloadNonce);
  const pendingScroll = useUI((s) => s.pendingScroll);
  const lyricsCenter = useUI((s) => s.lyricsCenter);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const viewScrollRef = useRef<HTMLDivElement | null>(null);
  const session = useSession();
  const panelDrop = usePanelDrop();

  // Back/forward land the user at the scroll they left the view at. Runs as a
  // layout effect so the offset applies before the first paint of the restored
  // view — no jump. Static pages (Settings) restore exactly; pages that refetch
  // restore as far as their skeleton allows.
  useLayoutEffect(() => {
    if (pendingScroll === null) return;
    const el = document.getElementById("view-scroll");
    if (el) el.scrollTop = pendingScroll;
    useUI.getState().clearPendingScroll();
  }, [pendingScroll, viewName, viewReloadNonce]);

  // Session gate: onboarding until the user picks a mode (or straight in for
  // an existing guest/account). watchSession refreshes on auth:changed.
  useEffect(() => watchSession(), []);

  // Cloud restores land on disk from the main process — rehydrate the
  // zustand stores so the UI picks them up live.
  useEffect(() => watchSyncRestores(), []);

  useEffect(() => {
    const unsubscribe = listenForDownloadProgress();
    return unsubscribe;
  }, []);

  // Audio files opened with ByTune or dropped on the window play at once.
  useEffect(() => listenForOpenedFiles(), []);
  useEffect(() => watchSpotify(), []);
  useEffect(() => listenForRooms(), []);

  // Native miniplayer bridge: push playback snapshots to the PiP window and
  // execute transport commands coming back from it.
  useEffect(() => startPipSync(), []);

  // macOS application menu: commands in (play/pause, navigation…), playback
  // state out (menu checkmarks). No-op off macOS.
  useEffect(() => watchMenuCommands(), []);

  // The old versions' synced "update available" playlist: this version is the update.
  useEffect(() => watchUpdateNotice(), []);

  // No "settle" animation on maximize / restore (ByTune's, for Windows): KWin animates the window
  // itself, and in WebKitGTK a scale + fade of the whole shell re-rendered every surface, glass blurs
  // included, on every frame of it, and replayed on restoring from minimize too. That was the stutter.

  // Plain OS fullscreen (F11, handled in main): mirror the window state so
  // Escape can leave it and the shell knows it is in fullscreen. If fullscreen
  // leaves while the cinematic view is up, close that view too — it only
  // lives inside fullscreen. (A self-driven NowPlaying exit flips the store
  // first, so the guard never re-triggers.)
  useEffect(() => {
    const off = window.bytune?.onFullScreenChange((fs) => {
      const ui = useUI.getState();
      ui.setOsFullscreen(fs);
      if (!fs && ui.nowPlayingOpen) ui.toggleNowPlaying();
    });
    return off;
  }, []);

  useEffect(() => {
    // Boot the audio engine only after persisted state has been rehydrated —
    // player (queue), settings (quality/speed/fades) and library (history)
    // alike, so the first load never reads a default over a saved value.
    const stores = [usePlayer.persist, useSettings.persist, useLibrary.persist];
    const boot = (): void => {
      installMotionRest();
      engineBoot();
      initAutoplay();
    };
    if (stores.every((p) => p.hasHydrated())) {
      boot();
      return;
    }
    const unsubs = stores.map((p) =>
      p.onFinishHydration(() => {
        if (stores.every((x) => x.hasHydrated())) boot();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  // The launch intro (src/intro.ts) shows the app once it's ready: its first screen rendered with
  // the saved settings. With Reduce animation on, the intro stops there instead of finishing.
  useEffect(() => {
    if (!session.loaded) return;
    const ready = (): void => {
      window.dispatchEvent(new CustomEvent("bytune-startup-ready", { detail: { reduceMotion: useSettings.getState().reduceAnimation } }));
    };
    if (useSettings.persist.hasHydrated()) {
      ready();
      return;
    }
    return useSettings.persist.onFinishHydration(ready);
  }, [session.loaded]);

  useKeyboardShortcuts();
  useAmbient();
  useAppearance();

  // First run / reinstall gate — no shell is rendered until a mode is chosen.
  if (!session.loaded) return <div className="h-screen bg-canvas" />;
  if (session.mode === null) return <Onboarding initial={takeOnboardingIntent() ?? "choose"} />;
  if (session.mode === "guest" && session.freshInstall) return <Onboarding initial="resume" />;
  // A fresh Google user must choose their username before entering.
  if (session.mode === "account" && session.needsUsername) return <Onboarding initial="pickusername" />;

  return (
    <div
      ref={shellRef}
      className="h-screen flex flex-col ambient-root text-ink overflow-hidden select-none origin-center"
    >
      {/* display: contents, so the layout is the shell's own; the box only lets full-screen Now
          Playing switch the whole shell's painting off while it covers it (html.np-open). */}
      <div className="shell-under contents">
      <TopBar />
      {/* Three-pane shell: sidebar · content · right rail, over a black canvas.
          8px gaps and side padding; 4px strip above the play bar (Spotify). */}
      <div className="flex flex-1 min-h-0 gap-2 px-2 pb-1">
        <Sidebar />
        <main
          className="flex-1 min-w-0 flex flex-col bg-surface rounded-2xl overflow-hidden relative"
          {...panelDrop.props}
        >
          {/* Full-panel drop highlight — same design as the sidebar rows'
              hover, drawn over the whole surface while a song is over a
              page that accepts it (open playlist / liked / local folder). */}
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-0 z-30 rounded-2xl ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.08] transition-opacity duration-150 ${
              panelDrop.hovering ? "opacity-100" : "opacity-0"
            }`}
          />
          <CoverGlow />
          <SwipeArrow />
          {lyricsCenter ? (
            <LyricsCenter />
          ) : (
            <>
              {/* No native scrollbar: it would take a strip of its own and cut
                  full-bleed covers short of the panel's right edge.
                  PanelScrollbar draws the thumb over the page instead. */}
              <div ref={viewScrollRef} className="flex-1 min-h-0 overflow-y-auto no-scrollbar relative" id="view-scroll">
                {/* The reload nonce rides in the key: a bump remounts the current
                    view so its data effects re-run — that is the Refresh button's
                    mechanism everywhere except Home (which re-orchestrates its
                    feed without a remount). */}
                <div key={`${viewReloadNonce}:${viewName}`} className="view-page animate-rise-in px-10 pt-5 pb-6">
                  <ErrorBoundary>
                    <CurrentView />
                  </ErrorBoundary>
                </div>
              </div>
              <PanelScrollbar target={viewScrollRef} />
              {/* Frosted band behind the search filter row. It lives OUTSIDE
                  the scroller, so it stays put over the panel's full width
                  (clipped by main's rounded corners) and reads the list's
                  scroll through the shared timeline hoisted by timeline-scope
                  on <main>. Tree order puts it above the scrolling rows; the
                  sticky pills (z-10 inside the scroller) paint above it, so
                  they stay sharp while the rows behind them blur. */}
              {viewName === "search" && (
                <div aria-hidden className="search-band pointer-events-none absolute inset-x-0 top-0 h-16" />
              )}
            </>
          )}
        </main>
        <RightRail />
      </div>
      <PlayerBar />
      </div>
      <NowPlaying />
      <Dialog />
      <PlaylistPicker />
      <ContextMenu />
      <FileDropOverlay />
      <Toasts />
    </div>
  );
}