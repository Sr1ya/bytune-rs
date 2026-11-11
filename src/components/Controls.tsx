import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Volume1, Volume2 } from "lucide-react";
import { fmtTime } from "../lib/format";
import { usePlayer } from "../stores/player";

/**
 * Releasing the pointer must not leave focus parked on a range input: the
 * global shortcut handler treats a focused INPUT as typing, so Space
 * (play/pause) went dead until the user clicked somewhere else. Blur on
 * release instead — keyboard users are untouched, since Tab focus and
 * arrow-key adjustments never fire pointer events.
 */
function releasePointerFocus(e: React.PointerEvent<HTMLInputElement>): void {
  e.currentTarget.blur();
}

interface SeekBarProps {
  large?: boolean;
  showRemaining?: boolean;
  /** slimmer hairline track — the player-bar variant */
  thin?: boolean;
}

export function SeekBar({ large = false, showRemaining = false, thin = false }: SeekBarProps) {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const buffered = usePlayer((s) => s.buffered);
  const seek = usePlayer((s) => s.seek);
  // While the thumb is held down the drag is purely visual — the audio keeps
  // playing untouched. Range inputs fire onChange continuously mid-drag, so
  // seeking there would make playback jump around under the cursor. The real
  // seek happens once, on release (pointer up / keyboard key up).
  const [dragValue, setDragValue] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  dragRef.current = dragValue;
  const inputRef = useRef<HTMLInputElement>(null);
  // A length not known yet (a song restored at launch that hasn't loaded) shows
  // where it will resume, over an empty bar.
  const known = duration > 0;
  const max = known ? duration : 1;
  const shown = dragValue ?? (known ? Math.min(position, max) : position);
  const pct = known ? Math.min(100, (shown / max) * 100) : 0;
  const bufPct = Math.min(100, Math.max(buffered * 100, pct));

  const commit = () => {
    const v = dragRef.current;
    if (v !== null) seek(Math.min(v, max));
    dragRef.current = null;
    setDragValue(null);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  // The native `change` fires once the range is let go — a click on the track or the end of a drag.
  // WebKitGTK's slider can keep the pointerup to itself, so pointerup alone left a clicked seek
  // waiting until focus moved elsewhere.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onChange = () => commitRef.current();
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);

  return (
    <div className={`flex items-center ${large ? "gap-3 w-full" : "gap-2 w-full"}`}>
      <span
        className={`shrink-0 text-right tabular-nums ${large ? "text-ink-faint w-12 text-[13px]" : "w-[50px] text-[12px] leading-[17px] text-[#b3b3b3]"}`}
      >
        {fmtTime(shown)}
      </span>
      <input
        ref={inputRef}
        type="range"
        aria-label="Seek"
        min={0}
        max={max}
        step={0.5}
        value={known ? shown : 0}
        onChange={(e) => {
          const v = Number(e.target.value);
          dragRef.current = v; // the native change below may run before React re-renders
          setDragValue(v);
        }}
        onPointerUp={(e) => {
          commit();
          releasePointerFocus(e);
        }}
        onKeyUp={commit}
        onBlur={() => {
          if (dragRef.current !== null) commit();
        }}
        className={`slider flex-1 ${thin ? "slider-thin" : ""} ${large ? "h-1.5" : ""}`}
        style={{ "--fill": `${pct}%`, "--buffered": `${bufPct}%` } as CSSProperties}
      />
      <span className={`shrink-0 tabular-nums ${large ? "text-ink-faint w-12 text-[13px]" : "w-[50px] text-[12px] leading-[17px] text-[#b3b3b3]"}`}>
        {showRemaining ? `-${fmtTime(Math.max(0, duration - shown))}` : fmtTime(duration)}
      </span>
    </div>
  );
}

export function VolumeControl({ VolIcon }: { VolIcon: (p: { className?: string }) => React.ReactElement }) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const pct = (muted ? 0 : volume) * 100;

  return (
    <div className="flex items-center">
      <button
        onClick={toggleMute}
        className="grid h-8 w-8 place-items-center text-[#b3b3b3] transition-colors hover:text-white"
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
      >
        <span key={muted ? "muted" : "on"} className="icon-swap">
          <VolIcon className="w-4 h-4" />
        </span>
      </button>
      <input
        type="range"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        onPointerUp={releasePointerFocus}
        className="slider slider-bar w-[93px]"
        style={{ "--fill": `${pct}%` } as CSSProperties}
      />
    </div>
  );
}

/**
 * Full-width volume row — the mobile player's volume treatment:
 * quiet speaker at the left end, loud speaker at the right, one long slider
 * between them. Used on the full-screen NowPlaying overlay.
 */
export function VolumeRow() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const pct = (muted ? 0 : volume) * 100;

  return (
    <div className="w-full flex items-center gap-3">
      <button
        onClick={toggleMute}
        className="text-ink-hi/60 hover:text-ink-hi transition-all active:scale-90 shrink-0"
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
      >
        <Volume1 className="w-5 h-5" />
      </button>
      <input
        type="range"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        onPointerUp={releasePointerFocus}
        className="slider flex-1"
        style={{ "--fill": `${pct}%` } as CSSProperties}
      />
      <button
        onClick={toggleMute}
        className="text-ink-hi/60 hover:text-ink-hi transition-all active:scale-90 shrink-0"
        title="Volume up"
        aria-label="Volume up"
      >
        <Volume2 className="w-5 h-5" />
      </button>
    </div>
  );
}
