// The original ByTune CoverGlow (rishiteja21/ByTune src/components/CoverGlow.tsx.tsx), kept as is: the version used
// wherever full animations are on (lib/fullMotion). ../CoverGlow.tsx holds the lighter one WebKitGTK needs.
/**
 * The middle panel's glow: the cover of the song playing (or of the card under the mouse) blurred into
 * light across the top of the panel, fading down into it. The real image keeps a cover's own colours,
 * a black-and-white one stays black and white and bright parts stay bright, where one colour picked
 * from it went muddy on warm covers. A new cover glows in over the last; with none, the glow fades
 * away. With nothing playing yet, Home glows with the cover it leads with, so a first visit is lit
 * too. Not on the artist page (its hero is its own artwork) or Settings.
 */
import { useEffect, useState } from "react";
import { glowBrightness } from "../../lib/coverColor";
import { useCoverRead } from "../../lib/palette";
import { usePlayer } from "../../stores/player";
import { useHomeLead } from "../../lib/recs/feed";
import { useUI } from "../../stores/ui";

/** How long a cover takes to glow in over the last one (and to fade away). */
export const GLOW_FADE_MS = 600;

interface Layer {
  id: number;
  url: string;
}

function GlowLayer({ url, out }: { url: string; out: boolean }) {
  // A light cover glows dimmer, so white text on it stays readable.
  const brightness = glowBrightness(useCoverRead(url));
  return (
    <div
      className={`cover-glow-art${out ? " cover-glow-out" : ""}`}
      style={{ backgroundImage: `url(${JSON.stringify(url)})`, filter: `blur(90px) saturate(1.6) brightness(${brightness})` }}
    />
  );
}

export function CoverGlow() {
  const viewName = useUI((s) => s.view.name);
  const tintThumb = useUI((s) => s.tintThumb);
  const playingThumb = usePlayer((s) => s.queue[s.index]?.thumb ?? null);
  const leadThumb = useHomeLead((s) => s.playlist?.thumb ?? null);
  const url = tintThumb ?? playingThumb ?? (viewName === "home" ? leadThumb : null);
  const [layers, setLayers] = useState<Layer[]>(() => (url ? [{ id: 0, url }] : []));

  // A new cover goes on top of the one showing (anything older goes).
  useEffect(() => {
    if (!url) return;
    setLayers((list) => {
      const top = list[list.length - 1];
      if (top?.url === url) return list;
      return top ? [top, { id: top.id + 1, url }] : [{ id: 0, url }];
    });
  }, [url]);

  // Once the newest has glowed in, what's under it goes; with no cover, all of it once faded.
  useEffect(() => {
    const settled = url ? layers.length <= 1 : layers.length === 0;
    if (settled) return;
    const timer = window.setTimeout(() => setLayers((list) => (url ? list.slice(-1) : [])), GLOW_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [layers, url]);

  if (viewName === "artist" || viewName === "settings") return null;
  return (
    <div aria-hidden className="cover-glow pointer-events-none absolute inset-x-0 top-0 h-[360px]">
      {layers.map((layer) => (
        <GlowLayer key={layer.id} url={layer.url} out={!url} />
      ))}
      <div className="cover-glow-grain" />
    </div>
  );
}
