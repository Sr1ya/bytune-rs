/**
 * ArtworkPalette: the colours a surface wears for a cover (the Home wash, lyrics, Now Playing, the
 * mesh backdrop): a deep `background` that white text reads on, a `wash` matching what the cover's
 * bottom edge blurs down to, an `elevated` tone (the cover's main colour, a step up), and an `accent`
 * light enough to read on the background. How a cover is read: lib/coverColor (perceptual; a black-
 * and-white cover stays grey, and the colour covering most of a cover wins).
 */
import { useEffect, useState } from "react";
import { loadArtworkImage } from "./ambient";
import { coverPalette, readCover, type CoverRead, type Rgb } from "./coverColor";

export interface ArtworkPalette {
  /** CSS `R G B` triplet strings — consumed as `rgb(var(--page-bg) / <a>)`. */
  background: string;
  wash: string;
  elevated: string;
  /** Already contrast-corrected for use on `background` / `wash`. */
  accent: string;
  onBackground: string;
  onBackgroundVariant: string;
  divider: string;
}

/* LRU cache: a hit moves to the newest end, the oldest goes first. */
const READ_CACHE_ENTRIES = 128;
const readCache = new Map<string, CoverRead>();

/** Read size: colours are statistics, and 64² holds them. */
const PALETTE_PX = 64;

/** Reads the artwork at `url` (null when it can't be loaded or drawn). */
async function readArtwork(url: string): Promise<CoverRead | null> {
  const loaded = await loadArtworkImage(url);
  if (!loaded) return null;
  const { image: img, cleanup } = loaded;
  try {
    if (!img.naturalWidth || !img.naturalHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = PALETTE_PX;
    canvas.height = PALETTE_PX;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, PALETTE_PX, PALETTE_PX);
    return readCover(ctx.getImageData(0, 0, PALETTE_PX, PALETTE_PX).data, PALETTE_PX, PALETTE_PX);
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

/** Keeps a reading as the newest; the oldest goes once the cache is full. */
function remember(url: string, read: CoverRead): void {
  readCache.delete(url);
  if (readCache.size >= READ_CACHE_ENTRIES) {
    const oldest = readCache.keys().next().value;
    if (oldest) readCache.delete(oldest);
  }
  readCache.set(url, read);
}

/** A cover's reading (lib/coverColor): null until it lands, or when the cover can't be read. */
export function useCoverRead(url: string | null | undefined): CoverRead | null {
  const [read, setRead] = useState<CoverRead | null>(() => (url ? (readCache.get(url) ?? null) : null));
  useEffect(() => {
    if (!url) {
      setRead(null);
      return;
    }
    const known = readCache.get(url);
    if (known) {
      remember(url, known);
      setRead(known);
      return;
    }
    let cancelled = false;
    void readArtwork(url).then((fresh) => {
      if (cancelled) return;
      if (fresh) remember(url, fresh);
      setRead(fresh);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return read;
}

/** A cover's read outside a component, from the same cache as the hook; null when it can't be read. */
export async function coverRead(url: string): Promise<CoverRead | null> {
  const known = readCache.get(url);
  if (known) return known;
  const fresh = await readArtwork(url);
  if (fresh) remember(url, fresh);
  return fresh;
}

const triplet = (rgb: Rgb): string => `${rgb[0]} ${rgb[1]} ${rgb[2]}`;

function toPalette(read: CoverRead): ArtworkPalette {
  const p = coverPalette(read);
  return {
    background: triplet(p.background),
    wash: triplet(p.wash),
    elevated: triplet(p.elevated),
    accent: triplet(p.accent),
    onBackground: "255 255 255",
    onBackgroundVariant: "204 204 204", // White @ 0.80
    divider: "31 31 31", // White @ 0.12
  };
}

/** No cover (or one that can't be read): near-black, so the surface looks plain rather than tinted. */
const NEUTRAL_DARK: ArtworkPalette = {
  background: "13 13 15",
  wash: "13 13 15",
  elevated: "28 28 30",
  accent: "255 255 255",
  onBackground: "255 255 255",
  onBackgroundVariant: "142 142 147",
  divider: "31 31 31",
};

/**
 * A page's colours as the CSS variables its `.page-tint` host reads (index.css: the header's fade,
 * the text), set on that host so they belong to that page alone.
 */
export function pageColors(p: ArtworkPalette): React.CSSProperties {
  return {
    "--page-bg": p.background,
    "--page-wash": p.wash,
    "--page-elevated": p.elevated,
    "--page-accent": p.accent,
    "--page-on": p.onBackground,
    "--page-on-variant": p.onBackgroundVariant,
    "--page-divider": p.divider,
  } as React.CSSProperties;
}

/**
 * React hook: returns an `ArtworkPalette` derived from the URL.
 *
 * - On first frame, returns the cached reading immediately if any.
 * - On miss, kicks off an async read; the palette re-renders when it lands
 *   (until then the last palette stays, so a surface doesn't flash dark).
 */
export function useArtworkPalette(url: string | null | undefined): ArtworkPalette {
  const [palette, setPalette] = useState<ArtworkPalette>(() => {
    const known = url ? readCache.get(url) : undefined;
    return known ? toPalette(known) : NEUTRAL_DARK;
  });

  useEffect(() => {
    if (!url) {
      setPalette(NEUTRAL_DARK);
      return;
    }
    const known = readCache.get(url);
    if (known) {
      remember(url, known);
      setPalette(toPalette(known));
      return;
    }
    let cancelled = false;
    void readArtwork(url).then((read) => {
      if (cancelled) return;
      // A cover that can't be read wears no colour, rather than the last cover's.
      if (!read) {
        setPalette(NEUTRAL_DARK);
        return;
      }
      remember(url, read);
      setPalette(toPalette(read));
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return palette;
}
