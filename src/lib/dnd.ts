/**
 * Drag-and-drop payloads for the library.
 *
 * Sources (track rows, playlist cards, artist cards — every list in the app)
 * write JSON payloads under private MIME types; targets (the sidebar's Liked
 * Songs, playlists, folders and the library panel itself) read them back —
 * the same model Spotify uses.
 *
 * Also composes the drag ghost: an off-screen chip (artwork + title) the OS
 * renders under the cursor, instead of the default half-row snapshot, plus
 * the `useDrag` hook every source spreads onto its root element.
 */
import { useEffect, useRef, useState } from "react";
import type { Album, Track } from "../types";
import { upgradeArtwork } from "./artwork";

export const TRACK_MIME = "application/x-bytune-track";
export const PLAYLIST_MIME = "application/x-bytune-playlist";
export const ARTIST_MIME = "application/x-bytune-artist";
export const ALBUM_MIME = "application/x-bytune-album";

export interface PlaylistPayload {
  /** YouTube playlist id (VL prefix optional) */
  id: string;
  title: string;
  thumb?: string;
}

export interface ArtistPayload {
  /** YouTube artist channel id */
  id: string;
  name: string;
  thumb?: string;
}

export interface AlbumPayload {
  /** YouTube album/playlist browse id */
  id: string;
  title: string;
  artist?: string;
  thumb?: string;
}

/** The local playlist whose own page a dragged song came from, while that drag lasts. */
let fromPlaylist: string | null = null;

/** Whether the song being dragged came from this playlist's page (it moves there, never gets added again). */
export function draggingFromPlaylist(id: string): boolean {
  return fromPlaylist === id;
}

export function dragHasTrack(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(TRACK_MIME);
}

export function dragHasPlaylist(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(PLAYLIST_MIME);
}

export function dragHasArtist(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(ARTIST_MIME);
}

export function dragHasAlbum(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(ALBUM_MIME);
}

export function readTrack(e: React.DragEvent): Track | null {
  try {
    const raw = e.dataTransfer.getData(TRACK_MIME);
    return raw ? (JSON.parse(raw) as Track) : null;
  } catch {
    return null;
  }
}

export function readPlaylist(e: React.DragEvent): PlaylistPayload | null {
  try {
    const raw = e.dataTransfer.getData(PLAYLIST_MIME);
    return raw ? (JSON.parse(raw) as PlaylistPayload) : null;
  } catch {
    return null;
  }
}

export function readArtist(e: React.DragEvent): ArtistPayload | null {
  try {
    const raw = e.dataTransfer.getData(ARTIST_MIME);
    return raw ? (JSON.parse(raw) as ArtistPayload) : null;
  } catch {
    return null;
  }
}

export function readAlbum(e: React.DragEvent): AlbumPayload | null {
  try {
    const raw = e.dataTransfer.getData(ALBUM_MIME);
    return raw ? (JSON.parse(raw) as AlbumPayload) : null;
  } catch {
    return null;
  }
}

/** Build an album payload from an Album entity. */
export function albumPayload(album: Pick<Album, "id" | "title" | "artist" | "thumb">): AlbumPayload {
  return { id: album.id, title: album.title, artist: album.artist, thumb: album.thumb || undefined };
}

/** Chip the OS shows under the cursor — artwork + title, built off-screen. */
function composeGhost(
  e: React.DragEvent,
  opts: { thumb?: string; title: string; sub: string }
): void {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:-1200px;left:-1200px;display:flex;align-items:center;gap:10px;" +
    "padding:8px 16px 8px 8px;background:#1c1c20;border:1px solid rgba(255,255,255,0.16);" +
    "border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,0.55);" +
    "z-index:2147483647;pointer-events:none;";

  if (opts.thumb) {
    const img = document.createElement("img");
    img.src = upgradeArtwork(opts.thumb);
    img.style.cssText = "width:38px;height:38px;border-radius:8px;object-fit:cover;flex:none;";
    el.appendChild(img);
  }
  const text = document.createElement("div");
  text.style.cssText = "max-width:220px;";
  const title = document.createElement("div");
  title.textContent = opts.title;
  title.style.cssText =
    "font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  const sub = document.createElement("div");
  sub.textContent = opts.sub;
  sub.style.cssText =
    "font-size:11.5px;color:#a7a7a7;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  text.append(title, sub);
  el.appendChild(text);

  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, 18, 18);
  window.setTimeout(() => el.remove(), 0);
}

