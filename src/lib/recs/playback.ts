/**
 * Playback resolution for recommendation cards.
 *
 * Mixes, stations and radio cards are *descriptions* of a queue, not queues —
 * this module turns a description into real tracks at click time. Every
 * source is grounded in genuine data: an artist's own top songs, their
 * related artists' songs, or a concrete album/playlist.
 *
 * Queue order may shuffle per click (that's what a radio is); the Home feed
 * itself never reshuffles on a whim — that's lib/recs/seeded's job.
 */
import { playAlbum } from "../album";
import { playPlaylist } from "../playlist";
import { requireBridge } from "../bridge";
import { usePlayer } from "../../stores/player";
import { useUI } from "../../stores/ui";
import type { Track } from "../../types";
import { getArtistBundle } from "./candidates";
import { hash32, seededShuffle } from "./seeded";

export type PlaySource =
  | { type: "tracks"; tracks: Track[]; label: string }
  | { type: "artist-mix"; artistId: string; name: string }
  | { type: "artist-radio"; artistId: string; name: string }
  | { type: "album"; albumId: string; name: string }
  | { type: "yt-playlist"; playlistId: string; name: string };

function dedupeById(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    if (!t || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

async function playResolved(tracks: Track[], label: string): Promise<void> {
  if (!tracks.length) {
    useUI.getState().toast(`Couldn't build "${label}" right now`, "error");
    return;
  }
  usePlayer.getState().playQueue(tracks, 0);
}

export async function playSource(source: PlaySource): Promise<void> {
  const ui = useUI.getState();
  try {
    if (source.type === "tracks") {
      await playResolved(dedupeById(source.tracks), source.label);
      return;
    }

    if (source.type === "album") {
      await playAlbum(source.albumId);
      return;
    }

    if (source.type === "yt-playlist") {
      await playPlaylist(source.playlistId);
      return;
    }

    ui.toast(`Loading ${source.name}…`);
    const bundle = await getArtistBundle(source.artistId);
    if (!bundle || bundle.topSongs.length === 0) {
      ui.toast(`Couldn't build "${source.name}" right now`, "error");
      return;
    }

    if (source.type === "artist-mix") {
      // The artist's own songs, freshly shuffled per click — a mix is a
      // queue, so click-time order is fair game.
      const tracks = seededShuffle(dedupeById(bundle.topSongs), hash32(source.artistId) ^ Date.now()).slice(0, 30);
      await playResolved(tracks, source.name);
      return;
    }

    // artist-radio: seed artist + what their related artists bring — the
    // same blend YouTube/Spotify use, from data we already resolve.
    const related = bundle.related.slice(0, 4);
    const relatedBundles = await Promise.all(related.map((a) => getArtistBundle(a.id)));
    const seed = dedupeById(bundle.topSongs);
    const extras: Track[] = [];
    const seenArtists = new Map<string, number>();
    for (const rb of relatedBundles) {
      if (!rb) continue;
      for (const t of rb.topSongs) {
        const n = seenArtists.get(t.artist) ?? 0;
        if (n >= 4) continue; // artist diversity inside the radio
        seenArtists.set(t.artist, n + 1);
        extras.push(t);
      }
    }
    // Interleave: 2 seed songs, then 1 related — the seed stays in charge.
    const mixed: Track[] = [];
    let si = 0;
    let ei = 0;
    const extrasShuffled = seededShuffle(extras, hash32(source.artistId) ^ Date.now());
    while (si < seed.length || ei < extrasShuffled.length) {
      for (let k = 0; k < 2 && si < seed.length; k++) mixed.push(seed[si++]);
      if (ei < extrasShuffled.length) mixed.push(extrasShuffled[ei++]);
    }
    await playResolved(mixed.slice(0, 40), source.name);
  } catch (err) {
    if (!requireBridgeSafe()) ui.toast("Not running inside the ByTune shell", "error");
    else ui.toast(`Couldn't play that right now`, "error");
    void err;
  }
}

function requireBridgeSafe(): boolean {
  try {
    requireBridge();
    return true;
  } catch {
    return false;
  }
}
