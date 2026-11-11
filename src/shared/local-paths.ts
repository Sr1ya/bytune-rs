/**
 * Pure filesystem-path helpers shared by the main process and the renderer's
 * Local Music view. No `electron` imports here: the renderer bundles this
 * file (it can only import electron/local-library.ts as *types*), so both
 * sides must agree on folder scoping without pulling node's path module in.
 */

/**
 * True when `child` is `root` itself or lives anywhere inside it. Back- and
 * forward-slash roots (e.g. stored by older versions) compare equal, and
 * matching is case-insensitive like the track ids (hashPath lowercases), so
 * a folder can never claim the same file twice under different casing.
 */
export function isUnderPath(child: string, root: string): boolean {
  const c = String(child ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = String(root ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!c || !r) return false;
  if (c === r) return true;
  return c.startsWith(r + "/");
}
