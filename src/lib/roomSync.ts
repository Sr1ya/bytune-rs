/**
 * The arithmetic of keeping a room together. Pure, so it is unit-tested; the room client in main
 * (electron/rooms.ts) and the player side (lib/rooms) both use it.
 *
 * A room says where its song is (positionMs) at a moment of the server's clock (anchorMs). Each
 * computer measures how far its clock is from the server's (the offset), works out where the song
 * should be now, and moves only when it's off by more than DRIFT_MS: small differences are
 * inaudible across a voice call, and every correction is a skip.
 */
import type { RoomState, Track } from "../types";

/** How far off a computer may be before it seeks back into place. */
export const DRIFT_MS = 1200;
/** What people type to join: no 0/O, 1/I/L. */
export const ROOM_CODE = /^[A-HJKMNP-Z2-9]{6}$/;
/** A room's queue: up to 100 songs (supabase/migrations/0004; a server still on 0002 takes 25). */
export const MAX_ROOM_QUEUE = 100;

/** A room code out of what was typed or pasted: "abc-234", " ABC234 ", or an invite link. */
export function roomCodeIn(text: string): string | null {
  const link = /^bytune:\/\/room\/([A-Za-z0-9-]+)\/?$/i.exec(text.trim());
  const code = (link ? link[1] : text).replace(/[\s-]/g, "").toUpperCase();
  return ROOM_CODE.test(code) ? code : null;
}

export const inviteLink = (code: string): string => `bytune://room/${code}`;

/** One reading of the server's clock, with this computer's clock just before and after asking. */
export interface ClockSample {
  sentAt: number;
  receivedAt: number;
  serverMs: number;
}

/**
 * The server's clock minus this one's. The reading with the shortest round trip is the surest:
 * the server read its clock somewhere inside the trip, most likely near the middle.
 */
export function clockOffset(samples: readonly ClockSample[]): number | null {
  let best: ClockSample | null = null;
  for (const s of samples) {
    if (s.receivedAt < s.sentAt || !Number.isFinite(s.serverMs)) continue;
    if (!best || s.receivedAt - s.sentAt < best.receivedAt - best.sentAt) best = s;
  }
  return best ? Math.round(best.serverMs - (best.sentAt + best.receivedAt) / 2) : null;
}

/**
 * Where the room's song is at server time `serverNow`, in ms; and, for a start anchored ahead
 * that hasn't come yet, how long until it does (the song waits at `positionMs` meanwhile).
 */
export function roomPosition(s: Pick<RoomState, "positionMs" | "anchorMs" | "playing">, serverNow: number): { ms: number; startsInMs: number } {
  if (!s.playing) return { ms: s.positionMs, startsInMs: 0 };
  const since = serverNow - s.anchorMs;
  return since < 0 ? { ms: s.positionMs, startsInMs: -since } : { ms: s.positionMs + since, startsInMs: 0 };
}

/** Whether this computer's position is far enough from the room's to seek. */
export const offBy = (localMs: number, roomMs: number): boolean => Math.abs(localMs - roomMs) > DRIFT_MS;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/** A song as a room may carry it: a YouTube song, its display fields, nothing of this computer's. */
export function roomTrack(v: unknown): Track | null {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== "object" || typeof t.id !== "string" || !YT_ID.test(t.id)) return null;
  const thumb = text(t.thumb, 2000) ?? "";
  const duration = typeof t.duration === "number" && Number.isFinite(t.duration) && t.duration >= 0 && t.duration < 86_400 ? t.duration : 0;
  return {
    id: t.id,
    title: text(t.title, 300) || "Unknown title",
    artist: text(t.artist, 300) || "Unknown artist",
    duration,
    thumb: /^https:\/\//.test(thumb) ? thumb : "",
    ...(text(t.album, 300) ? { album: text(t.album, 300) } : {}),
    ...(text(t.artistId, 100) ? { artistId: text(t.artistId, 100) } : {}),
    ...(text(t.albumId, 100) ? { albumId: text(t.albumId, 100) } : {}),
    ...(t.explicit === true ? { explicit: true } : {}),
  };
}

const finite = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** A room's state as the server sends it, checked field by field; null when it isn't one. */
export function roomState(v: unknown): RoomState | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== "object") return null;
  const id = text(s.id, 64);
  const code = text(s.code, 6);
  const hostId = text(s.hostId, 64);
  const positionMs = finite(s.positionMs, 0, 86_400_000);
  const anchorMs = finite(s.anchorMs, 0, Number.MAX_SAFE_INTEGER);
  const seq = finite(s.seq, 0, Number.MAX_SAFE_INTEGER);
  if (!id || !code || !ROOM_CODE.test(code) || !hostId || positionMs === null || anchorMs === null || seq === null) return null;
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  return {
    id,
    code,
    hostId,
    hostOnly: s.hostOnly === true,
    track: s.track == null ? null : roomTrack(s.track),
    positionMs,
    anchorMs,
    playing: s.playing === true,
    queue: list(s.queue).map(roomTrack).filter((t): t is Track => !!t).slice(0, MAX_ROOM_QUEUE),
    activity: list(s.activity).flatMap((a) => {
      const e = a as Record<string, unknown>;
      const atMs = finite(e?.atMs, 0, Number.MAX_SAFE_INTEGER);
      const line = text(e?.text, 200);
      return atMs !== null && line ? [{ atMs, text: line }] : [];
    }).slice(0, 20),
    members: list(s.members).flatMap((m) => {
      const e = m as Record<string, unknown>;
      const userId = text(e?.userId, 64);
      const name = text(e?.name, 40);
      const lastSeenMs = finite(e?.lastSeenMs, 0, Number.MAX_SAFE_INTEGER) ?? 0;
      return userId && name ? [{ userId, name, lastSeenMs }] : [];
    }).slice(0, 50),
    seq,
  };
}
