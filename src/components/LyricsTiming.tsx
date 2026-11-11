import { Minus, Plus } from "lucide-react";
import { LYRICS_NUDGE_STEP, describeLyricsShift, useLyricsNudge } from "../lib/lyricsOffset";

/**
 * This song's lyrics timing: earlier / later in quarter seconds ([ and ] do
 * the same while lyrics are open). Quiet until the lyrics pane is hovered or
 * the song has a nudge; clicking the reading resets it.
 */
export function LyricsTiming({ trackId, className = "" }: { trackId: string; className?: string }) {
  const nudge = useLyricsNudge((s) => s.nudges[trackId] ?? 0);
  const store = useLyricsNudge.getState;
  const step = "grid h-7 w-7 place-items-center rounded-full hover:bg-white/10 transition-colors";
  return (
    <div
      role="group"
      aria-label="Lyrics timing for this song"
      className={`flex h-9 items-center gap-0.5 rounded-full bg-black/40 px-1 text-[12px] text-ink-hi/80 transition-opacity ${
        nudge ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
      } ${className}`}
    >
      <button onClick={() => store().nudge(trackId, -LYRICS_NUDGE_STEP)} title="Show lyrics earlier ( [ )" aria-label="Show lyrics earlier" className={step}>
        <Minus className="h-4 w-4" />
      </button>
      <button
        onClick={() => store().resetNudge(trackId)}
        disabled={!nudge}
        title={nudge ? "Reset this song's lyrics timing" : "Lyrics timing for this song"}
        className="min-w-[88px] px-1 text-center tabular-nums enabled:hover:text-ink-hi"
      >
        {nudge ? describeLyricsShift(nudge) : "Lyrics timing"}
      </button>
      <button onClick={() => store().nudge(trackId, LYRICS_NUDGE_STEP)} title="Show lyrics later ( ] )" aria-label="Show lyrics later" className={step}>
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
