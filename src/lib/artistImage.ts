/**
 * Artist imagery + album fill for the Now Playing panel.
 *
 * Resolves a real artist photo (and, when the panel's album row is empty, the
 * album name) for the track on screen:
 *  - tracks with an `artistId` (YouTube) resolve through the artist page,
 *    whose photo is a genuine artist image and whose songs carry album names;
 *  - everything else falls back to a name search, taking the top artist hit.
 *
 * Results are cached per key so the panel never refetches on re-renders.
 */
import { useEffect, useState } from "react";
import type { Track } from "../types";

export interface ArtistPanelData {
  /** artist photo, distinct from the track's artwork */
  artistImage: string | null;
  /** album name recovered from artist data, when the track itself lacks one */
  albumFill: string | null;
}

const cache = new Map<string, ArtistPanelData>();

const JUNK_ARTIST = "unknown artist";

/** Songs-filtered lookup — YT song results almost always carry the album that
 * the artist-page and first-pass sources omitted. */
async function resolveAlbumBySongSearch(track: Track): Promise<string | null> {
  try {
    if (!window.bytune?.search) return null;
    const junkArtist = track.artist.trim().toLowerCase() === JUNK_ARTIST;
    const q = [track.title.trim(), junkArtist ? "" : track.artist.trim()].filter(Boolean).join(" ");
    const res = (await window.bytune.search(q)) as {
      songs?: Array<{ title?: string; album?: string; artist?: string }>;
    } | null;
    const norm = (s: string): string => s.trim().toLowerCase();
    const t = norm(track.title);
    const a = norm(track.artist);
    const match = (res?.songs ?? []).find((s) => {
      const st = norm(s.title ?? "");
      // Exact match, or a substring match once both titles are long enough
      // that "Run" can't swallow "Runaway".
      const titleHit =
        st === t || (Math.min(st.length, t.length) >= 6 && (st.includes(t) || t.includes(st)));
      const artistHit = junkArtist || norm(s.artist ?? "").includes(a) || a.includes(norm(s.artist ?? ""));
      return titleHit && artistHit;
    });
    const album = match?.album?.trim();
    return album && album !== "Unknown album" ? album : null;
  } catch {
    return null;
  }
}

async function resolve(track: Track): Promise<ArtistPanelData> {
  // The scan seeds untagged local files with this placeholder — treat it as
  // "no album" so the panel can fill the real one in.
  const needsAlbum = !track.album || track.album === "Unknown album";
  let out: ArtistPanelData = { artistImage: null, albumFill: null };
  try {
    if (track.artistId && window.bytune?.getArtist) {
      const page = (await window.bytune.getArtist(track.artistId)) as {
        artist?: { thumb?: string };
        songs?: Array<{ title?: string; album?: string }>;
      } | null;
      out.artistImage = page?.artist?.thumb ?? null;
      const norm = track.title.trim().toLowerCase();
      const match = page?.songs?.find((s) => (s.title ?? "").trim().toLowerCase() === norm);
      out.albumFill = match?.album ?? null;
    } else if (track.artist && track.artist.trim().toLowerCase() !== JUNK_ARTIST && window.bytune?.search) {
      const res = (await window.bytune.search(track.artist)) as {
        artists?: Array<{ thumb?: string }>;
        songs?: Array<{ title?: string; album?: string; artist?: string }>;
      } | null;
      out.artistImage = res?.artists?.[0]?.thumb ?? null;
      const norm = track.title.trim().toLowerCase();
      const match = res?.songs?.find(
        (s) =>
          (s.title ?? "").trim().toLowerCase() === norm &&
          (s.artist ?? "").toLowerCase().includes(track.artist.trim().toLowerCase())
      );
      out.albumFill = match?.album ?? null;
    }
  } catch {
    /* network/backend hiccups just mean fallbacks */
  }
  if (needsAlbum && !out.albumFill) {
    out.albumFill = await resolveAlbumBySongSearch(track);
  }
  return out;
}

export function useArtistImage(track: Track | null): ArtistPanelData {
  const key = track ? `${track.artistId ?? `name:${track.artist}`}|${track.title}` : "";
  const [data, setData] = useState<ArtistPanelData>(() => (key && cache.has(key) ? cache.get(key)! : { artistImage: null, albumFill: null }));

  useEffect(() => {
    // The track already carries its artist photo — nothing to look up.
    if (!track || track.artistImage) return;
    if (!key) return;
    const cached = cache.get(key);
    if (cached) {
      setData(cached);
      return;
    }
    let cancelled = false;
    setData({ artistImage: null, albumFill: null });
    void resolve(track).then((res) => {
      cache.set(key, res);
      if (!cancelled) setData(res);
    });
    return () => {
      cancelled = true;
    };
  }, [track, key]);

  return track?.artistImage
    ? { artistImage: track.artistImage, albumFill: null }
    : data;
}
