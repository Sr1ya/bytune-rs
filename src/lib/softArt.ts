/**
 * Covers blurred into light, made once instead of every frame.
 *
 * The cover glow behind the middle panel and the Now Playing backdrop used CSS `filter: blur(90-100px)`
 * on half-window-sized layers. WebKitGTK re-applies a layer's filter whenever it composites, so every
 * frame of anything moving on screen (the glow's own 600 ms cross-fade on a song change, the progress
 * bar, a backdrop drift) re-blurred them: measured, it doubled the time to the first sound of a new
 * song and blocked the page for ~2 s per song change.
 *
 * A blur that wide keeps no detail, so the cover is drawn into a tiny canvas, blurred and colour-graded
 * there (the same saturate/brightness maths as the CSS filters), and shown upscaled: the browser's
 * smooth upscaling finishes the blur. The page then composites a plain image.
 */
import { useEffect, useState } from "react";
import { loadArtworkImage } from "./ambient";
import { artworkFor } from "./artwork";

export interface SoftArtOptions {
  /** Blur as a CSS blur radius (std-dev) in CSS px, and the size the art is shown at. */
  blurPx: number;
  shownW: number;
  shownH: number;
  /** CSS saturate() / brightness() amounts, applied after the blur like `filter: blur() saturate() brightness()`. */
  saturate?: number;
  brightness?: number;
}

const N = 40;
const MAX = 32;
/** Blurred-but-ungraded pixels per cover and blur, and finished data URLs per full recipe. */
const bases = new Map<string, Promise<Uint8ClampedArray | null>>();
const done = new Map<string, string>();

function remember<V>(map: Map<string, V>, key: string, value: V): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX) map.delete(map.keys().next().value!);
  return value;
}

/** Radius of a box blur that, run three times, matches a Gaussian of std-dev `sigma` (in texels). */
const boxRadius = (sigma: number): number => Math.max(0, Math.round((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2));

function boxPass(src: Float32Array, dst: Float32Array, r: number, horizontal: boolean): void {
  if (r === 0) {
    dst.set(src);
    return;
  }
  const span = 2 * r + 1;
  for (let line = 0; line < N; line++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      const at = (i: number): number => {
        const k = Math.min(N - 1, Math.max(0, i)); // clamp at the edges, like an extended image
        return src[(horizontal ? line * N + k : k * N + line) * 4 + c];
      };
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < N; i++) {
        dst[(horizontal ? line * N + i : i * N + line) * 4 + c] = sum / span;
        sum += at(i + r + 1) - at(i - r);
      }
    }
  }
}

function base(url: string, rx: number, ry: number): Promise<Uint8ClampedArray | null> {
  const key = `${url}|${rx}|${ry}`;
  const hit = bases.get(key);
  if (hit) return remember(bases, key, hit);
  const job = (async () => {
    // A small rendition is all a blur this wide needs (and usually already loaded for a row or the bar).
    const loaded = await loadArtworkImage(artworkFor(url, 60));
    if (!loaded) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = N;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(loaded.image, 0, 0, N, N);
      const a = Float32Array.from(ctx.getImageData(0, 0, N, N).data);
      const b = new Float32Array(a.length);
      for (let pass = 0; pass < 3; pass++) {
        boxPass(a, b, rx, true);
        boxPass(b, a, ry, false);
      }
      return new Uint8ClampedArray(a);
    } catch {
      return null; // a tainted canvas: no glow rather than a broken one
    } finally {
      loaded.cleanup();
    }
  })();
  job.then((v) => {
    if (!v) bases.delete(key); // a failure isn't remembered: a later look retries
  });
  return remember(bases, key, job);
}

function recipe(url: string, opts: SoftArtOptions) {
  // The blur in texels of the tiny canvas once it's stretched to the size it's shown at.
  const rx = boxRadius(opts.blurPx / (opts.shownW / N));
  const ry = boxRadius(opts.blurPx / (opts.shownH / N));
  const s = opts.saturate ?? 1;
  const br = opts.brightness ?? 1;
  return { rx, ry, s, br, key: `${url}|${rx}|${ry}|${s.toFixed(3)}|${br.toFixed(3)}` };
}

/** Already made: the art at once, so a cover seen before shows on its first frame. */
export function peekSoftArtwork(url: string, opts: SoftArtOptions): string | null {
  return done.get(recipe(url, opts).key) ?? null;
}

/** The cover blurred and graded as `opts` asks, as a small data URL; null when it can't be read. */
export async function softArtwork(url: string, opts: SoftArtOptions): Promise<string | null> {
  const { rx, ry, s, br, key } = recipe(url, opts);
  const hit = done.get(key);
  if (hit) return remember(done, key, hit);
  const px = await base(url, rx, ry);
  if (!px) return null;
  const out = new ImageData(N, N);
  const d = out.data;
  // CSS saturate() (Filter Effects §: feColorMatrix type=saturate), then brightness().
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  for (let i = 0; i < d.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    d[i] = Math.min(255, Math.max(0, m[0] * r + m[1] * g + m[2] * b)) * br;
    d[i + 1] = Math.min(255, Math.max(0, m[3] * r + m[4] * g + m[5] * b)) * br;
    d[i + 2] = Math.min(255, Math.max(0, m[6] * r + m[7] * g + m[8] * b)) * br;
    d[i + 3] = px[i + 3];
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  canvas.getContext("2d")?.putImageData(out, 0, 0);
  return remember(done, key, canvas.toDataURL("image/png"));
}

/** softArtwork as a hook: null until it's ready (or when the cover can't be read). */
export function useSoftArtwork(url: string | null | undefined, opts: SoftArtOptions): string | null {
  const { blurPx, shownW, shownH, saturate, brightness } = opts;
  const [art, setArt] = useState<{ for: string; src: string | null } | null>(null);
  const key = url ? `${url}|${blurPx}|${shownW}|${shownH}|${saturate}|${brightness}` : "";
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void softArtwork(url, { blurPx, shownW, shownH, saturate, brightness }).then((src) => {
      if (alive) setArt({ for: key, src });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Keep the previous recipe's art while a new grade of the same cover is made: no flash to nothing.
  if (!url) return null;
  if (art?.for === key) return art.src;
  const ready = peekSoftArtwork(url, opts);
  if (ready) return ready;
  return art && art.for.startsWith(`${url}|`) ? art.src : null;
}
