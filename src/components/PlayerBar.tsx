/**
 * PlayerBar — point-for-point clone of the Spotify web player's
 * now-playing bar. All values below were extracted from Spotify's live
 * computed styles (DevTools), and every icon is Spotify's own SVG
 * geometry extracted verbatim from the page (SpotifyIcons.tsx):
 *
 *  - black 88px bar (measured off the desktop app), 56px content row
 *    centred → 16px inset top/bottom; 16px to the cover on the left, 8px
 *    footer padding + 8px button padding = 16px to the last glyph on the right
 *  - left: 56px cover (4px radius, #282828 placeholder), 10px gap,
 *    title 14/19 white + artists 12/17 #b3b3b3, both with Spotify's
 *    6px underline-padding trick and hover underline; like button 16×32
 *    with a 16px icon (#b3b3b3 → white), 16px after the text
 *  - centre: [shuffle, prev] —16px— play disc —16px— [next, repeat], the
 *    groups flex-1 so the disc sits dead centre; buttons 32×32 (8px pad,
 *    full radius), icons 16×16 #b3b3b3 → white on hover; disc 32px white
 *    with the black 16px glyph; active modes keep their colour with a
 *    white dot beneath (Spotify's treatment)
 *  - seek row (8px below transport): fixed 50px time boxes (12/17
 *    #b3b3b3) flanking a flexible bar — 12px hit area, 4px track (2px
 *    radius, white @30%), white fill, 12px white handle on hover
 *  - right: sleep timer / lyrics / queue / volume (speaker 32px + 67px track)
 *    / miniplayer / fullscreen — 16px icons white @70% → white on hover
 */
import { useEffect, useRef, useState } from "react";
import { ROOMS } from "../lib/features";
import { Heart, ListMusic, ListPlus, Loader2, Moon, Users } from "lucide-react";
import { useRoom } from "../stores/room";
import {
  SpCheck,
  SpCoverNote,
  SpExitFullscreen,
  SpFullscreen,
  SpLyrics,
  SpMiniplayer,
  SpNext,
  SpPause,
  SpPlay,
  SpPlus,
  SpPrev,
  SpQueue,
  SpRepeat,
  SpRepeatOne,
  SpShuffle,
  SpVolumeHigh,
  SpVolumeOff,
} from "./SpotifyIcons";
import { SeekBar, VolumeControl } from "./Controls";
import { useLibrary } from "../stores/library";
import { usePlayer, shownTrack } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI, type MenuItem } from "../stores/ui";
import { upgradeArtwork } from "../lib/artwork";
import { useDrag } from "../lib/dnd";
import { shortTitle } from "../lib/format";
import { addSongsToPlaylists, newPlaylistWith } from "../lib/devicePlaylists";
import { FitText } from "./FitText";
import { SLEEP_MAX_MINUTES, formatSleepLeft, parseSleepMinutes, useSleepTimer } from "../lib/sleepTimer";

/* Transport button — 32×32, 16px glyph, colour-only hover (Spotify). */
function TransportButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`relative grid h-8 w-8 place-items-center rounded-full transition-colors ${
        active ? "text-white" : "text-[#b3b3b3] hover:text-white"
      }`}
    >
      {children}
      {active && (
        <span className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white" />
      )}
    </button>
  );
}

/* Right-cluster button — 32×32, 16px icon white @70% → white. */
function BarButton({
  onClick,
  active,
  title,
  className: extra = "",
  menu,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  className?: string;
  /** opens a menu instead of toggling */
  menu?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={menu ? undefined : active}
      aria-haspopup={menu ? "menu" : undefined}
      className={`relative grid h-8 w-8 place-items-center rounded-full transition-colors ${extra} ${
        active ? "text-white" : "text-white/70 hover:text-white"
      }`}
    >
      {children}
      {/* Spotify's selected treatment for the right-cluster toggles: full
          white icon plus a small dot beneath — no highlight circle. */}
      {active && (
        <span className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white" />
      )}
    </button>
  );
}

/* Sleep timer — a moon in the right cluster; its menu hangs above it. While a
   timer runs the moon carries the active dot and the time left beside it. */
