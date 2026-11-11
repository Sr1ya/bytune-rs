/**
 * Sharing playlists without an account: copy a YouTube Music link, or export
 * a playlist as .m3u8 / JSON and import one back. Exports never carry local
 * file paths; imports always create a new playlist (useLibrary.importPlaylist).
 */
import { importFromText } from "./importSongs";
import { useLibrary } from "../stores/library";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
/** YouTube's own playlist maximum: anything past it is skipped. */
const MAX_IMPORT = 5000;

/** The public YouTube Music page for a playlist ("VL" browse prefix dropped). */
export function youtubePlaylistLink(id: string): string {
  return `https://music.youtube.com/playlist?list=${encodeURIComponent(id.replace(/^VL/, ""))}`;
}

/** The public YouTube Music page for an album browse id. */
export function youtubeAlbumLink(browseId: string): string {
  return `https://music.youtube.com/browse/${encodeURIComponent(browseId)}`;
}

export function copyLink(url: string): void {
  void navigator.clipboard
    .writeText(url)
    .then(() => useUI.getState().toast("Link copied"))
    .catch(() => useUI.getState().toast("Couldn't copy link", "error"));
}

const shareable = (tracks: Track[]): Track[] => tracks.filter((t) => YT_ID.test(t.id));

/** ByTune's own JSON playlist file. */
export function playlistToJson(name: string, tracks: Track[]): string {
  return JSON.stringify(
    {
      format: "bytune-playlist",
      version: 1,
      name,
      tracks: shareable(tracks).map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        ...(t.album ? { album: t.album } : {}),
        ...(t.duration ? { duration: Math.round(t.duration) } : {}),
      })),
    },
    null,
    2,
  );
}

/** Extended M3U: one YouTube Music link per song, readable by other players. */
export function playlistToM3u8(name: string, tracks: Track[]): string {
  const clean = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();
  const lines = ["#EXTM3U", `#PLAYLIST:${clean(name)}`];
  for (const t of shareable(tracks)) {
    lines.push(`#EXTINF:${t.duration ? Math.round(t.duration) : -1},${clean(t.artist)} - ${clean(t.title)}`);
    lines.push(`https://music.youtube.com/watch?v=${t.id}`);
  }
  return `${lines.join("\n")}\n`;
}

const trackFrom = (id: string, title: string, artist: string, duration = 0, album?: string): Track => ({
  id,
  title: title.slice(0, 300) || "Unknown title",
  artist: artist.slice(0, 300) || "Unknown artist",
  duration: Number.isFinite(duration) && duration > 0 && duration < 86_400 ? Math.round(duration) : 0,
  thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ...(album ? { album } : {}),
});

/** A YouTube video id out of a watch / youtu.be / music.youtube.com link. */
function videoIdOf(line: string): string | null {
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/.exec(line);
  return m ? m[1] : null;
}

/**
 * A playlist file → name + songs. Reads ByTune JSON and M3U/M3U8 with YouTube
 * links; entries without a YouTube id are counted in `skipped`.
 */
export function parsePlaylistFile(text: string, fallbackName: string): { name: string; tracks: Track[]; skipped: number } {
  const body = text.replace(/^﻿/, "");
  const tracks: Track[] = [];
  let skipped = 0;
  if (body.trimStart().startsWith("{")) {
    let doc: { format?: unknown; name?: unknown; tracks?: unknown };
    try {
      doc = JSON.parse(body);
    } catch {
      return { name: fallbackName, tracks, skipped };
    }
    const rows = doc?.format === "bytune-playlist" && Array.isArray(doc.tracks) ? doc.tracks : [];
    const str = (v: unknown): string => (typeof v === "string" ? v.slice(0, 300) : "");
    for (const r of rows as Record<string, unknown>[]) {
      const id = str(r?.id);
      if (!YT_ID.test(id) || tracks.length >= MAX_IMPORT) {
        skipped++;
        continue;
      }
      tracks.push(trackFrom(id, str(r.title), str(r.artist), Number(r.duration) || 0, str(r.album) || undefined));
    }
    const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim().slice(0, 200) : fallbackName;
    return { name, tracks, skipped };
  }
  let name = fallbackName;
  let pending: { title: string; artist: string; duration: number } | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#PLAYLIST:")) {
      name = line.slice(10).trim().slice(0, 200) || name;
    } else if (line.startsWith("#EXTINF:")) {
      const m = /^#EXTINF:(-?\d+)[^,]*,(.*)$/.exec(line);
      const info = m?.[2] ?? "";
      const dash = info.indexOf(" - ");
      pending = {
        duration: Number(m?.[1]) || 0,
        artist: dash > 0 ? info.slice(0, dash).trim() : "",
        title: dash > 0 ? info.slice(dash + 3).trim() : info.trim(),
      };
    } else if (!line.startsWith("#")) {
      const id = videoIdOf(line);
      if (id && tracks.length < MAX_IMPORT) tracks.push(trackFrom(id, pending?.title ?? "", pending?.artist ?? "", pending?.duration ?? 0));
      else skipped++;
      pending = null;
    }
  }
  return { name, tracks, skipped };
}

/** Save a playlist to a file the listener picks (.m3u8 or .json). */
export async function exportPlaylist(name: string, tracks: Track[]): Promise<void> {
  const ui = useUI.getState();
  if (!shareable(tracks).length) {
    ui.toast("Nothing to export — songs from your computer can't be shared", "info");
    return;
  }
  try {
    const res = await window.bytune?.playlistExport(name, playlistToM3u8(name, tracks), playlistToJson(name, tracks));
    if (res?.path) ui.toast("Playlist exported", "success");
  } catch (err) {
    ui.toast(`Couldn't export: ${err instanceof Error ? err.message : "unknown error"}`, "error");
  }
}

/** Pick an .m3u8 / .json file and add it as a new playlist (a .csv / .txt list is matched first). */
export async function importPlaylistFile(): Promise<void> {
  const ui = useUI.getState();
  try {
    const file = await window.bytune?.playlistImport();
    if (!file) return;
    // A CSV export or a list of song names goes to the import page, to be matched to YouTube Music.
    if (file.ext === "csv" || file.ext === "txt") return importFromText(file.text, file.name);
    const { name, tracks, skipped } = parsePlaylistFile(file.text, file.name);
    if (!tracks.length) {
      ui.toast("No YouTube Music songs found in that file", "error");
      return;
    }
    const playlist = useLibrary.getState().importPlaylist(name, tracks);
    ui.toast(
      skipped ? `Imported ${tracks.length} songs (${skipped} without a YouTube link were skipped)` : `Imported ${tracks.length} songs`,
      "success",
    );
    if (playlist) ui.navigate({ name: "playlist", param: playlist.id });
  } catch (err) {
    ui.toast(`Couldn't import: ${err instanceof Error ? err.message : "unknown error"}`, "error");
  }
}
