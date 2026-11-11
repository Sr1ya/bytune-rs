import { playAlbum } from "../lib/album";
import { playPlaylist } from "../lib/playlist";
import { albumPayload, useDrag } from "../lib/dnd";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI, type MenuItem } from "../stores/ui";
import { trackMenuItems } from "../lib/trackActions";
import { Artwork, PlayOverlay, ShelfScroller } from "./primitives";
import { FitText } from "./FitText";
import { shortTitle } from "../lib/format";
import type { Album, Artist, HomeItem, HomeShelf, PlaylistCard, Track } from "../types";
import type { KeyboardEvent } from "react";

/** Keyboard activation for div-based cards (button semantics, kept clickable). */
function activateOnKey(open: () => void) {
  return (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
}

/* Shelf tile: artwork-first, square cover over title/subtitle — the card is
   transparent at rest; hovering fades in Spotify's translucent tile around
   it. 8px inset keeps Spotify's proportion at this size; width grows to
   keep the cover at its tuned 168px. */
const CARD =
  "fit-host group w-[184px] shrink-0 text-left cursor-pointer active:scale-[0.98] rounded-xl p-2 transition-colors duration-200 hover:bg-ink-hi/[0.08]";

const CARD_TITLE = "text-[15px] font-semibold text-ink-hi leading-snug";
const CARD_SUB = "text-[13px] text-ink-dim mt-0.5";

export function TrackCard({ track, menu = () => trackMenuItems(track) }: { track: Track; menu?: () => MenuItem[] }) {
  const playTrack = usePlayer((s) => s.playTrack);
  const drag = useDrag({ track });
  const open = (): void => playTrack(track);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, menu());
      }}
      onKeyDown={activateOnKey(open)}
      {...tintHoverHandlers(track.thumb)}
      {...drag.props}
      className={`${CARD} select-none ${drag.dragging ? "opacity-40" : ""}`}
    >
      <div className="relative overflow-hidden rounded-xl">
        <Artwork src={track.thumb} className="w-full aspect-square rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" iconClassName="w-7 h-7" />
        <PlayOverlay onClick={() => playTrack(track)} />
      </div>
      <div className="mt-2.5">
        <FitText lines={2} text={shortTitle(track.title)} full={track.title} className={CARD_TITLE} />
        <FitText text={track.artist} className={CARD_SUB} />
      </div>
    </div>
  );
}

export function AlbumCard({ album }: { album: Album }) {
  const navigate = useUI((s) => s.navigate);
  const drag = useDrag({ album: albumPayload(album) });
  const open = (): void => navigate({ name: "album", param: album.id });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={activateOnKey(open)}
      {...tintHoverHandlers(album.thumb)}
      {...drag.props}
      title="Drag into Your Library to import this album"
      className={`${CARD} select-none ${drag.dragging ? "opacity-40" : ""}`}
    >
      <div className="relative overflow-hidden rounded-xl">
        <Artwork src={album.thumb} className="w-full aspect-square rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" iconClassName="w-7 h-7" />
        <PlayOverlay onClick={() => void playAlbum(album.id)} />
      </div>
      <div className="mt-2.5">
        <FitText lines={2} text={shortTitle(album.title)} full={album.title} className={CARD_TITLE} />
        <FitText text={`${album.artist}${album.year ? ` · ${album.year}` : ""}`} className={CARD_SUB} />
      </div>
    </div>
  );
}

export function ArtistCard({ artist }: { artist: Artist }) {
  const navigate = useUI((s) => s.navigate);
  const drag = useDrag({ artist: { id: artist.id, name: artist.name, thumb: artist.thumb || undefined } });
  const open = (): void => navigate({ name: "artist", param: artist.id });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={activateOnKey(open)}
      {...tintHoverHandlers(artist.thumb)}
      {...drag.props}
      title="Drag into Your Library to import this artist's top songs"
      className={`${CARD} select-none ${drag.dragging ? "opacity-40" : ""}`}
    >
      <div className="relative overflow-hidden rounded-full">
        <Artwork src={artist.thumb} className="w-full aspect-square rounded-full transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" iconClassName="w-8 h-8" />
      </div>
      <div className="mt-2.5">
        <FitText lines={2} text={artist.name} className={CARD_TITLE} />
        <FitText text={artist.subtitle ?? "Artist"} className={CARD_SUB} />
      </div>
    </div>
  );
}

export function PlaylistCardView({ playlist }: { playlist: PlaylistCard }) {
  const navigate = useUI((s) => s.navigate);
  const drag = useDrag({ playlist: { id: playlist.id, title: playlist.title, thumb: playlist.thumb || undefined } });
  const open = (): void => navigate({ name: "ytplaylist", param: playlist.id });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={activateOnKey(open)}
      {...tintHoverHandlers(playlist.thumb)}
      {...drag.props}
      title="Drag into Your Library to import this playlist"
      className={`${CARD} select-none ${drag.dragging ? "opacity-40" : ""}`}
    >
      <div className="relative overflow-hidden rounded-xl">
        <Artwork src={playlist.thumb} className="w-full aspect-square rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" iconClassName="w-7 h-7" />
        <PlayOverlay onClick={() => void playPlaylist(playlist.id)} />
      </div>
      <div className="mt-2.5">
        <FitText lines={2} text={playlist.title} className={CARD_TITLE} />
        <FitText text={playlist.subtitle || "Playlist"} className={CARD_SUB} />
      </div>
    </div>
  );
}

/** Horizontal, scrollable music shelf. */
export function HomeShelfView({ shelf }: { shelf: HomeShelf }) {
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[21px] mb-4">{shelf.title}</h2>
      <ShelfScroller>
        {shelf.items.map((item: HomeItem, i: number) => {
          if (item.kind === "track" && item.track) return <TrackCard key={`${item.track.id}-${i}`} track={item.track} />;
          if (item.kind === "album" && item.album) return <AlbumCard key={`${item.album.id}-${i}`} album={item.album} />;
          if (item.kind === "artist" && item.artist) return <ArtistCard key={`${item.artist.id}-${i}`} artist={item.artist} />;
          if (item.kind === "playlist" && item.playlist)
            return <PlaylistCardView key={`${item.playlist.id}-${i}`} playlist={item.playlist} />;
          return null;
        })}
      </ShelfScroller>
    </section>
  );
}
