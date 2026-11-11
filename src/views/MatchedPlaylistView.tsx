/**
 * A playlist from outside ByTune, matched to YouTube Music, as a collection page: a wall of its songs'
 * covers (under Spotify's own mark and a light of its green when it comes from Spotify), its name, how
 * many songs and how the matching goes, Play, Shuffle, Save to library and its options; then its songs
 * as lit rows. Each row shows the song as its source lists it until a YouTube Music match is found, then
 * plays that; a song YouTube Music doesn't have stays listed, dimmed. Save keeps the matched songs as a
 * ByTune playlist. One of the connected account's playlists is named from the library at once and fills
 * in as Spotify answers; an import (a Spotify link, a CSV, a pasted list) is here already.
 */
import { useEffect, useState } from "react";
import { Download, ExternalLink, Heart, ListMusic, ListPlus, MoreHorizontal, Play, Plus, RotateCw, Shuffle } from "lucide-react";
import { Artwork, EqBars, ErrorState, ExplicitBadge, ListSkeleton } from "../components/primitives";
import { CollectionHero, HERO_PLAY } from "../components/CollectionHero";
import { HERO_PILL, HERO_ROUND } from "../components/PlaylistHero";
import { PlayingLight, useRowLight } from "../components/RowLight";
import { SPOTIFY_GREEN, SpotifyIcon } from "../components/SpotifyIcon";
import { DownloadBadge } from "../components/TrackList";
import { FitText } from "../components/FitText";
import { requireBridge } from "../lib/bridge";
import { useDrag } from "../lib/dnd";
import { downloadAll } from "../lib/downloads";
import { fmtTime, plural, shortTitle } from "../lib/format";
import { pendingImport } from "../lib/importSongs";
import { ipcMessage, spotifyUrl, useSpotify } from "../lib/spotify";
import { trackMenuItems } from "../lib/trackActions";
import { useSongMatches, type MatchState } from "../lib/useSongMatches";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { ImportedPlaylist, ImportSong, Track } from "../types";

const NO_TRACK: Track = { id: "", title: "", artist: "", duration: 0, thumb: "" };

const LANGUAGE_LABEL: Record<string, string> = {
  telugu: "Telugu", tamil: "Tamil", hindi: "Hindi", kannada: "Kannada", malayalam: "Malayalam", english: "English",
};

function MatchRow({
  song,
  state,
  index,
  onPlay,
  onHover,
}: {
  song: ImportSong;
  state: MatchState | undefined;
  index: number;
  onPlay: () => void;
  /** the pointer came onto this row: the list's light moves to it (none for a song that can't play) */
  onHover: (row: HTMLElement, thumb: string | null | undefined) => void;
}) {
  const track = state?.state === "matched" ? state.track : null;
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const playing = usePlayer((s) => s.playing);
  const liked = useLibrary((s) => !!track && s.liked.some((t) => t.id === track.id));
  const toggleLike = useLibrary((s) => s.toggleLike);
  // An unmatched row has nothing to drag: its props are never spread.
  const drag = useDrag({ track: track ?? NO_TRACK });
  const current = !!track && currentId === track.id;
  const thumb = song.thumb || track?.thumb || "";
  const openMenu = (x: number, y: number): void => {
    if (track) useUI.getState().openContextMenu(x, y, trackMenuItems(track));
  };
  const status =
    !state || state.state === "matching" ? "Finding…" : state.state === "missing" ? "Not on YouTube Music" : state.state === "failed" ? "Couldn't check" : null;
  const dim = state?.state === "missing" || state?.state === "failed";
  return (
    <div
      {...(track ? drag.props : {})}
      onMouseEnter={(e) => onHover(e.currentTarget, track ? thumb : null)}
      onClick={track ? onPlay : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      title={track && (track.title !== song.title || track.artist !== song.artist) ? `Plays “${track.title}” by ${track.artist}` : undefined}
      className={`tl-row fit-host group flex items-center gap-3.5 h-[64px] px-3 rounded-lg select-none ${
        track ? "cursor-pointer" : "cursor-default"
      } ${current ? "bg-ink-hi/[0.06]" : track ? "hover:bg-ink-hi/[0.04]" : ""} ${dim ? "opacity-45" : ""} ${drag.dragging ? "opacity-40" : ""}`}
    >
      {current && <PlayingLight thumb={thumb} />}
      <div className="w-7 shrink-0 grid place-items-center text-[13px] text-ink-faint tabular-nums">
        {current && playing ? (
          <EqBars />
        ) : (
          <>
            <span className={`${track ? "group-hover:hidden" : ""} ${current ? "text-ink-hi font-medium" : ""}`}>{index + 1}</span>
            {track && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (current) usePlayer.getState().toggle();
                  else onPlay();
                }}
                className="hidden group-hover:block text-ink-hi"
                title="Play"
                aria-label={`Play ${song.title}`}
              >
                <Play className="w-3.5 h-3.5 fill-current" />
              </button>
            )}
          </>
        )}
      </div>
      <Artwork src={thumb} className="w-[52px] h-[52px] rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.2px] text-ink-hi">
          {song.explicit && <ExplicitBadge />}
          <FitText text={shortTitle(song.title)} full={song.title} />
        </div>
        <FitText text={song.artist || "Unknown artist"} className="text-[14px] text-ink-dim mt-0.5" />
      </div>
      {track ? (
        <>
          <div className="w-[88px] shrink-0 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleLike(track);
              }}
              title={liked ? "Remove from Liked" : "Add to Liked"}
              aria-label={liked ? "Remove from Liked" : "Add to Liked"}
              className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
            >
              <Heart key={liked ? "liked" : "unliked"} className={`w-4 h-4 animate-icon-pop ${liked ? "fill-ink-hi text-ink-hi" : ""}`} />
            </button>
            <span className="opacity-80">
              <DownloadBadge id={track.id} />
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                openMenu(e.clientX, e.clientY);
              }}
              title="More options"
              aria-label={`More options for ${song.title}`}
              className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
          <div className="w-11 shrink-0 text-right text-xs text-ink-faint tabular-nums">{track.duration > 0 ? fmtTime(track.duration) : "—"}</div>
        </>
      ) : (
        <div className="shrink-0 text-[13px] text-ink-faint">{status}</div>
      )}
    </div>
  );
}

