/**
 * A cover's colours, read the way people see them, for the surfaces that wear them (lib/palette:
 * the Home wash, lyrics, Now Playing, the mesh backdrop). Pure: pixels in, colours out.
 *
 * Read in OKLab (perceptual: equal steps look equal, unlike RGB or HSL):
 *  - Pixels without real colour (greys, JPEG noise, near-black) don't vote for a hue, so a black-and-
 *    white cover stays black and white instead of turning red (a grey has hue 0 in HSL).
 *  - The main colour is the hue family covering the most of the cover, a little in favour of the
 *    more colourful one (Material You's scoring: 70% area, the rest chroma), so a big sky beats a
 *    small skin tone or logo.
 *  - The accent is the most vivid colour that covers a real part of it, which needn't be the main one.
 * Colours come out at set perceptual lightness. Dark yellows and oranges look like mud (brown, olive),
 * so a warm family that isn't vivid comes out as a warm grey, and a vivid one keeps its colour.
 */

export type Rgb = [number, number, number];

/** Lightness (0-1), chroma (0 to about 0.32) and hue (degrees) in OKLab's polar form. */
export interface Lch {
  l: number;
  c: number;
  h: number;
}

export interface CoverRead {
  /** How light the cover is overall: 0 black to 1 white (OKLab lightness). */
  lightness: number;
  /** Share of the cover with real colour: 0 for black and white. */
  colored: number;
  /** The hue family covering the most of the cover; null when it has too little colour to count. */
  main: Lch | null;
  /** Its most vivid colour that covers a real part of it. */
  vivid: Lch | null;
  /** What the cover's bottom edge blurs down to. */
  edge: Lch;
}

/* ---------------- sRGB ⇄ OKLab (Björn Ottosson) ---------------- */

const TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const encode = (c: number): number => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
};

/** An OKLCH colour as sRGB, its chroma lowered until it fits (dark colours can't be very colourful). */
export function lchToRgb({ l, c, h }: Lch): Rgb {
  const rad = (h * Math.PI) / 180;
  const at = (chroma: number): [number, number, number] => oklabToLinear(l, chroma * Math.cos(rad), chroma * Math.sin(rad));
  const fits = (x: [number, number, number]): boolean => x.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let rgb = at(c);
  if (!fits(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (fits(at(mid))) lo = mid;
      else hi = mid;
    }
    rgb = at(lo);
  }
  return [encode(rgb[0]), encode(rgb[1]), encode(rgb[2])];
}

/* ---------------- reading a cover ---------------- */

/** A pixel counts as coloured from this OKLab chroma, fully from the next: JPEG noise and the tint
 *  of a black-and-white photo sit below 0.035, a pale sky around 0.05. */
const CHROMA_FROM = 0.03;
const CHROMA_FULL = 0.06;
/** Darker than this, a pixel's colour can't be told apart from noise. */
const DARK = 0.12;
/** Less colour than this share of the cover, and it reads as black and white. */
const COLORED_MIN = 0.06;
const BINS = 36; // 10° each

/** Material You's scoring (proportion first, then chroma), on OKLab chroma scaled to CAM16's range. */
function score(share: number, chroma: number): number {
  const cam = chroma * 370;
  return 70 * share + (cam - 48) * (cam < 48 ? 0.1 : 0.3);
}

/**
 * Reads a cover from RGBA pixels (a small canvas is plenty: 64×64). Transparent pixels are skipped;
 * null when nothing is left to read.
 */
