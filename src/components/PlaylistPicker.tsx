import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useLibrary } from "../stores/library";
import { useUI } from "../stores/ui";
import { Btn } from "./primitives";
import { FitText } from "./FitText";
import { shortTitle } from "../lib/format";
import { addSongsToPlaylists } from "../lib/devicePlaylists";

/**
 * "Add to playlists": tick any number of your playlists and add the song(s)
 * to all of them at once. Playlists that already hold every song show ticked
 * and can't be unticked here.
 */
export function PlaylistPicker() {
  const tracks = useUI((s) => s.playlistPicker);
  const close = useUI((s) => s.closePlaylistPicker);
  const playlists = useLibrary((s) => s.playlists);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPicked(new Set());
    if (!tracks) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // After the menu that opened it hands focus back: land on the first choice.
    const t = window.setTimeout(() => {
      document.querySelector<HTMLElement>('[aria-label="Add to playlists"] [role="checkbox"]:not(:disabled), [aria-label="Add to playlists"]')?.focus();
    }, 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(t);
    };
  }, [tracks, close]);

  if (!tracks) return null;
  const holdsAll = (id: string): boolean => {
    const ids = new Set(playlists.find((p) => p.id === id)?.tracks.map((t) => t.id));
    return tracks.every((t) => ids.has(t.id));
  };
  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const add = (): void => {
    const { told } = addSongsToPlaylists([...picked], tracks);
    if (!told) useUI.getState().toast(`Added to ${picked.size} ${picked.size === 1 ? "playlist" : "playlists"}`, "success");
    close();
  };
  const what = tracks.length === 1 ? `"${shortTitle(tracks[0].title)}"` : `${tracks.length} songs`;

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add to playlists"
        tabIndex={-1}
        className="relative w-[min(420px,calc(100vw-48px))] rounded-2xl glass-strong p-6 animate-pop-in"
      >
        <h2 className="font-display text-lg font-bold tracking-tight text-ink-hi">Add to playlists</h2>
        <p className="text-[13px] text-ink-dim mt-1.5 [overflow-wrap:anywhere]">Choose where {what} should go.</p>
        <div className="mt-4 max-h-[50vh] overflow-y-auto -mx-2 space-y-0.5">
          {playlists.length === 0 && <p className="px-2 py-4 text-[13px] text-ink-dim">You don't have any playlists yet.</p>}
          {playlists.map((p) => {
            const already = holdsAll(p.id);
            const on = already || picked.has(p.id);
            return (
              <button
                key={p.id}
                role="checkbox"
                aria-checked={on}
                disabled={already}
                onClick={() => toggle(p.id)}
                className="fit-host w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left enabled:hover:bg-ink-hi/[0.06] transition-colors"
              >
                <span
                  className={`w-5 h-5 shrink-0 grid place-items-center rounded-md border ${
                    on ? "bg-accent border-accent text-on-primary" : "border-ink-hi/30"
                  } ${already ? "opacity-60" : ""}`}
                >
                  {on && <Check className="w-3.5 h-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <FitText text={p.name} className="text-[14px] text-ink-hi" />
                  <span className="block text-[12px] text-ink-dim">
                    {already ? "Already added" : `${p.tracks.length} ${p.tracks.length === 1 ? "song" : "songs"}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-2 mt-6">
          <Btn variant="ghost" size="md" className="!rounded-xl" onClick={close}>
            Cancel
          </Btn>
          <Btn variant="accent" size="md" className="!rounded-xl" disabled={picked.size === 0} onClick={add}>
            Add
          </Btn>
        </div>
      </div>
    </div>
  );
}