function SleepTimerButton() {
  const endsAt = useSleepTimer((s) => s.endsAt);
  const endOfSong = useSleepTimer((s) => s.endOfSong);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (endsAt == null) return;
    setNow(performance.now());
    const id = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  const left = endsAt != null ? formatSleepLeft(endsAt - now) : null;
  const status = endOfSong ? "Stops after this song" : left ? `Stops in ${left}` : null;

  const open = (): void => {
    const ui = useUI.getState();
    const sleep = useSleepTimer.getState();
    const start = (minutes: number, label: string): void => {
      sleep.start(minutes);
      ui.toast(`Music stops in ${label}`, "info");
    };
    const preset = (minutes: number, label: string): MenuItem => ({ label, action: () => start(minutes, label) });
    const items: MenuItem[] = [
      { label: status ?? "Sleep timer", header: true },
      preset(5, "5 minutes"),
      preset(15, "15 minutes"),
      preset(30, "30 minutes"),
      preset(45, "45 minutes"),
      preset(60, "1 hour"),
      preset(120, "2 hours"),
      {
        label: "End of this song",
        action: () => {
          sleep.startEndOfSong();
          ui.toast("Music stops after this song", "info");
        },
      },
      {
        label: "Custom",
        action: () =>
          ui.openDialog({
            title: "Sleep timer",
            body: "Stop the music after how long? Minutes, or hours and minutes like 1:30 — up to 12 hours.",
            initialValue: "60",
            placeholder: "Minutes",
            confirmLabel: "Start",
            onConfirm: (value) => {
              const minutes = parseSleepMinutes(value);
              if (minutes == null || minutes < 1 || minutes > SLEEP_MAX_MINUTES) {
                useUI.getState().toast("Enter a time from 1 minute to 12 hours", "error");
                return;
              }
              start(minutes, formatSleepLeft(minutes * 60_000));
            },
          }),
      },
    ];
    if (status) items.push({ label: "Turn off", separatorBefore: true, action: () => sleep.cancel() });
    const rect = anchorRef.current?.getBoundingClientRect();
    ui.openContextMenu(rect?.left ?? window.innerWidth / 2, rect?.top ?? window.innerHeight / 2, items, { above: true });
  };

  return (
    <span ref={anchorRef} className="flex items-center">
      <BarButton onClick={open} title={status ? `Sleep timer: ${status.toLowerCase()}` : "Sleep timer"} active={!!status} menu>
        <Moon size={16} strokeWidth={2} />
      </BarButton>
      {left && <span className="-ml-0.5 mr-1 text-[11px] tabular-nums text-white/70">{left}</span>}
    </span>
  );
}