/** spotifyId: a connected account's playlist; otherwise importId names the import being shown. */
export function MatchedPlaylistView({ spotifyId, importId = "" }: { spotifyId: string | null; importId?: string }) {
  const prefer = useSettings((s) => s.matchLanguage);
  // What the library already knows of the account's playlist: its name and owner show at once.
  const known = useSpotify((s) => (spotifyId === null ? undefined : s.playlists.find((p) => p.id === spotifyId)));
  const account = useSpotify((s) => s.status.name);
  const [playlist, setPlaylist] = useState<(ImportedPlaylist & { fromSpotify: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const rowLight = useRowLight();

  useEffect(() => {
    let live = true;
    setError(null);
    if (spotifyId === null) {
      setPlaylist(pendingImport(importId));
      return;
    }
    setPlaylist(null);
    requireBridge()
      .spotifyPlaylist(spotifyId)
      .then(
        (p) => live && setPlaylist({ ...p, fromSpotify: true }),
        (err: unknown) => live && setError(ipcMessage(err, "Couldn't load this playlist."))
      );
    return () => {
      live = false;
    };
  }, [spotifyId, importId, reload]);

  const states = useSongMatches(playlist?.songs ?? null, prefer, attempt);

  if (error) {
    return <ErrorState title="Couldn't load this playlist" body={error} onRetry={() => setReload((n) => n + 1)} className="pt-10" />;
  }
  if (spotifyId === null && !playlist) {
    return (
      <ErrorState
        title="Nothing to import"
        body="Import a playlist from the + in Your Library: a Spotify link, a CSV file, or a list of songs."
        className="pt-10"
      />
    );
  }

  // Only the account's own playlists load here, so a page still loading is a Spotify one.
  const loading = !playlist;
  const fromSpotify = playlist ? playlist.fromSpotify : true;
  const songs = playlist?.songs ?? [];
  const name = playlist?.name ?? known?.name ?? (spotifyId === "liked" ? "Liked Songs" : "Spotify playlist");
  const owner = playlist?.owner ?? known?.owner;
  const matched: Track[] = [];
  const position: number[] = [];
  let finding = 0;
  let missing = 0;
  let failed = 0;
  songs.forEach((_, i) => {
    const s = states[i];
    if (s?.state === "matched") {
      position[i] = matched.length;
      matched.push(s.track);
    } else if (!s || s.state === "matching") finding++;
    else if (s.state === "missing") missing++;
    else failed++;
  });
  const done = !loading && finding === 0;
  const play = (shuffle: boolean): void => {
    if (!matched.length) return;
    if (shuffle) usePlayer.setState({ shuffle: true });
    usePlayer.getState().playQueue(matched, shuffle ? Math.floor(Math.random() * matched.length) : 0);
  };
  const save = (): void => {
    if (!playlist) return;
    const p = useLibrary.getState().importPlaylist(playlist.name, matched);
    useUI.getState().toast(`Saved “${p.name}” to your library`, "success");
    useUI.getState().navigate({ name: "playlist", param: p.id });
  };
  const openMenu = (x: number, y: number): void =>
    useUI.getState().openContextMenu(x, y, [
      {
        label: "Add all to queue",
        icon: ListPlus,
        disabled: !matched.length,
        action: () => {
          usePlayer.getState().addToQueue(matched);
          useUI.getState().toast("Added to queue");
        },
      },
      { label: "Download all", icon: Download, disabled: !matched.length, action: () => downloadAll(matched, "this playlist") },
      ...(spotifyId
        ? [
            {
              label: "Open in Spotify",
              icon: ExternalLink,
              separatorBefore: true,
              action: () => void window.open(spotifyUrl(spotifyId), "_blank", "noopener"),
            },
          ]
        : []),
    ]);

  const progress =
    loading || !songs.length
      ? null
      : !done
        ? `Finding ${songs.length - finding} of ${songs.length} songs on YouTube Music…`
        : `${matched.length} of ${songs.length} songs found on YouTube Music${missing ? `. ${missing === 1 ? "1 isn't" : `${missing} aren't`} there` : ""}${
            failed ? `. ${failed} couldn't be checked` : ""
          }.`;
  const cut = playlist && playlist.total > songs.length ? `The playlist has ${playlist.total} songs; ByTune could read the first ${songs.length}.` : null;
  // Songs from a pasted list have no covers of their own: theirs from YouTube Music join once all are found.
  const covers = [playlist?.thumb, ...songs.map((s) => s.thumb), ...(done ? matched.map((t) => t.thumb) : [])];

  return (
    <div className="pb-14">
      <CollectionHero
        icon={fromSpotify ? undefined : ListMusic}
        mark={fromSpotify ? <SpotifyIcon className="w-6 h-6 shrink-0" /> : undefined}
        light={fromSpotify ? SPOTIFY_GREEN : undefined}
        kind={!fromSpotify ? "Imported list" : spotifyId === "liked" ? "Liked on Spotify" : "Spotify playlist"}
        title={name}
        covers={covers}
        facts={
          <>
            {loading
              ? "Reading the playlist from Spotify"
              : [plural(songs.length, "song", "songs"), owner ? (fromSpotify && owner === account ? "By you" : `By ${owner}`) : null]
                  .filter(Boolean)
                  .join(" · ")}
            {(progress || cut) && (
              <span className="block mt-1.5 text-[13px] text-white/60" aria-live="polite">
                {[progress, cut].filter(Boolean).join(" ")}
                {done && failed > 0 && (
                  <button onClick={() => setAttempt((n) => n + 1)} className="ml-2 inline-flex items-center gap-1 text-white hover:underline">
                    <RotateCw className="w-3.5 h-3.5" /> Try again
                  </button>
                )}
              </span>
            )}
          </>
        }
      >
        <button type="button" className={HERO_PLAY} onClick={() => play(false)} disabled={!matched.length} aria-label={`Play ${name}`}>
          <Play className="w-5 h-5 fill-current" />
          Play
        </button>
        <button type="button" className={HERO_ROUND} onClick={() => play(true)} disabled={!matched.length} aria-label="Shuffle" title="Shuffle">
          <Shuffle className="w-5 h-5" />
        </button>
        <button
          type="button"
          className={HERO_PILL}
          onClick={save}
          disabled={!done || !matched.length}
          title={done ? "Save the matched songs as a playlist" : "Available once every song is checked"}
        >
          <Plus className="w-[18px] h-[18px]" />
          Save to library
        </button>
        <button type="button" className={HERO_ROUND} aria-label="More options" title="More options" onClick={(e) => openMenu(e.clientX, e.clientY)}>
          <MoreHorizontal className="w-5 h-5" />
        </button>
      </CollectionHero>

      <div className="pt-6">
        {loading ? (
          <ListSkeleton rows={7} />
        ) : songs.length ? (
          <div className="relative" onMouseLeave={rowLight.leave}>
            {rowLight.light}
            {songs.map((song, i) => (
              <div key={`${song.spotifyId ?? song.title}-${i}`}>
                <MatchRow song={song} state={states[i]} index={i} onPlay={() => usePlayer.getState().playQueue(matched, position[i])} onHover={rowLight.hover} />
                {i < songs.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[112px] mr-3" />}
              </div>
            ))}
          </div>
        ) : (
          <p className="px-3 text-[14px] text-ink-dim">This playlist has no songs yet.</p>
        )}
        <p className="px-3 pt-6 text-[12px] text-ink-faint leading-relaxed max-w-2xl">
          {prefer ? `Prefers ${LANGUAGE_LABEL[prefer] ?? prefer} versions of a song where YouTube Music has several (Settings › Connected services). ` : ""}
          {fromSpotify ? "Read from Spotify's own pages. That isn't an official Spotify feature, so it may stop working." : ""}
        </p>
      </div>
    </div>
  );
}
