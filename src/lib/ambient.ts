/**
 * Ambient artwork engine.
 *
 * Extracts the two dominant colors of the current track's artwork and exposes
 * them to CSS as `--ambient-0` / `--ambient-1` (R G B triplets). The app
 * background, player bar and full-screen player pick these up to create a
 * subtle, artwork-driven atmosphere.
 *
 * Extraction happens on a small offscreen canvas. If the image can't be read
 * (CORS / load failure) we fall back to a neutral grey so the UI never breaks
 * or flickers, and never paints a coloured glow the artwork didn't supply.
 */

export interface Palette {
  /** "R G B" triplet strings consumed by CSS */
  primary: string;
  secondary: string;
}

const cache = new Map<string, Palette>();

/* Neutral fallback: no hue of its own, so an unread sleeve stays black.
   Fixed constants rather than reading --ambient-* back off the document —
   those still hold the previous track's colours once a sleeve has been read. */
function fallbackPalette(): Palette {
  return { primary: "60 60 64", secondary: "40 40 44" };
}

function applyPalette(p: Palette): void {
  const root = document.documentElement.style;
  root.setProperty("--ambient-0", p.primary);
  root.setProperty("--ambient-1", p.secondary);
}

export function resetAmbient(): void {
  applyPalette(fallbackPalette());
}

/**
 * Samples the artwork and applies its palette. Returns the palette that was
 * applied (or null when nothing changed because the artwork failed to load).
 */
export async function setAmbientFromArtwork(url: string | undefined | null): Promise<Palette | null> {
  if (typeof document === "undefined") return null;
  if (!url) {
    resetAmbient();
    return null;
  }
  const cached = cache.get(url);
  if (cached) {
    applyPalette(cached);
    return cached;
  }

  const palette = await extractPalette(url);
  if (palette) {
    cache.set(url, palette);
    applyPalette(palette);
    return palette;
  }
  resetAmbient();
  return null;
}

/**
 * Loads artwork for pixel reading, CORS-clean on every source.
 *
 * Online covers load with crossOrigin="anonymous" (their hosts send ACAO).
 * Local covers (localart://) can never load CORS-clean — Chromium blocks
 * CORS-mode requests to custom schemes at the scheme level — and YouTube's
 * thumbnail host (i.ytimg.com: playlist covers, video thumbnails) sends no
 * ACAO, so their bytes come over IPC and are decoded from a same-origin blob
 * URL instead. Either way the canvas stays untainted and getImageData works.
 */
const NO_CORS_HOST = /^https:\/\/i\d?\.ytimg\.com\//i;

export async function loadArtworkImage(
  url: string
): Promise<{ image: HTMLImageElement; cleanup: () => void } | null> {
  let src = url;
  let revoke: string | null = null;
  const local = url.startsWith("localart://");
  if (local || NO_CORS_HOST.test(url)) {
    try {
      const bytes = (await (local ? window.bytune?.localArtBytes(url) : window.bytune?.remoteArtBytes(url))) as unknown;
      const u8 =
        bytes instanceof Uint8Array
          ? bytes
          : bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : null;
      if (!u8 || u8.length === 0) return null;
      // Copy into a fresh exact-size buffer: structured-cloned views may sit
      // on a shared pool, which BlobPart typings (and some decoders) reject.
      const copy = new Uint8Array(u8);
      revoke = URL.createObjectURL(
        new Blob([copy], { type: url.endsWith(".png") ? "image/png" : "image/jpeg" })
      );
      src = revoke;
    } catch {
      return null;
    }
  }
  const cleanup = (): void => {
    if (revoke) {
      URL.revokeObjectURL(revoke);
      revoke = null;
    }
  };
  try {
    const image = new Image();
    // Blob URLs are same-origin — no CORS needed; remote art keeps it.
    if (!revoke) image.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("artwork load failed"));
      image.src = src;
    });
    if (!image.naturalWidth || !image.naturalHeight) {
      cleanup();
      return null;
    }
    return { image, cleanup };
  } catch {
    cleanup();
    return null;
  }
}

/** Low-level extraction used by ambient + per-page palette hooks. */
export async function extractPalette(url: string): Promise<Palette | null> {
  const loaded = await loadArtworkImage(url);
  if (!loaded) return null;
  const { image, cleanup } = loaded;
  try {
    if (!image.naturalWidth || !image.naturalHeight) return null;

    const N = 30;
    const canvas = document.createElement("canvas");
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, N, N);
    // throws when the canvas is tainted (no CORS headers) — caught below
    const { data } = ctx.getImageData(0, 0, N, N);

    // Score hue buckets by saturation × exposure so we land on vivid,
    // representative colors rather than washed-out or near-black ones.
    const BINS = 18;
    const score = new Float32Array(BINS);
    const rSum = new Float32Array(BINS);
    const gSum = new Float32Array(BINS);
    const bSum = new Float32Array(BINS);
    const wSum = new Float32Array(BINS);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = max === 0 ? 0 : (max - min) / max;
      if (lum < 0.08 || lum > 0.95) continue;

      let h = 0;
      if (max !== min) {
        const d = max - min;
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      const bin = Math.min(BINS - 1, Math.floor(h * BINS));
      // weight: favor saturated mid-luminance pixels; keep muted ones in play
      const w = Math.pow(sat, 1.25) * (0.35 + 0.65 * (1 - Math.abs(lum - 0.45) * 1.6)) + 0.02;
      score[bin] += w;
      rSum[bin] += r * w;
      gSum[bin] += g * w;
      bSum[bin] += b * w;
      wSum[bin] += w;
    }

    let first = -1;
    for (let i = 0; i < BINS; i++) if (first < 0 || score[i] > score[first]) first = i;
    if (first < 0 || wSum[first] === 0) return null;

    // secondary: strongest bucket far enough from the first (≥3 hue steps)
    let second = -1;
    for (let i = 0; i < BINS; i++) {
      if (wSum[i] === 0 || i === first) continue;
      const dist = Math.min(Math.abs(i - first), BINS - Math.abs(i - first));
      if (dist < 3) continue;
      if (second < 0 || score[i] > score[second]) second = i;
    }

    const avg = (i: number): string => {
      const w = wSum[i] || 1;
      const to = (v: number): number => {
        // lift very dark averages so gradients stay visible on dark surfaces
        const c = Math.round((v / w) * 255);
        return Math.min(255, Math.max(28, c));
      };
      return `${to(rSum[i])} ${to(gSum[i])} ${to(bSum[i])}`;
    };

    return {
      primary: avg(first),
      secondary: second >= 0 ? avg(second) : shift(first),
    };
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

/** Desaturated companion derived from the primary hue bucket. */
function shift(bin: number): string {
  const BINS = 18;
  const h = ((bin + 4) % BINS) / BINS;
  const [r, g, b] = hslToRgb(h, 0.42, 0.34);
  return `${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}