export function PlayerBar() {
  const track = usePlayer(shownTrack);
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  const cycleRepeat = usePlayer((s) => s.cycleRepeat);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);

  const liked = useLibrary((s) => (track ? s.liked.some((t) => t.id === track.id) : false));
  const hideVolumeBar = useSettings((s) => s.hideVolumeBar);
  const coverDrag = useDrag({ track: track ?? { id: "", title: "", artist: "", duration: 0, thumb: "" } });

  /** The "+" beside the track — two top-level options: liked, and the
      playlists flyout (hover → every playlist + "New playlist"), so a big
      playlist library never floods the first click. */
  const addToPlaylistRef = useRef<HTMLButtonElement | null>(null);
  const openAddToPlaylist = (): void => {
    if (!track) return;
    // Real toggle: when the picker is already open, this click closes it.
    // (The pointerdown handler on the button below keeps the open menu alive
    // until the click arrives — otherwise the menu's outside-press dismissal
    // fired first and every press on "+" re-opened it, never closing it.)
    if (useUI.getState().contextMenu) {
      useUI.getState().closeContextMenu();
      return;
    }
    const lib = useLibrary.getState();
    const items: MenuItem[] = [
      {
        label: liked ? "Remove from Liked Songs" : "Add to Liked Songs",
        icon: Heart,
        action: () => lib.toggleLike(track),
      },
      {
        label: "Add to playlist",
        icon: ListMusic,
        children: [
          // Each playlist on or off: checked when it holds the song, and choosing it adds or removes.
          ...lib.playlists.map((p): MenuItem => {
            const inList = p.tracks.some((t) => t.id === track.id);
            return {
              label: p.name,
              checked: inList,
              toggle: true,
              action: () => {
                if (inList) {
                  useLibrary.getState().removeFromPlaylist(p.id, track.id);
                  useUI.getState().toast(`Removed from "${p.name}"`);
                } else {
                  const { added, told } = addSongsToPlaylists([p.id], [track]);
                  if (!told) useUI.getState().toast(added ? `Added to "${p.name}"` : "Already in this playlist");
                }
              },
            };
          }),
          {
            separatorBefore: lib.playlists.length > 0,
            label: "New playlist",
            icon: ListPlus,
            action: () => {
              // Name it before it exists — cancel adds nothing. Blank
              // confirm keeps the numbered default.
              const suggested = `Playlist ${useLibrary.getState().playlists.length + 1}`;
              useUI.getState().openDialog({
                title: "New playlist",
                body: `Add "${shortTitle(track.title)}" to a new playlist.`,
                initialValue: suggested,
                placeholder: "Playlist name",
                confirmLabel: "Create",
                onConfirm: (value) => {
                  const playlist = newPlaylistWith(value.trim() || suggested, [track]);
                  useUI.getState().navigate({ name: "playlist", param: playlist.id });
                },
              });
            },
          },
        ],
      },
      { subject: { title: track.title, subtitle: track.artist, thumb: track.thumb } },
    ];
    const rect = addToPlaylistRef.current?.getBoundingClientRect();
    // The playbar hugs the window bottom — the menu hangs ABOVE the button.
    useUI
      .getState()
      .openContextMenu(rect?.left ?? window.innerWidth / 2, rect?.top ?? window.innerHeight / 2, items, {
        above: true,
      });
  };

  const lyricsCenter = useUI((s) => s.lyricsCenter);
  const rightPanel = useUI((s) => s.rightPanel);
  const nowPlayingOpen = useUI((s) => s.nowPlayingOpen);
  const toggleLyrics = useUI((s) => s.toggleLyrics);
  const toggleQueue = useUI((s) => s.toggleQueue);
  const toggleRoom = useUI((s) => s.toggleRoom);
  const roomCode = useRoom((s) => s.view.state?.code ?? null);
  const toggleNowPlaying = useUI((s) => s.toggleNowPlaying);

  // The miniplayer is a separate native always-on-top window (see
  // electron/pip.ts); this button just toggles it and mirrors its state.
  const [pipOpen, setPipOpen] = useState(false);
  useEffect(() => {
    const bridge = window.bytune;
    if (!bridge?.pipToggle) return;
    void bridge.pipIsOpen?.().then((open) => setPipOpen(!!open));
    const off = bridge.onPipOpenChange?.((open) => setPipOpen(open));
    return off;
  }, []);
  const toggleMiniPlayer = (): void => void window.bytune?.pipToggle();

  const VolIcon = muted || volume === 0 ? SpVolumeOff : SpVolumeHigh;

  return (
    <footer className="shrink-0 z-30 bg-black px-2">
      <div
        className="h-[88px] grid grid-cols-[3fr_4fr_3fr] items-center"
        role="contentinfo"
        aria-label="Now playing bar"
      >
        {/* Track info — click opens the Now Playing view. */}
        <div className="flex items-center min-w-0 pl-2">
          <button
            onClick={toggleNowPlaying}
            {...(track ? coverDrag.props : {})}
            title="Now playing view — drag to a playlist to add this song"
            aria-label="Now playing view"
            className={`h-14 w-14 shrink-0 overflow-hidden rounded-[4px] bg-[#282828] focus:outline-none ${
              track && coverDrag.dragging ? "opacity-50" : ""
            }`}
          >
            {track?.thumb ? (
              <img
                key={track.id}
                src={upgradeArtwork(track.thumb)}
                alt=""
                className="h-full w-full object-cover animate-art-in"
              />
            ) : (
              <div className="grid h-full w-full place-items-center">
                <SpCoverNote />
              </div>
            )}
          </button>
          <div className="ml-2.5 min-w-0">
            <button onClick={toggleNowPlaying} className="block w-full text-left animate-meta-in" key={track ? `meta-${track.id}` : "meta-none"}>
              <span className="block min-w-0 px-1.5 -mx-1.5 text-[14px] leading-[19px] text-white hover:underline">
                <FitText mode="auto" followsPlayback text={track ? shortTitle(track.title) : "Nothing playing"} full={track?.title} />
              </span>
              <span className="block min-w-0 px-1.5 -mx-1.5 text-[12px] leading-[17px] text-[#b3b3b3] hover:underline">
                <FitText mode="auto" followsPlayback text={track ? track.artist : "Search for something to play"} />
              </span>
            </button>
          </div>
          {track && (
            <button
              ref={addToPlaylistRef}
              onPointerDown={(e) => {
                // Keep the context menu's outside-press dismissal from
                // closing an open picker on this press — the click handler
                // then sees the open menu and toggles it closed instead.
                e.stopPropagation();
              }}
              onClick={(e) => {
                // The opening click must not bubble to the ContextMenu's
                // click-outside listener, or it closes itself immediately.
                e.stopPropagation();
                openAddToPlaylist();
              }}
              title="Add to playlist"
              aria-label="Add to playlist"
              aria-haspopup="menu"
              className="ml-4 flex h-8 w-4 shrink-0 items-center justify-center text-[#b3b3b3] transition-all hover:scale-105 hover:text-white active:scale-95"
            >
              {/* Spotify's model: the glyph reflects Liked state, the click
                  always opens the add-to-playlist picker. */}
              {liked ? <SpCheck /> : <SpPlus />}
            </button>
          )}
        </div>

        {/* Centre — [shuffle prev] play [next repeat], disc dead centre. */}
        <div className="flex h-14 flex-col justify-center gap-2">
          <div className="flex w-full items-center gap-4">
            <div className="flex flex-1 items-center justify-end gap-2">
              <TransportButton onClick={toggleShuffle} active={shuffle} title={shuffle ? "Disable Shuffle" : "Enable Shuffle"}>
                <SpShuffle />
              </TransportButton>
              <TransportButton onClick={() => prev()} title="Previous">
                <SpPrev />
              </TransportButton>
            </div>
            <button
              onClick={toggle}
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-black transition-transform hover:scale-[1.06] active:scale-95"
            >
              {buffering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : playing ? (
                <SpPause />
              ) : (
                <SpPlay />
              )}
            </button>
            <div className="flex flex-1 items-center gap-2">
              <TransportButton onClick={() => next(true)} title="Next">
                <SpNext />
              </TransportButton>
              <TransportButton
                onClick={cycleRepeat}
                active={repeat !== "off"}
                title={repeat === "off" ? "Enable repeat" : repeat === "all" ? "Disable repeat" : "Enable repeat one"}
              >
                {repeat === "one" ? <SpRepeatOne /> : <SpRepeat />}
              </TransportButton>
            </div>
          </div>
          <SeekBar thin />
        </div>

        {/* Right — lyrics, queue, volume, miniplayer, fullscreen. */}
        <div className="flex items-center justify-end">
          <SleepTimerButton />
          <BarButton onClick={toggleLyrics} title="Lyrics" active={lyricsCenter}>
            <SpLyrics />
          </BarButton>
          <BarButton onClick={toggleQueue} title="Queue" active={rightPanel === "queue"}>
            <SpQueue />
          </BarButton>
          {/* In a room the button stays lit, as the sleep timer's moon does while it runs. */}
{ROOMS && (
          <BarButton onClick={toggleRoom} title={roomCode ? `Room ${roomCode}` : "Room"} active={rightPanel === "room" || !!roomCode}>
            <Users size={16} strokeWidth={2} />
          </BarButton>
          )}
          {!hideVolumeBar && <VolumeControl VolIcon={VolIcon} />}
          <BarButton
            onClick={toggleMiniPlayer}
            active={pipOpen}
            title={pipOpen ? "Close Miniplayer" : "Open Miniplayer"}
            className="ml-2"
          >
            <SpMiniplayer />
          </BarButton>
          <BarButton
            onClick={toggleNowPlaying}
            title={nowPlayingOpen ? "Exit Full screen" : "Enter Full screen"}
          >
            {nowPlayingOpen ? <SpExitFullscreen /> : <SpFullscreen />}
          </BarButton>
        </div>
      </div>
    </footer>
  );
}