export function readCover(rgba: ArrayLike<number>, width: number, height: number): CoverRead | null {
  const area = new Float64Array(BINS);
  const sumA = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  const sumL = new Float64Array(BINS);
  const sumC = new Float64Array(BINS);
  let counted = 0;
  let colored = 0;
  let allL = 0;
  const edgeFrom = Math.floor(height * 0.82);
  let edgeL = 0;
  let edgeA = 0;
  let edgeB = 0;
  let edgeN = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] < 128) continue;
      const [L, A, B] = linearToOklab(TO_LINEAR[rgba[i] | 0], TO_LINEAR[rgba[i + 1] | 0], TO_LINEAR[rgba[i + 2] | 0]);
      counted++;
      allL += L;
      if (y >= edgeFrom) {
        edgeL += L;
        edgeA += A;
        edgeB += B;
        edgeN++;
      }
      const C = Math.hypot(A, B);
      if (L < DARK || C <= CHROMA_FROM) continue;
      const t = Math.min(1, (C - CHROMA_FROM) / (CHROMA_FULL - CHROMA_FROM));
      const w = t * t * (3 - 2 * t); // a soft edge: a faint tint counts a little, not all or nothing
      colored += w;
      const bin = Math.floor(((((Math.atan2(B, A) * 180) / Math.PI + 360) % 360) / 360) * BINS) % BINS;
      area[bin] += w;
      sumA[bin] += A * w;
      sumB[bin] += B * w;
      sumL[bin] += L * w;
      sumC[bin] += C * w;
    }
  }
  if (!counted) return null;
  const edge = edgeN ? toLch(edgeL / edgeN, edgeA / edgeN, edgeB / edgeN) : { l: 0.2, c: 0, h: 0 };
  const share = colored / counted;
  const lightness = allL / counted;
  if (share < COLORED_MIN) return { lightness, colored: share, main: null, vivid: null, edge };

  // A hue family: a bin and its neighbours (30°).
  const family = (b: number): { n: number; a: number; bb: number; l: number; c: number } => {
    let n = 0, a = 0, bb = 0, l = 0, c = 0;
    for (let d = -1; d <= 1; d++) {
      const k = (b + d + BINS) % BINS;
      n += area[k];
      a += sumA[k];
      bb += sumB[k];
      l += sumL[k];
      c += sumC[k];
    }
    return { n, a, bb, l, c };
  };
  const asLch = (f: ReturnType<typeof family>): Lch => ({
    l: f.l / f.n,
    c: f.c / f.n,
    h: ((Math.atan2(f.bb, f.a) * 180) / Math.PI + 360) % 360,
  });

  let main = -1;
  let mainScore = -Infinity;
  let vivid = -1;
  let vividScore = -Infinity;
  for (let b = 0; b < BINS; b++) {
    if (!area[b]) continue;
    const f = family(b);
    const s = f.n / counted;
    if (s < 0.01) continue;
    const c = f.c / f.n;
    const ms = score(s, c);
    if (ms > mainScore) {
      mainScore = ms;
      main = b;
    }
    // Vivid: colour first, area enough to be noticed.
    const vs = s >= 0.015 ? c * c * Math.sqrt(s) : -Infinity;
    if (vs > vividScore) {
      vividScore = vs;
      vivid = b;
    }
  }
  if (main < 0) return { lightness, colored: share, main: null, vivid: null, edge };
  return { lightness, colored: share, main: asLch(family(main)), vivid: vivid >= 0 ? asLch(family(vivid)) : asLch(family(main)), edge };
}

/**
 * How bright the Home glow of a cover is (a CSS brightness()): a light cover is dimmed more, so
 * white text on the glow stays readable; a dark or mid one keeps its glow.
 */
export function glowBrightness(read: CoverRead | null): number {
  if (!read) return 0.62;
  return Math.max(0.45, Math.min(0.62, 0.62 - (read.lightness - 0.6) * 0.45));
}

function toLch(L: number, A: number, B: number): Lch {
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/* ---------------- colours for a dark page ---------------- */

/** Oranges, skin tones, browns and yellows: dark and only half-coloured, they read as mud. */
const muddy = (h: number): boolean => h >= 35 && h <= 115;

/** How much colour a dark surface keeps: a warm family that isn't vivid goes to a warm grey. */
function darkChroma(c: number, h: number, cap: number): number {
  if (muddy(h) && c < 0.1) return Math.min(c * 0.2, 0.012);
  return Math.min(c, cap);
}

export interface CoverPalette {
  /** The page under a cover (lyrics, Now Playing): dark enough for white text on it. */
  background: Rgb;
  /** What the cover's bottom edge fades into. */
  wash: Rgb;
  /** The Home wash and chips: the cover's main colour, a step up from the background. */
  elevated: Rgb;
  /** Titles, the play button, glows: light enough to read on the background. */
  accent: Rgb;
}

const grey = (l: number): Rgb => lchToRgb({ l, c: 0, h: 0 });

/** The colours of a dark page for a cover read by readCover (null: a cover that couldn't be read). */
export function coverPalette(read: CoverRead | null): CoverPalette {
  const edge = read?.edge;
  const wash: Rgb = edge
    ? lchToRgb({ l: Math.min(0.34, Math.max(0.22, 0.2 + edge.l * 0.15)), c: darkChroma(edge.c * 0.9, edge.h, 0.09), h: edge.h })
    : grey(0.22);
  if (!read?.main) {
    return { background: grey(0.22), wash, elevated: grey(0.33), accent: [255, 255, 255] };
  }
  // A cover with only a little colour lends only a little of it.
  const amount = 0.55 + 0.45 * Math.min(1, Math.max(0, (read.colored - COLORED_MIN) / 0.3));
  const main = read.main;
  const c = darkChroma(main.c * amount, main.h, 0.13);
  const vivid = read.vivid ?? main;
  return {
    background: lchToRgb({ l: 0.235, c: Math.min(c * 0.6, 0.07), h: main.h }),
    wash,
    elevated: lchToRgb({ l: 0.36, c, h: main.h }),
    accent: lchToRgb({ l: 0.8, c: Math.min(0.15, Math.max(0.08, vivid.c)), h: vivid.h }),
  };
}
