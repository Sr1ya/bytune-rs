/**
 * A folder of the listener's playlists, opened from the left panel: a wall of its playlists' covers,
 * Play and Shuffle for everything in it, its playlists as stacks of their covers, and the listener's
 * other playlists to add with a click, so a new folder opens with something to do. A playlist or an
 * album dropped anywhere on the page is filed or imported into the folder; a song dropped on one of
 * its playlists is added to that playlist.
 */
import { useEffect, useState } from "react";
import { Folder, FolderX, MoreHorizontal, Play, Plus, Shuffle } from "lucide-react";
import { CollectionHero, HERO_PLAY } from "../components/CollectionHero";
import { PlaylistStack, coversOf } from "../components/PlaylistStack";
import { HERO_ROUND } from "../components/PlaylistHero";
import { FitText } from "../components/FitText";
import { Artwork, Btn, EmptyState } from "../components/primitives";
import { collectionFacts, dropOnFolder, folderMenuItems } from "../lib/collection";
import { dragHasAlbum, dragHasPlaylist } from "../lib/dnd";
import { plural } from "../lib/format";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";

export function FolderView({ folderId }: { folderId: string }) {
  const folder = useLibrary((s) => s.folders.find((f) => f.id === folderId));
  const folders = useLibrary((s) => s.folders);
  const playlists = useLibrary((s) => s.playlists);
  const navigate = useUI((s) => s.navigate);
  /** a playlist or album is being dragged over the page */
  const [dropping, setDropping] = useState(false);

  // A drag that ends anywhere (cancelled, or dropped elsewhere) lets go of the highlight.
  useEffect(() => {
    const off = (): void => setDropping(false);
    window.addEventListener("dragend", off);
    window.addEventListener("drop", off);
    return () => {
      window.removeEventListener("dragend", off);
      window.removeEventListener("drop", off);
    };
  }, []);

  if (!folder) {
    return (
      <EmptyState
        icon={FolderX}
        title="This folder isn't here anymore"
        body="It was deleted, here or on another device. Its playlists are back in Your Library."
        action={
          <Btn variant="white" onClick={() => navigate({ name: "library" })}>
            Open Your Library
          </Btn>
        }
      />
    );
  }

  const inside = playlists.filter((p) => p.folderId === folder.id);
  const others = playlists.filter((p) => p.folderId !== folder.id);
  const tracks = inside.flatMap((p) => p.tracks);
  const facts = collectionFacts(tracks);
  const play = (shuffle: boolean): void => {
    if (!tracks.length) return;
    if (shuffle) usePlayer.setState({ shuffle: true });
    usePlayer.getState().playQueue(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0, folder.id);
  };

  return (
    <div
      className="pb-16"
      onDragOver={(e) => {
        if (!dragHasPlaylist(e) && !dragHasAlbum(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        dropOnFolder(e, folder);
      }}
    >
      <CollectionHero
        icon={Folder}
        kind="Folder"
        title={folder.name}
        covers={inside.flatMap(coversOf)}
        facts={[plural(inside.length, "playlist", "playlists"), tracks.length ? facts.songs : null, facts.length].filter(Boolean).join(" · ")}
      >
        <button type="button" className={HERO_PLAY} aria-label={`Play ${folder.name}`} disabled={!tracks.length} onClick={() => play(false)}>
          <Play className="w-5 h-5 fill-current" />
          Play
        </button>
        <button type="button" className={HERO_ROUND} aria-label="Shuffle" title="Shuffle" disabled={!tracks.length} onClick={() => play(true)}>
          <Shuffle className="w-5 h-5" />
        </button>
        <button
          type="button"
          className={HERO_ROUND}
          aria-label="Folder options"
          title="More"
          // Deleted from its own page: back to Your Library, where its playlists now are.
          onClick={(e) => useUI.getState().openContextMenu(e.clientX, e.clientY, folderMenuItems(folder, () => navigate({ name: "library" })))}
        >
          <MoreHorizontal className="w-5 h-5" />
        </button>
      </CollectionHero>

      {inside.length > 0 ? (
        <section
          aria-label={`Playlists in ${folder.name}`}
          className={`stack-grid mt-8 rounded-2xl transition-shadow ${dropping ? "shadow-[0_0_0_2px_rgb(var(--accent)/0.55)]" : ""}`}
        >
          {inside.map((p) => (
            <PlaylistStack key={p.id} playlist={p} />
          ))}
        </section>
      ) : (
        <div
          className={`mt-8 rounded-2xl border border-dashed px-6 py-12 text-center transition-colors ${
            dropping ? "border-accent/70 bg-accent/[0.06]" : "border-ink-hi/15"
          }`}
        >
          <p className="text-[17px] font-semibold text-ink-hi">Nothing in here yet</p>
          <p className="text-[14px] text-ink-dim mt-1">
            {others.length ? "Add your playlists below, or drag one here." : "Drag a playlist or an album here, or make a playlist first."}
          </p>
        </div>
      )}

      {others.length > 0 && (
        <section aria-label={`Add to ${folder.name}`} className="mt-12">
          <h2 className="section-title text-[19px]">Add playlists</h2>
          <p className="text-[13.5px] text-ink-dim mt-1">
            {inside.length ? "More of yours to keep in this folder." : "Pick the playlists this folder keeps."}
          </p>
          <div className="mt-4 grid gap-1 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {others.map((p) => {
              const elsewhere = p.folderId ? folders.find((f) => f.id === p.folderId)?.name : undefined;
              return (
                <div key={p.id} className="flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-ink-hi/[0.04] transition-colors">
                  <Artwork src={p.artistThumb ?? p.tracks[0]?.thumb} className="w-11 h-11 rounded-md shrink-0" iconClassName="w-4 h-4" alt="" />
                  <div className="min-w-0 flex-1">
                    <FitText text={p.name} className="text-[14.5px] font-semibold text-ink-hi" />
                    <span className="block text-[12.5px] text-ink-dim">
                      {elsewhere ? `In “${elsewhere}”` : plural(p.tracks.length, "song", "songs")}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Add ${p.name} to ${folder.name}`}
                    onClick={() => useLibrary.getState().setPlaylistFolder(p.id, folder.id)}
                    className="shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-ink-hi/15 text-[13.5px] font-semibold text-ink-hi hover:bg-white hover:text-black hover:border-white transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
