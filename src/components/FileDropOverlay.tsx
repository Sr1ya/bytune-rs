/**
 * "Drop to play" while audio files from Explorer/Finder are dragged over the
 * window. Only a hint: the dropped files reach the backend (natively on Linux,
 * through shared/api.ts elsewhere), which plays them (src/lib/openedFiles.ts). Drags that start inside ByTune
 * (a cover, a song row) are its own and never raise it.
 */
import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";

export function FileDropOverlay() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    let inside = false;
    const fromOutside = (e: DragEvent): boolean => !inside && !!e.dataTransfer?.types.includes("Files");
    const start = (): void => void (inside = true);
    const enter = (e: DragEvent): void => {
      if (!fromOutside(e)) return;
      depth += 1;
      setOver(true);
    };
    const leave = (e: DragEvent): void => {
      if (!fromOutside(e)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setOver(false);
      }
    };
    const end = (): void => {
      depth = 0;
      inside = false;
      setOver(false);
    };
    // Linux: the backend takes the drop itself (the page sees the drag arrive but never the drop),
    // and says when it's over or gone.
    const offNative = window.bytune?.onFilesDrag?.((over) => {
      if (over) setOver(true);
      else end();
    });
    window.addEventListener("dragstart", start);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", end);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", end);
      window.removeEventListener("dragend", end);
      offNative?.();
    };
  }, []);

  if (!over) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[90] grid place-items-center bg-black/60">
      <div className="rounded-2xl border-2 border-dashed border-white/40 px-12 py-9 text-center">
        <Music2 className="mx-auto h-8 w-8 text-white/80" />
        <p className="mt-3 text-[18px] font-bold text-white">Drop to play</p>
        <p className="mt-1 text-[13px] text-white/60">MP3, M4A, AAC, FLAC, WAV, Ogg and Opus files</p>
      </div>
    </div>
  );
}
