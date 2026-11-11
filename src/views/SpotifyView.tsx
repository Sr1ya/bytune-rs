/**
 * The connected Spotify account as ByTune shows it: a wall of its playlists' covers under Spotify's own
 * mark and a light of its green; then the playlists as stacks of their covers (Liked Songs first, on a
 * sleeve of ByTune's own), each opening that playlist matched to YouTube Music (MatchedPlaylistView).
 * Not connected, or needing to sign in again, the page says so and offers to.
 */
import { useEffect, useState } from "react";
import { ExternalLink, ListMusic, MoreHorizontal, RefreshCw, Settings, Unplug } from "lucide-react";
import { CollectionHero, HERO_PLAY } from "../components/CollectionHero";
import { CoverStack } from "../components/CoverStack";
import { HERO_PILL, HERO_ROUND } from "../components/PlaylistHero";
import { SPOTIFY_GREEN, SpotifyIcon } from "../components/SpotifyIcon";
import { plural } from "../lib/format";
import { askToDisconnectSpotify, connectSpotify, spotifyUrl, useSpotify } from "../lib/spotify";
import { useUI } from "../stores/ui";
import type { SpotifyPlaylistInfo } from "../types";

const LIKED = "liked";

/** Liked Songs has no artwork on Spotify: its sleeve is ByTune's own, a white heart in Spotify's green light. */
const LIKED_SLEEVE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><defs><radialGradient id="l" cx="50%" cy="115%" r="100%">` +
    `<stop offset="0" stop-color="${SPOTIFY_GREEN}" stop-opacity="0.95"/><stop offset="0.45" stop-color="${SPOTIFY_GREEN}" stop-opacity="0.3"/>` +
    `<stop offset="1" stop-color="${SPOTIFY_GREEN}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="240" height="240" fill="#0c120e"/><rect width="240" height="240" fill="url(#l)"/>` +
    `<path transform="translate(84 82) scale(3)" fill="#fff" d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`
)}`;

/** Spotify's web player, or one of the account's playlists there; in the system browser. */
const openOnSpotify = (id?: string): void => void window.open(id ? spotifyUrl(id) : "https://open.spotify.com", "_blank", "noopener");

/** One of the account's playlists as a stack: it opens matched to YouTube Music; its menu opens it on Spotify. */
function SpotifyStack({ playlist, account }: { playlist: SpotifyPlaylistInfo; account?: string }) {
  const liked = playlist.id === LIKED;
  const open = (): void => useUI.getState().navigate({ name: "spotify", param: playlist.id });
  const menu = (x: number, y: number): void =>
    useUI.getState().openContextMenu(x, y, [{ label: "Open in Spotify", icon: ExternalLink, action: () => openOnSpotify(playlist.id) }]);
  return (
    <CoverStack
      covers={[liked ? LIKED_SLEEVE : playlist.thumb]}
      title={playlist.name}
      subtitle={liked ? "Liked on Spotify" : !playlist.owner ? "Playlist" : playlist.owner === account ? "By you" : `By ${playlist.owner}`}
      fallback={ListMusic}
      onOpen={open}
      onMenu={menu}
      rootProps={{
        onContextMenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          menu(e.clientX, e.clientY);
        },
      }}
    />
  );
}

export function SpotifyView() {
  const status = useSpotify((s) => s.status);
  const playlists = useSpotify((s) => s.playlists);
  const connecting = useSpotify((s) => s.connecting);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = (): void => {
    setRefreshing(true);
    void useSpotify
      .getState()
      .refresh()
      .finally(() => setRefreshing(false));
  };
  // Opening the page reads the library again: playlists made or removed in Spotify since show up.
  useEffect(() => {
    if (useSpotify.getState().status.connected) refresh();
  }, []);

  const mark = <SpotifyIcon className="w-6 h-6 shrink-0" />;
  const note = (
    <p className="pt-10 text-[12px] text-ink-faint leading-relaxed max-w-2xl">
      Songs play from YouTube Music, matched by title, artist and length. ByTune reads your playlists the way Spotify's web player does,
      which isn't an official Spotify feature, so it may stop working.
    </p>
  );

  if (!status.connected || status.problem) {
    return (
      <div className="pb-16">
        <CollectionHero
          mark={mark}
          light={SPOTIFY_GREEN}
          kind={status.connected ? "Needs reconnecting" : "Not connected"}
          title="Spotify"
          covers={[]}
          facts={
            <span className="block max-w-[56ch]">
              {status.problem ?? "Sign in to Spotify in a window of its own, and your playlists and Liked Songs show up here, played from YouTube Music."}
            </span>
          }
        >
          <button type="button" className={HERO_PLAY} onClick={() => void connectSpotify()} disabled={connecting}>
            {connecting ? "Finish signing in in the Spotify window" : status.connected ? "Reconnect" : "Connect Spotify"}
          </button>
        </CollectionHero>
        {note}
      </div>
    );
  }

  const liked = playlists.find((p) => p.id === LIKED);
  const own = playlists.filter((p) => p.id !== LIKED);
  const facts = playlists.length
    ? `${plural(own.length, "playlist", "playlists")}${liked ? " and your Liked Songs" : ""}`
    : refreshing
      ? "Reading your library"
      : "No playlists yet";
  const menu = (x: number, y: number): void =>
    useUI.getState().openContextMenu(x, y, [
      { label: "Open Spotify", icon: ExternalLink, action: () => openOnSpotify() },
      { label: "Spotify in Settings", icon: Settings, action: () => useUI.getState().openSettings("account") },
      { label: "Disconnect Spotify", icon: Unplug, danger: true, separatorBefore: true, action: askToDisconnectSpotify },
    ]);

  return (
    <div className="pb-16">
      <CollectionHero
        mark={mark}
        light={SPOTIFY_GREEN}
        kind={status.name ? `Connected as ${status.name}` : "Connected"}
        title="Spotify"
        covers={own.map((p) => p.thumb)}
        facts={facts}
      >
        <button type="button" className={HERO_PILL} onClick={refresh} disabled={refreshing} title="Read your Spotify library again">
          <RefreshCw className={`w-[18px] h-[18px] ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
        <button
          type="button"
          className={HERO_ROUND}
          aria-label="More options"
          title="More options"
          onClick={(e) => menu(e.clientX, e.clientY)}
        >
          <MoreHorizontal className="w-5 h-5" />
        </button>
      </CollectionHero>

      <section aria-label="Your Spotify playlists" className="mt-8">
        <h2 className="section-title text-[19px] mb-4">Playlists</h2>
        {playlists.length ? (
          <div className="stack-grid">
            {[...(liked ? [liked] : []), ...own].map((p) => (
              <SpotifyStack key={p.id} playlist={p} account={status.name} />
            ))}
          </div>
        ) : (
          !refreshing && <p className="text-[14px] text-ink-dim">This Spotify account has no playlists yet.</p>
        )}
      </section>
      {note}
    </div>
  );
}
