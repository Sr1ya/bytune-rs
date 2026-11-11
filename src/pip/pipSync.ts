/**
 * pipSync — the main window's side of the native PiP bridge.
 *
 * The main window owns the audio engine and is the single source of truth:
 * every player/library change is serialized into a compact snapshot and
 * pushed to the miniplayer window; transport commands arriving from the PiP
 * are applied straight onto the same stores the playbar and fullscreen
 * player use. No second player, no duplicated state.
 *
 * Note: no rAF/timer coalescing on purpose. Hidden/throttled windows stall
 * timers, but store writes from media element events still run — sending
 * synchronously keeps the PiP's slider live even while the main window is
 * minimized.
 */
import { creditNames } from "../lib/replayFormat";
import { searchPageOnce } from "../lib/searchOnce";
import { resolveArtistMeta } from "../stores/artistMeta";
import { useLibrary } from "../stores/library";
import { shownTrack, usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { SearchPageResult, Track } from "../types";
import type { PipCommand, PipSnapshot } from "./types";

function buildSnapshot(): PipSnapshot {
  const p = usePlayer.getState();
  const track = shownTrack(p);
  const lib = useLibrary.getState();
  return {
    track: track
      ? {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album ?? "",
          thumb: track.thumb ?? "",
        }
      : null,
    playing: p.playing,
    buffering: p.buffering,
    position: p.position,
    duration: p.duration,
    volume: p.volume,
    muted: p.muted,
    shuffle: p.shuffle,
    repeat: p.repeat,
    liked: track ? lib.liked.some((t) => t.id === track.id) : false,
  };
}

/** The album / artist page a song links to. Songs played from a search row
 *  often come without an album id and local files carry neither, so the
 *  album falls back to the song's twin on the Songs search tab (whose rows
 *  carry it), the artist to a lookup by the first credited name. */
async function pageOf(t: Track, to: "album" | "artist"): Promise<string | undefined> {
  if (to === "artist") return t.artistId ?? (await resolveArtistMeta(creditNames(t.artist)[0] ?? t.artist))?.id;
  if (t.albumId) return t.albumId;
  try {
    const { rows } = (await searchPageOnce(`${t.title} ${t.artist}`, "songs")) as SearchPageResult;
    const songs = rows.flatMap((r) => (r.kind === "browse" ? [] : [r.song]));
    return (songs.find((s) => s.id === t.id) ?? songs.find((s) => s.title === t.title && s.artist === t.artist))?.albumId;
  } catch {
    return undefined;
  }
}

function execute(command: PipCommand): void {
  if (!command || typeof command !== "object") return;
  const p = usePlayer.getState();
  switch (command.type) {
    case "toggle":
      p.toggle();
      break;
    case "next":
      p.next(true);
      break;
    case "prev":
      p.prev();
      break;
    case "seek":
      if (typeof command.sec === "number" && Number.isFinite(command.sec)) p.seek(command.sec);
      break;
    case "volume":
      if (typeof command.v === "number" && Number.isFinite(command.v)) p.setVolume(command.v);
      break;
    case "mute":
      p.toggleMute();
      break;
    case "shuffle":
      p.toggleShuffle();
      break;
    case "repeat":
      p.cycleRepeat();
      break;
    case "like": {
      // The song the PiP shows — mid-crossfade that's the one fading in.
      const t = shownTrack(p);
      if (t) useLibrary.getState().toggleLike(t);
      break;
    }
    case "open": {
      // The PiP's title / artist links. The page must not open hidden behind
      // the full-screen player.
      const t = shownTrack(p);
      const to = command.to;
      if (!t || (to !== "album" && to !== "artist")) break;
      void pageOf(t, to).then((param) => {
        if (!param) return;
        const ui = useUI.getState();
        if (ui.nowPlayingOpen) ui.toggleNowPlaying();
        ui.navigate({ name: to, param });
      });
      break;
    }
    default:
      break;
  }
}

/** Wire up the bridge; returns a detach function. No-op in a plain browser. */
export function startPipSync(): () => void {
  const bridge = window.bytune;
  if (!bridge?.pipSendState || !bridge.onPipCommand) return () => {};

  // Snapshot building costs an O(liked) scan plus a stringify per store
  // change (~4Hz while playing), and the main process drops pip:state when no
  // miniplayer exists — so do that work only while a PiP window is open. The
  // open/close events and the need-state request on open keep this exact.
  let pipOpen = false;
  const offOpen = bridge.onPipOpenChange?.((open) => {
    pipOpen = open;
    if (open) push(true);
  }) ?? (() => {});
  void bridge.pipIsOpen?.().then((open) => {
    // Covers a PiP that survived a main-window reload (sign-in/out).
    pipOpen = open;
    if (open) push(true);
  });

  let last = "";
  const push = (force = false): void => {
    if (!pipOpen && !force) return;
    const snapshot = buildSnapshot();
    const json = JSON.stringify(snapshot);
    if (!force && json === last) return;
    last = json;
    bridge.pipSendState?.(snapshot);
  };

  const unsubPlayer = usePlayer.subscribe(() => push());
  const unsubLibrary = useLibrary.subscribe(() => push());
  // The PiP just (re)opened — resend a full snapshot so it never sits empty
  // waiting for the next state change. need-state only fires from a live PiP
  // window, so it also repairs a stale isOpen reply that raced an
  // open-changed event and would otherwise suppress every push.
  const offNeed = bridge.onPipNeedState?.(() => {
    pipOpen = true;
    push(true);
  }) ?? (() => {});
  const offCommand = bridge.onPipCommand((raw) => execute(raw as PipCommand));

  push();
  return () => {
    unsubPlayer();
    unsubLibrary();
    offNeed();
    offCommand();
    offOpen();
  };
}
