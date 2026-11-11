/**
 * One of your playlists as a stack of its songs' covers (Your Library, a folder's page): it opens the
 * playlist (one made from an artist opens the artist, as in the left panel), plays it, drags into a
 * folder, takes a song dropped on it, and has its options on right-click or its … button.
 */
import { Pin, PinOff } from "lucide-react";
import { CoverStack } from "./CoverStack";
import { draggingFromPlaylist, useDrag, useTrackDrop } from "../lib/dnd";
import { addSongToPlaylist } from "../lib/panelDrop";
import { playlistOwnItems } from "../lib/trackActions";
import { plural } from "../lib/format";
import { useLibrary, type Playlist } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";

/** A playlist's covers; an artist's playlist leads with the artist's photo. */
export const coversOf = (p: Playlist): Array<string | undefined> => [p.artistThumb, ...p.tracks.map((t) => t.thumb)];

export function PlaylistStack({ playlist }: { playlist: Playlist }) {
  const navigate = useUI((s) => s.navigate);
  const drag = useDrag({ playlist: { id: playlist.id, title: playlist.name, thumb: playlist.tracks[0]?.thumb || undefined } });
  const drop = useTrackDrop(
    (track) => addSongToPlaylist(playlist.id, track),
    () => !draggingFromPlaylist(playlist.id),
  );
  // Pinning keeps a playlist at the top of the left panel; one in a folder lives in its folder.
  const pinned = !!playlist.pinned && !playlist.folderId;
  const menu = (x: number, y: number): void =>
    useUI.getState().openContextMenu(x, y, [
      ...(playlist.folderId
        ? []
        : [
            {
              label: pinned ? "Unpin playlist" : "Pin playlist",
              icon: pinned ? PinOff : Pin,
              action: () => useLibrary.getState().togglePinPlaylist(playlist.id),
            },
          ]),
      ...playlistOwnItems(playlist),
    ]);
  return (
    <CoverStack
      covers={coversOf(playlist)}
      title={playlist.name}
      subtitle={`${pinned ? "Pinned · " : ""}${plural(playlist.tracks.length, "song", "songs")}`}
      onOpen={() => navigate(playlist.artistId ? { name: "artist", param: playlist.artistId } : { name: "playlist", param: playlist.id })}
      onPlay={playlist.tracks.length ? () => usePlayer.getState().playQueue(playlist.tracks, 0, playlist.id) : undefined}
      onMenu={menu}
      lit={drop.hovering}
      rootProps={{
        ...drag.props,
        ...drop.props,
        onContextMenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          menu(e.clientX, e.clientY);
        },
      }}
    />
  );
}
