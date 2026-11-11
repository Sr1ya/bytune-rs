/**
 * Deterministic randomness for the Home feed.
 *
 * "Dynamic ≠ random": every shuffle and tie-break in the recommendation
 * engine draws from a seeded PRNG keyed on stable inputs (ids, the day
 * bucket), so the same data produces the same Home within a day — and
 * picks genuinely rotate when the day rolls over, not on every render.
 */

/** FNV-1a 32-bit — stable string hash for seeds and tie-breaks. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** UTC day number — the Home's freshness bucket (stable within a day). */
export function dayBucket(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000);
}

/** Mulberry32 — small, fast, well-distributed seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded PRNG — same seed, same order, always. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Normalised 0..1 hash of a string + seed — tie-breaks and daily rotation. */
export function seededUnit(key: string, seed: number): number {
  return mulberry32(hash32(key) ^ seed)();
}
