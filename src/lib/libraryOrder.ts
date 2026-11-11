/**
 * The order of Your Library's movable rows (everything below the pinned ones). A drag saves the
 * whole order; a row the saved order doesn't know yet (a new playlist, a row just unpinned) goes
 * where it would by default: right after the row that comes before it by default.
 */
export function arrange(defaults: readonly string[], saved: readonly string[]): string[] {
  const present = new Set(defaults);
  const placed = new Set<string>();
  const out: string[] = [];
  for (const key of saved) {
    if (present.has(key) && !placed.has(key)) {
      out.push(key);
      placed.add(key);
    }
  }
  let before: string | null = null;
  for (const key of defaults) {
    if (!placed.has(key)) {
      out.splice(before === null ? 0 : out.indexOf(before) + 1, 0, key);
      placed.add(key);
    }
    before = key;
  }
  return out;
}

/** `keys` with the one at `from` moved to `to`. */
export function moveKey(keys: readonly string[], from: number, to: number): string[] {
  const out = [...keys];
  const [key] = out.splice(from, 1);
  if (key !== undefined) out.splice(to, 0, key);
  return out;
}