/** Call from a row/card's onDragStart to make it a track source. */
export function beginTrackDrag(e: React.DragEvent, track: Track): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(TRACK_MIME, JSON.stringify(track));
  e.dataTransfer.setData("text/plain", `${track.title} — ${track.artist}`);
  composeGhost(e, { thumb: track.thumb, title: track.title, sub: track.artist });
}

/** Call from a card's onDragStart to make it a playlist source. */
export function beginPlaylistDrag(e: React.DragEvent, playlist: PlaylistPayload): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(PLAYLIST_MIME, JSON.stringify(playlist));
  e.dataTransfer.setData("text/plain", `${playlist.title} — Playlist`);
  composeGhost(e, { thumb: playlist.thumb, title: playlist.title, sub: "Playlist" });
}

/** Call from a card's onDragStart to make it an artist source. */
export function beginArtistDrag(e: React.DragEvent, artist: ArtistPayload): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(ARTIST_MIME, JSON.stringify(artist));
  e.dataTransfer.setData("text/plain", `${artist.name} — Artist`);
  composeGhost(e, { thumb: artist.thumb, title: artist.name, sub: "Artist" });
}

/** Call from a card's onDragStart to make it an album source. */
export function beginAlbumDrag(e: React.DragEvent, album: AlbumPayload): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(ALBUM_MIME, JSON.stringify(album));
  e.dataTransfer.setData("text/plain", `${album.title} — Album`);
  composeGhost(e, { thumb: album.thumb, title: album.title, sub: album.artist || "Album" });
}

/**
 * Elements whose activation must never become a parent drag (like/options/
 * play buttons, links, inputs). A press that starts inside one of these is
 * always a control interaction — the parent drag is cancelled in onDragStart.
 */
const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, [contenteditable], [data-no-drag]";

/**
 * True when a native drag gesture originated inside an interactive child.
 * The walk stops AT (excluding) the drag root: the root itself is not a
 * "nested control" — the player-bar cover is a <button> that is both
 * clickable AND a drag source, and counting it (target.closest("button")
 * matches the root) cancelled every drag before it started. Nested images
 * are pointer-transparent (see index.css), so the press target inside a
 * button-rooted drag source IS the root button — this check must not treat
 * the root as a nested control.
 */
