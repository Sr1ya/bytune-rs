/**
 * Canvas lookup hook — resolves the current track's looping video artwork
 * once per track, off the render path, only when the user opted in.
 */
import { useEffect, useState } from "react";
import { useSettings } from "../stores/settings";
import type { Track } from "../types";

export interface CanvasClip {
  url: string;
  /** "apple" clips play through playFragmented, the rest as a plain src */
  source: string;
}

export function useCanvas(track: Track | null): CanvasClip | null {
  const enabled = useSettings((s) => s.animatedCanvas);
  const [clip, setClip] = useState<CanvasClip | null>(null);

  useEffect(() => {
    if (!enabled || !track || track.localPath || track.id.startsWith("local:") || !track.thumb) {
      setClip(null);
      return;
    }
    let cancelled = false;
    setClip(null);
    window.bytune
      ?.getCanvas({ title: track.title, artist: track.artist, album: track.album })
      .then((hit) => {
        if (!cancelled && hit?.url) setClip({ url: hit.url, source: String(hit.source ?? "") });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, track?.id]);

  return clip;
}

/**
 * Apple's motion clips are one fragmented MP4 (main finds it in their HLS
 * playlist), and a plain src can't loop one: its timeline starts ten seconds
 * in, so a loop back to 0 lands where there is no picture. Media Source can:
 * the file streams in while it plays, and every loop goes back to its first
 * frame. Returns the cleanup.
 */
export function playFragmented(video: HTMLVideoElement, url: string): () => void {
  const source = new MediaSource();
  const abort = new AbortController();
  const src = URL.createObjectURL(source);
  const first = (): number => (video.buffered.length ? video.buffered.start(0) : 0);
  const restart = (): void => {
    video.currentTime = first();
    void video.play().catch(() => undefined);
  };
  video.addEventListener("ended", restart);
  source.addEventListener(
    "sourceopen",
    async () => {
      try {
        const res = await fetch(url, { signal: abort.signal });
        if (!res.ok || !res.body) return;
        // Main only hands over H.264 renditions; the stream's own profile comes from its init segment.
        const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.640020"');
        const reader = res.body.getReader();
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          buffer.appendBuffer(chunk.value);
          await new Promise((done) => buffer.addEventListener("updateend", done, { once: true }));
          if (video.currentTime < first()) video.currentTime = first();
        }
        source.endOfStream();
      } catch {
        // unmounted, or the clip won't play: the still art underneath stays
      }
    },
    { once: true }
  );
  video.src = src;
  return () => {
    abort.abort();
    video.removeEventListener("ended", restart);
    URL.revokeObjectURL(src);
  };
}
