/**
 * CreateMenu — the library "+" (and Your Library's Create pill) and its menu: Playlist and Folder
 * (deliberately no Blend), and the two imports. Picking one asks for a name first (the shared dialog,
 * pre-filled with the numbered default): nothing is created until the name is confirmed, so cancel
 * means no empty entry. The menu is the shared one (ContextMenu), so it looks, moves and takes the
 * keyboard like every other menu; it hangs under the button, out over the page.
 */
import { useId, useRef } from "react";
import { ClipboardList, FileUp, Folder, ListPlus, Plus } from "lucide-react";
import { importPlaylistFile } from "../lib/playlistShare";
import { importFromText } from "../lib/importSongs";
import { askForNewFolder } from "../lib/collection";
import { useLibrary } from "../stores/library";
import { useUI, type MenuItem } from "../stores/ui";
import { HERO_PLAY } from "./CollectionHero";

/** `pill`: Your Library's header button ("Create"); the left panel keeps the small +. */
export function CreateMenu({ variant = "icon" }: { variant?: "icon" | "pill" }) {
  const owner = useId();
  const open = useUI((s) => s.contextMenu?.owner === owner);
  const ref = useRef<HTMLDivElement | null>(null);

  const newPlaylist = (): void => {
    // Fresh state, not the render-time count — the menu may have sat open
    // while other entries appeared. Blank confirm keeps the default name.
    const suggested = `My Playlist #${useLibrary.getState().playlists.length + 1}`;
    useUI.getState().openDialog({
      title: "New playlist",
      body: "Give your playlist a name.",
      initialValue: suggested,
      placeholder: "Playlist name",
      confirmLabel: "Create",
      onConfirm: (value) => {
        const p = useLibrary.getState().createPlaylist(value.trim() || suggested);
        useUI.getState().navigate({ name: "playlist", param: p.id });
      },
    });
  };

  const importList = (): void => {
    useUI.getState().openDialog({
      title: "Import a playlist",
      body: "Paste a Spotify playlist link, or songs one per line (Artist - Title). ByTune finds each song on YouTube Music before you save. Spotify links are read from Spotify's public page, which isn't an official feature and may stop working.",
      initialValue: "",
      placeholder: "https://open.spotify.com/playlist/…\n\nor\n\nTame Impala - Loser\nColdplay - Yellow",
      multiline: true,
      confirmLabel: "Import",
      onConfirm: (value) => void importFromText(value),
    });
  };

  const items: MenuItem[] = [
    { label: "Playlist", note: "Create a playlist with songs", icon: ListPlus, action: newPlaylist },
    // The new folder opens in the middle panel, ready to be filled.
    { label: "Folder", note: "Organize your playlists", icon: Folder, action: askForNewFolder },
    { label: "Import from Spotify or a list", note: "Paste a playlist link or song names", icon: ClipboardList, action: importList },
    { label: "Import a file", note: ".csv, .txt, .m3u8 or ByTune .json", icon: FileUp, action: () => void importPlaylistFile() },
  ];

  /** Drops below the button: the left panel's + hangs it out over the page, a header button lines up
      with it; the menu keeps itself inside the window. The button's own press keeps an open menu up
      until this click, so the click can close it (the same contract as the Settings pickers). */
  const toggle = (): void => {
    const ui = useUI.getState();
    if (ui.contextMenu?.owner === owner) {
      ui.closeContextMenu();
      return;
    }
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const hang = variant === "pill" ? 0 : 72;
    ui.openContextMenu(Math.max(12, r.left - hang), r.bottom + 8, items, { owner });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
        title="Create playlist or folder"
        aria-label="Create playlist or folder"
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          variant === "pill"
            ? HERO_PLAY
            : `p-1.5 rounded-full transition-colors ${
                open ? "text-ink-hi bg-ink-hi/[0.10]" : "text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.06]"
              }`
        }
      >
        <Plus className={variant === "pill" ? "w-5 h-5" : "w-4 h-4"} />
        {variant === "pill" && "Create"}
      </button>
    </div>
  );
}
