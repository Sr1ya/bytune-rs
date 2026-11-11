/**
 * Types for data the Rust backend (src-tauri) returns. They used to live in the
 * Electron main-process modules; the shapes are unchanged so the UI keeps working.
 */

/* ---------------- local library (src-tauri/src/local_library.rs) ---------------- */

export interface LocalTrack {
  /** stable id — hash of the absolute path */
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  /** seconds, 0 = unknown */
  duration: number;
  size: number;
  mtime: number;
  /** localart:// URL for the extracted cover, when one was found */
  art?: string;
  /** the file's own codec */
  codec?: string;
  /** ReplayGain track gain from the tags, dB */
  gainDb?: number;
}

export interface LocalFolderEntry {
  /** normalized absolute path on the user's machine — the reference only */
  path: string;
  /** the folder's own name at import time (fallback display name) */
  name: string;
  /** Display name set by a rename; the disk folder is untouched */
  displayName?: string;
  addedAt: number;
}

export interface LocalLibrary {
  folders: LocalFolderEntry[];
  scannedAt: number;
  tracks: LocalTrack[];
  /** files the last scan left out because their format can't play here, per format */
  unplayable?: { format: string; count: number }[];
}

export interface AddFoldersResult {
  lib: LocalLibrary;
  added: LocalFolderEntry[];
  skipped: string[];
}

export interface FolderStatus {
  path: string;
  exists: boolean;
}

/* ---------------- updates ---------------- */

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";
export interface UpdateState {
  status: UpdateStatus;
  current: string;
  version?: string;
  percent?: number;
  error?: string;
  installs: boolean;
}

/* ---------------- Replay stats (src-tauri/src/stats.rs) ---------------- */

export interface TrackEntry {
  title: string;
  artist: string;
  thumb: string;
  ms: number;
  plays: number;
  lastAt: number;
}
export interface NameEntry {
  name: string;
  artist?: string;
  thumb?: string;
  ms: number;
  plays: number;
}
export type ReplayPeriod = "month" | "lastMonth" | "year" | "all";
export interface ReplaySummary {
  totalMs: number;
  plays: number;
  tracks: (TrackEntry & { id: string })[];
  artists: NameEntry[];
  albums: NameEntry[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: ReplayPeriod;
  months: string[];
  counts: { tracks: number; artists: number; albums: number };
}
