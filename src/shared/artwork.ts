/**
 * Thumbnail quality — every cover in the app resolves to its original quality.
 *
 * YouTube Music ships several renditions of the same image and the rows only
 * carry small placeholders (typically `=w60-h60` / `=w120-h120`, `=s60` or a
 * cropped `hqdefault.jpg?sqp=…`). These URL parameters are dynamic resize
 * instructions, so the same photo ID serves up to 1200px — verified against
 * the live hosts (see `.thumbs-results.txt`: every `=w1200…` / `=s1200` URL
 * answers 200 at 1200×1200). Upgrading the parameters therefore restores the
 * original file instead of upscaling a 60px placeholder.
 *
 * Rules:
 * - `lh3 / yt3 / googleusercontent` square art (`=w60-h60…`, `=w60-c-h60…`,
 *   `=s60`, `/w60-h60…/` path form) → 1200px, keeping the crop/format flags.
 * - `i.ytimg.com/vi/<id>/…default.jpg` → the bare file, stepping `default` /
 *   `mqdefault` up to `hqdefault` (480×360, always exists; `maxresdefault`
 *   404s on many uploads and `mqdefault` is only 320×180) while `sddefault` /
 *   `hq720` keep their file. The `?sqp=…&rs=…` query pins a ~400×225 crop,
 *   so it is dropped. `pl_c` / `podcasts_artwork` URLs keep their query —
 *   there the size lives inside the opaque `sqp` token and stripping it
 *   changes the image.
 * - Sparse `150x150` / `50x50` art → `500x500` (the largest such rendition).
 * - Anything unrecognised (local art, plain https covers) passes through.
 */

/** Largest-area entry wins; entries without dimensions never beat a measured one. */
export function largestThumbUrl(thumbnails: unknown): string {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let best: any = thumbnails[thumbnails.length - 1];
  let bestArea = -1;
  for (const t of thumbnails) {
    const w = Number((t as { width?: unknown })?.width) || 0;
    const h = Number((t as { height?: unknown })?.height) || 0;
    const area = w > 0 && h > 0 ? w * h : -1;
    if (area > bestArea) {
      bestArea = area;
      best = t;
    }
  }
  const url = (best as { url?: unknown })?.url;
  return typeof url === "string" ? url : "";
}

export function upgradeThumb(url: string, target = 544): string {
  if (!url || typeof url !== "string") return "";
  let out = url.trim();
  if (!out) return "";

  // Sparse 150px/50px sizes → full 500px art (the largest such rendition).
  out = out.replace(/150x150|50x50/g, "500x500");

  // YouTube video thumbs: /vi/<id>/<file>.jpg[?sqp=…] → the bare file.
  // `default`/`mqdefault` step up to `hqdefault` (480×360, always exists;
  // `maxresdefault` 404s on many uploads and `mqdefault` is only 320×180).
  // `sddefault`/`hq720` keep their file — both out-resolve `hqdefault`.
  // The `?sqp=…&rs=…` query pins a ~400×225 crop in every case, so it goes.
  out = out.replace(
    /^(https?:\/\/i\.ytimg\.com\/vi\/[^/?#]+\/)(default|mqdefault|hqdefault|sddefault|hq720)(?:\.jpg)?(?:\?.*)?$/i,
    (_m, pre: string, name: string) =>
      `${pre}${/^(default|mqdefault)$/i.test(name) ? "hqdefault" : name.toLowerCase()}.jpg`
  );

  // yt3 artist avatars: =s60 / =s192 … → target (dynamic resize host).
  out = out.replace(/=s\d+/g, `=s${target}`);

  // Square catalogue art: =w60-h60… / =w60-c-h60… → target square (flags kept).
  out = out.replace(/=w\d+(-c)?-h\d+/g, `=w${target}$1-h${target}`);

  // Path-style /w60-h60…/ → /w{target}-h{target}…/ (suffix flags kept).
  out = out.replace(/\/w\d+(-c)?-h\d+((?:-[a-z0-9]+)*)\//gi, `/w${target}$1-h${target}$2/`);

  // Legacy default.jpg → hqdefault.jpg (never mqdefault — that is a downgrade).
  out = out.replace(/\/default\.jpg(?:\?.*)?$/i, "/hqdefault.jpg");

  return out;
}

/** Pick the largest offered rendition, resized to `target` square. */
export function bestThumbUrl(thumbnails: unknown, target = 544): string {
  return upgradeThumb(largestThumbUrl(thumbnails), target);
}