function dragStartedOnControl(target: EventTarget | null, root: HTMLElement | null): boolean {
  let el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  while (el && el !== root) {
    if (typeof el.matches === "function" && el.matches(INTERACTIVE_SELECTOR)) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Drop target for whole pages (an open playlist, the local folder view): only
 * TRACK drags are accepted — artists, playlists and albums pass straight
 * through and keep the OS "blocked" cursor. Attach `props` to the page root;
 * `hovering` is true while a song is over the page (any child — the contains
 * check keeps child enter/leave pairs from flickering it off).
 *
 * `accepts` (optional, re-read on every dragover) gates the whole target: when
 * it returns false the surface stays a non-target — no drop, no highlight.
 */
export function useTrackDrop(
  onDropTrack: (track: Track) => void,
  accepts?: () => boolean
): {
  hovering: boolean;
  props: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const [hovering, setHovering] = useState(false);
  const cb = useRef(onDropTrack);
  const acceptsRef = useRef(accepts);
  useEffect(() => {
    cb.current = onDropTrack;
    acceptsRef.current = accepts;
  });
  const isAccepted = (e: React.DragEvent): boolean => {
    if (!dragHasTrack(e)) return false;
    return acceptsRef.current ? acceptsRef.current() : true;
  };
  // A drag that ends anywhere (Esc, dropped on a chrome surface) must clear
  // the highlight even if no leave event reached this element.
  useEffect(() => {
    const clear = (): void => setHovering(false);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);
  return {
    hovering,
    props: {
      onDragOver: (e) => {
        if (!isAccepted(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setHovering(true);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovering(false);
      },
      onDrop: (e) => {
        if (!isAccepted(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setHovering(false);
        const track = readTrack(e);
        if (track) cb.current(track);
      },
    },
  };
}

/**
 * The one-liner every draggable surface spreads on its root element:
 *   const drag = useDrag({ track });
 *   <div {...drag.props} className={`… ${drag.dragging ? "opacity-40" : ""}`}>
 *
 * The root is ALWAYS `draggable` — from first render, before any pointer
 * touches it. That is the whole reliability contract: Chromium decides
 * whether a press+move becomes a native drag from the draggable state that
 * exists when the gesture STARTS. Flipping `draggable` on mid-gesture (the
 * old pointer-threshold arming) lands after that decision, so the first
 * attempt silently does nothing and only a later attempt — with the flag
 * accidentally left armed — works. There is no custom threshold here on
 * purpose: the OS already applies its own small movement threshold before
 * firing `dragstart`, so plain clicks (including their 2-3px of jitter)
 * never become drags and click/double-click/context-menu all keep working.
 *
 * Click-vs-drag is therefore decided by the browser, not by us:
 *   press + release without crossing the OS threshold → click fires
 *   press + move past the OS threshold → dragstart fires, click is suppressed
 * A capture-phase click swallow after dragend covers engines that still
 * deliver a synthetic click after a cancelled drag.
 */
export function useDrag(
  payload:
    | { track: Track; fromPlaylist?: string }
    | { playlist: PlaylistPayload }
    | { artist: ArtistPayload }
    | { album: AlbumPayload }
): {
  dragging: boolean;
  props: {
    draggable: boolean;
    onPointerDownCapture: (e: React.PointerEvent) => void;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
    onClickCapture: (e: React.MouseEvent) => void;
  };
} {
  const [dragging, setDragging] = useState(false);
  /** Set on dragstart, cleared on the swallowed click (or a safety timer). */
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | null>(null);
  /**
   * Whether the current press began inside a nested control. Recorded on
   * pointerdown capture — `dragstart` itself fires ON the draggable root,
   * so by then the deep target (the button) is no longer visible.
   */
  const downOnControl = useRef(false);
  /** The element the drag props are spread on — the exclusion boundary. */
  const rootRef = useRef<HTMLElement | null>(null);

  const clearSuppress = (): void => {
    suppressClick.current = false;
    if (suppressTimer.current !== null) {
      window.clearTimeout(suppressTimer.current);
      suppressTimer.current = null;
    }
    document.body.classList.remove("bytune-dragging");
  };

  return {
    dragging,
    props: {
      draggable: true,
      onPointerDownCapture: (e) => {
        rootRef.current = e.currentTarget as HTMLElement;
        downOnControl.current = dragStartedOnControl(e.target, rootRef.current);
      },
      onDragStart: (e) => {
        // Empty placeholders (player bar / details panel with nothing
        // playing) must never start an OS drag.
        if ("track" in payload && !payload.track.id) {
          e.preventDefault();
          return;
        }
        // Presses that begin on a nested control belong to that control:
        // the like/options/play buttons stay clickable and never become a
        // parent drag, no matter how far the pointer travels. The root
        // itself doesn't count (see dragStartedOnControl).
        if (downOnControl.current || dragStartedOnControl(e.target, rootRef.current)) {
          downOnControl.current = false;
          e.preventDefault();
          return;
        }
        if ("track" in payload) beginTrackDrag(e, payload.track);
        else if ("playlist" in payload) beginPlaylistDrag(e, payload.playlist);
        else if ("artist" in payload) beginArtistDrag(e, payload.artist);
        else beginAlbumDrag(e, payload.album);
        fromPlaylist = ("track" in payload && payload.fromPlaylist) || null;
        suppressClick.current = true;
        document.body.classList.add("bytune-dragging");
        setDragging(true);
      },
      onDragEnd: () => {
        fromPlaylist = null;
        downOnControl.current = false;
        setDragging(false);
        // The browser suppresses the post-drag click itself in the common
        // case; this only guards engines that deliver one anyway. The flag
        // clears on that click, or expires shortly after so a later,
        // deliberate click is never eaten.
        if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
        suppressTimer.current = window.setTimeout(clearSuppress, 250);
        document.body.classList.remove("bytune-dragging");
      },
      onClickCapture: (e) => {
        if (!suppressClick.current) return;
        e.preventDefault();
        e.stopPropagation();
        clearSuppress();
      },
    },
  };
}
