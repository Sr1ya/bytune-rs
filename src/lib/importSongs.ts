/**
 * Importing a playlist from outside ByTune: a Spotify link, a CSV export (Exportify, TuneMyMusic
 * and the like), or songs pasted one per line ("Artist - Title"). The songs open on the import
 * page, which matches each to YouTube Music (useSongMatches) before anything is saved.
 */
import { requireBridge } from "./bridge";
import { ipcMessage } from "./spotify";
import { useUI } from "../stores/ui";
import type { ImportedPlaylist, ImportSong } from "../types";

const MAX_SONGS = 5000;

/** One CSV line's cells; quotes may wrap commas and doubled quotes. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

/** CSV rows, keeping line breaks that sit inside quotes. */
function csvRows(text: string): string[][] {
  const rows: string[] = [];
  let row = "";
  for (const line of text.split(/\r?\n/)) {
    row = row ? `${row}\n${line}` : line;
    if ((row.match(/"/g)?.length ?? 0) % 2 === 0) {
      if (row.trim()) rows.push(row);
      row = "";
    }
  }
  return rows.map(csvCells);
}

const column = (header: string[], ...names: RegExp[]): number => header.findIndex((h) => names.some((n) => n.test(h)));

/**
 * A pasted list or a CSV file → songs. A CSV needs a header naming a title column (and ideally
 * artist, album and length); any other text is read a line at a time: "Artist - Title", or just a title.
 */
export function parseSongList(text: string): ImportSong[] {
  const body = text.replace(/^﻿/, "").trim();
  if (!body) return [];
  const first = body.split(/\r?\n/, 1)[0].toLowerCase();
  const rows = first.includes(",") ? csvRows(body) : [];
  const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
  const title = column(header, /^(track|song)( name)?$/, /^title$/, /^name$/);
  const songs: ImportSong[] = [];
  if (title >= 0) {
    const artist = column(header, /^artist( name)?(\(s\))?s?$/, /^artists?$/);
    const album = column(header, /^album( name)?$/);
    const ms = column(header, /^duration( \(ms\)|_ms)$/, /^track duration \(ms\)$/);
    const sec = column(header, /^duration$/, /^length$/);
    for (const r of rows.slice(1)) {
      const t = r[title]?.trim();
      if (!t) continue;
      const duration = ms >= 0 ? Number(r[ms]) / 1000 : sec >= 0 ? clock(r[sec]) : 0;
      songs.push({
        title: t.slice(0, 300),
        // Exportify writes several artists with ";", TuneMyMusic with ","
        artist: (artist >= 0 ? r[artist] ?? "" : "").replace(/\s*;\s*/g, ", ").slice(0, 300),
        ...(album >= 0 && r[album]?.trim() ? { album: r[album].trim().slice(0, 300) } : {}),
        duration: Number.isFinite(duration) && duration > 0 && duration < 86_400 ? Math.round(duration) : 0,
      });
    }
    return songs.slice(0, MAX_SONGS);
  }
  for (const raw of body.split(/\r?\n/)) {
    // "1. ", "12) " and bullet prefixes from copied lists
    const line = raw.replace(/^\s*(?:\d{1,4}[.)]\s+|[-*•]\s+)/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const dash = /\s[-–—]\s/.exec(line);
    songs.push(
      dash
        ? { artist: line.slice(0, dash.index).trim().slice(0, 300), title: line.slice(dash.index + dash[0].length).trim().slice(0, 300), duration: 0 }
        : { artist: "", title: line.slice(0, 300), duration: 0 }
    );
  }
  return songs.filter((s) => s.title).slice(0, MAX_SONGS);
}

/** "3:45" or "225" → seconds. */
function clock(v: string | undefined): number {
  const parts = (v ?? "").trim().split(":").map(Number);
  return parts.some((n) => !Number.isFinite(n)) ? 0 : parts.reduce((acc, n) => acc * 60 + n, 0);
}

const SPOTIFY_LINK = /^(?:https?:\/\/(?:open\.spotify\.com|spotify\.link)\/\S+|spotify:(?:user:\S+:)?playlist:\S+)$/i;
export const isSpotifyLink = (text: string): boolean => SPOTIFY_LINK.test(text.trim());

type PendingImport = ImportedPlaylist & { fromSpotify: boolean };
/** Each import opens its own page (route param = its id), kept for the session so Back returns to it. */
const imports = new Map<string, PendingImport>();
let lastImport = 0;
export const pendingImport = (id: string): PendingImport | null => imports.get(id) ?? null;

function open(playlist: ImportedPlaylist, fromSpotify: boolean): void {
  const id = String(++lastImport);
  imports.set(id, { ...playlist, fromSpotify });
  // shortcut: the 10 newest imports stay reachable by Back; older pages say "Nothing to import".
  for (const old of [...imports.keys()].slice(0, -10)) imports.delete(old);
  useUI.getState().navigate({ name: "import", param: id });
}

/** What the import dialog was given: a Spotify link, or a list of songs. */
export async function importFromText(text: string, name = "Imported playlist"): Promise<void> {
  const ui = useUI.getState();
  const input = text.trim();
  if (!input) return;
  if (isSpotifyLink(input)) {
    ui.toast("Reading the Spotify playlist…");
    try {
      open(await requireBridge().spotifyPublicPlaylist(input), true);
    } catch (err) {
      ui.toast(ipcMessage(err, "Couldn't read that playlist."), "error");
    }
    return;
  }
  const songs = parseSongList(input);
  if (!songs.length) {
    ui.toast("No songs found. Paste a Spotify playlist link, or one song per line (Artist - Title).", "error");
    return;
  }
  open({ name, songs, total: songs.length }, false);
}
