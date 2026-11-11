/**
 * Artwork mesh backdrop — a blurred, drifting artwork mesh.
 *
 * The mobile player samples the cover into a coarse grid, resamples it up and
 * blurs it, then anchors it to the top of the screen so the artwork appears to
 * bleed into a soft coloured field. Here the same effect is composed from CSS:
 * a heavily blurred, over-scaled copy of the cover sits behind two slowly
 * drifting radial blobs tinted by the per-page ArtworkPalette (the same wash
 * the page under the artwork inherits), and a dark scrim keeps the controls
 * legible on any sleeve.
 */
import { useArtworkPalette as usePageArtworkPalette } from "../lib/palette";
import { upgradeArtwork } from "../lib/artwork";
import { useSettings } from "../stores/settings";

export function MeshBackdrop({
  artwork,
  className = "",
}: {
  artwork?: string | null;
  className?: string;
}) {
  const palette = usePageArtworkPalette(artwork ?? null);
  // Legacy mesh gradient (mobile v1.5 style): drifting palette blobs with no
  // cover image — the default instead hangs the artwork's own blurred mesh
  // behind the blobs.
  const legacy = useSettings((s) => s.legacyMeshGradient);
  // The page palette uses `background` / `wash` / `accent`. The mesh wants a
  // primary and secondary — the accent and the wash, with the page bg as the
  // floor. Falls back to neutral greys if there's no artwork yet.
  const a = palette.accent;
  const b = palette.wash;
  const c = palette.background;

  return (
    <div
      className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}
      aria-hidden
      style={{ background: `rgb(${c})` }}
    >
      {/* Blurred, over-scaled cover — the artwork's own colour, softened.
          The fade-in lives on a wrapper: the keyframes run opacity 0→1, and
          animating the <img> directly would override its resting opacity-40
          for the duration, then snap dark when the animation ends. */}
      {artwork && !legacy && (
        <div className="absolute inset-0 animate-mesh-in">
          <img
            src={upgradeArtwork(artwork)}
            alt=""
            className="absolute inset-0 w-full h-full object-cover scale-[1.6] blur-[90px] opacity-40"
          />
        </div>
      )}

      {/* Palette blobs drifting like the mobile mesh animation. Legacy mode
          carries the whole backdrop on its own, so the blobs run stronger. */}
      <div
        className="absolute -inset-[20%] animate-drift"
        style={{
          background: legacy
            ? `radial-gradient(46% 46% at 24% 20%, rgb(${a} / 0.55), transparent 68%),
               radial-gradient(42% 42% at 80% 76%, rgb(${b} / 0.65), transparent 66%)`
            : `radial-gradient(42% 42% at 26% 22%, rgb(${a} / 0.32), transparent 68%),
               radial-gradient(38% 38% at 78% 74%, rgb(${b} / 0.42), transparent 66%)`,
        }}
      />
      <div
        className="absolute -inset-[20%] animate-drift2 mix-blend-screen"
        style={{
          background: legacy
            ? `radial-gradient(38% 38% at 68% 28%, rgb(${a} / 0.35), transparent 70%),
               radial-gradient(34% 34% at 28% 82%, rgb(${b} / 0.5), transparent 70%)`
            : `radial-gradient(34% 34% at 68% 30%, rgb(${a} / 0.16), transparent 70%),
               radial-gradient(30% 30% at 30% 80%, rgb(${b} / 0.30), transparent 70%)`,
        }}
      />

      {/* Scrim: dark at the seam, thinning upward — keeps text legible. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/45 to-black/25" />
    </div>
  );
}