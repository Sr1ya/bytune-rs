/**
 * Your Library: a wall of everything you keep; then your collections (Liked Songs, Downloads, Local
 * Music, pinned first), your folders and the playlists not filed in one, each a stack of its covers
 * that opens, plays and carries its own options. A playlist or album dropped on a folder is filed or
 * imported into it; a song dropped on a playlist is added. Liked Songs and Downloads are pages of their
 * own, and the library's old routes for them (?liked, ?downloaded) open those pages.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Download, Folder, FolderOpen, Heart, Library, ListMusic, Pin, PinOff } from "lucide-react";
import { CollectionHero } from "../components/CollectionHero";
import { CoverStack } from "../components/CoverStack";
import { CreateMenu } from "../components/CreateMenu";
import { PlaylistStack, coversOf } from "../components/PlaylistStack";
import { EmptyState } from "../components/primitives";
import { dropOnFolder, folderMenuItems } from "../lib/collection";
import { dragHasAlbum, dragHasPlaylist } from "../lib/dnd";
import { plural } from "../lib/format";
import { localToTrack } from "../lib/localTrack";
import { isPinned, useLibrary, type LibraryFolder, type PinnedSingleKey, type Playlist } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { LocalTrack } from "../shared/backend-types";
import type { Track } from "../types";
import { LikedView } from "./LikedView";
import { DownloadsView } from "./DownloadsView";
import { DOWNLOADS_COVER, LIKED_COVER, LOCAL_COVER } from "../lib/libraryCovers";

type LibTab = "playlists" | "liked" | "downloaded";

function tabFromParam(param: string | undefined): LibTab {
  if (param === "liked") return "liked";
  if (param === "downloaded") return "downloaded";
  return "playlists";
}

/** A folder as a stack of its playlists' covers; a playlist or album dropped on it goes in. */
function FolderStack({ folder, playlists }: { folder: LibraryFolder; playlists: Playlist[] }) {
  const navigate = useUI((s) => s.navigate);
  const [dropping, setDropping] = useState(false);
  // A drag that ends anywhere lets go of the highlight.
  useEffect(() => {
    const off = (): void => setDropping(false);
    window.addEventListener("dragend", off);
    window.addEventListener("drop", off);
    return () => {
      window.removeEventListener("dragend", off);
      window.removeEventListener("drop", off);
    };
  }, []);
  const tracks = playlists.flatMap((p) => p.tracks);
  const menu = (x: number, y: number): void => useUI.getState().openContextMenu(x, y, folderMenuItems(folder));
  return (
    <CoverStack
      covers={playlists.flatMap(coversOf)}
      title={folder.name}
      subtitle={`Folder · ${plural(playlists.length, "playlist", "playlists")}`}
      fallback={Folder}
      lit={dropping}
      onOpen={() => navigate({ name: "folder", param: folder.id })}
      onPlay={tracks.length ? () => usePlayer.getState().playQueue(tracks, 0, folder.id) : undefined}
      onMenu={menu}
      rootProps={{
        onDragOver: (e) => {
          if (!dragHasPlaylist(e) && !dragHasAlbum(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setDropping(true);
        },
        onDragLeave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        },
        onDrop: (e) => {
          setDropping(false);
          dropOnFolder(e, folder);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          menu(e.clientX, e.clientY);
        },
      }}
    />
  );
}

function Shelf({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="mt-11 first-of-type:mt-8">
      <h2 className="section-title text-[19px] mb-4">{label}</h2>
      {children}
    </section>
  );
}

export function LibraryView() {
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const folders = useLibrary((s) => s.folders);
  const downloads = useLibrary((s) => s.downloads);
  const pinnedSingles = useLibrary((s) => s.pinnedSingles);
  const [tab, setTab] = useState<LibTab>(() => tabFromParam(useUI.getState().view.param));
  /** your local files, for Local Music's stack (and the wall) */
  const [local, setLocal] = useState<LocalTrack[]>([]);

  // The left panel deep-links here (Liked Songs → ?liked); follow the route while this stays mounted.
  useEffect(() => {
    setTab(tabFromParam(view.param));
  }, [view.name, view.param]);
  useEffect(() => {
    let live = true;
    void window.bytune
      ?.localLibrary?.()
      .then((lib) => {
        if (live && lib) setLocal((lib as { tracks: LocalTrack[] }).tracks ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (tab === "liked") return <LikedView />;
  if (tab === "downloaded") return <DownloadsView />;

  const saved: Track[] = Object.values(downloads)
    .filter((d) => d.status === "done")
    .map((d) => d.track);
  const unfiled = playlists.filter((p) => !p.folderId);
  const pinnedFirst = [...unfiled.filter((p) => p.pinned), ...unfiled.filter((p) => !p.pinned)];
  const play = (tracks: Track[], from: string) => (): void => usePlayer.getState().playQueue(tracks, 0, from);

  /** A collection's options: pin it to the top of the left panel, or unpin it. */
  const pinMenu =
    (key: PinnedSingleKey) =>
    (x: number, y: number): void => {
      const pinned = isPinned(useLibrary.getState().pinnedSingles, key);
      useUI.getState().openContextMenu(x, y, [
        { label: pinned ? "Unpin" : "Pin to top", icon: pinned ? PinOff : Pin, action: () => useLibrary.getState().togglePinSingle(key) },
      ]);
    };
  const collection = (key: PinnedSingleKey, stack: Omit<Parameters<typeof CoverStack>[0], "onMenu" | "rootProps">) => ({
    key,
    node: (
      <CoverStack
        key={key}
        {...stack}
        subtitle={`${isPinned(pinnedSingles, key) ? "Pinned · " : ""}${stack.subtitle}`}
        onMenu={pinMenu(key)}
        rootProps={{
          onContextMenu: (e) => {
            e.preventDefault();
            e.stopPropagation();
            pinMenu(key)(e.clientX, e.clientY);
          },
        }}
      />
    ),
  });
  const collections = [
    collection("liked", {
      // Each collection's own sleeve in front, its songs fanned behind.
      covers: [LIKED_COVER, ...liked.map((t) => t.thumb)],
      title: "Liked Songs",
      subtitle: plural(liked.length, "song", "songs"),
      fallback: Heart,
      onOpen: () => navigate({ name: "library", param: "liked" }),
      onPlay: liked.length ? play(liked, "__liked__") : undefined,
    }),
    collection("downloads", {
      covers: [DOWNLOADS_COVER, ...saved.map((t) => t.thumb)],
      title: "Downloads",
      subtitle: plural(saved.length, "song", "songs"),
      fallback: Download,
      onOpen: () => navigate({ name: "downloads" }),
      onPlay: saved.length ? play(saved, "__downloads__") : undefined,
    }),
    collection("local", {
      covers: [LOCAL_COVER, ...local.map((t) => t.art)],
      title: "Local Music",
      subtitle: local.length ? plural(local.length, "song", "songs") : "On this device",
      fallback: FolderOpen,
      onOpen: () => navigate({ name: "local" }),
      onPlay: local.length ? () => usePlayer.getState().playQueue(local.map(localToTrack), 0, "__local__") : undefined,
    }),
  ].sort((a, b) => Number(isPinned(pinnedSingles, b.key)) - Number(isPinned(pinnedSingles, a.key)));

  return (
    <div className="pb-16">
      <CollectionHero
        icon={Library}
        kind="Everything you keep"
        title="Your Library"
        covers={[...[...liked, ...playlists.flatMap((p) => p.tracks), ...saved].map((t) => t.thumb), ...local.map((t) => t.art)]}
        facts={[
          plural(playlists.length, "playlist", "playlists"),
          plural(folders.length, "folder", "folders"),
          plural(liked.length, "liked song", "liked songs"),
          saved.length ? plural(saved.length, "download", "downloads") : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <CreateMenu variant="pill" />
      </CollectionHero>

      <Shelf label="Collections">
        <div className="stack-grid">{collections.map((c) => c.node)}</div>
      </Shelf>

      {folders.length > 0 && (
        <Shelf label="Folders">
          <div className="stack-grid">
            {folders.map((f) => (
              <FolderStack key={f.id} folder={f} playlists={playlists.filter((p) => p.folderId === f.id)} />
            ))}
          </div>
        </Shelf>
      )}

      <Shelf label="Playlists">
        {pinnedFirst.length ? (
          <div className="stack-grid">
            {pinnedFirst.map((p) => (
              <PlaylistStack key={p.id} playlist={p} />
            ))}
          </div>
        ) : folders.length ? (
          <p className="text-[14px] text-ink-dim">All your playlists are in folders.</p>
        ) : (
          <EmptyState
            icon={ListMusic}
            title="No playlists yet"
            body='Use Create above to make a playlist or a folder, or right-click any song and choose "New playlist" to start one from a song you like.'
          />
        )}
      </Shelf>
    </div>
  );
}
