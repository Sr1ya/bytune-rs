/**
 * Settings: how ByTune plays, sounds and keeps your library.
 *
 * Composition: a rail of categories on the left, where the sidebar's open-row light marks the one
 * you're in and slides as you move; one category at a time on the right, its title and one line,
 * then groups of rows in quiet cards. A row is a glyph tile, the setting and what it does, and its
 * control: a switch, a picker, buttons, or under the text a slider or a choice whose thumb slides.
 * Searching shows every category's matches at once. The colour comes from the music, as everywhere
 * in ByTune: the page sits over the playing song's glow, the account card is made of your own
 * covers, and the equalizer draws its curve live. Styles: index.css, "settings".
 *
 * The category lives in the view's param, swapped in place (useUI.replaceView): Back and the profile
 * button leave Settings in one step, coming back from a page opened here lands on the category you
 * left, and a fresh open lands on Account.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ACCOUNTS, SPOTIFY_CONNECT } from "../lib/features";
import {
  Activity,
  AppWindow,
  AudioLines,
  BarChart3,
  ChevronRight,
  ChevronsUpDown,
  CirclePlay,
  Clapperboard,
  CloudDownload,
  CloudUpload,
  Database,
  Download,
  Droplets,
  ExternalLink,
  FileDown,
  FileMusic,
  FileUp,
  Filter,
  FolderDown,
  FolderOpen,
  FolderPlus,
  Gauge,
  Globe,
  Image,
  Infinity as InfinityIcon,
  Info,
  Languages,
  Library,
  ListMusic,
  LogOut,
  Maximize2,
  MicVocal,
  Palette,
  PanelBottom,
  RefreshCw,
  Repeat2,
  Search,
  SlidersHorizontal,
  SlidersVertical,
  Sparkles,
  Speaker,
  Timer,
  Trash2,
  UserRound,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from "lucide-react";
import { DOWNLOAD_QUALITY_LABEL, LOUDNESS_LABEL, STREAM_QUALITY_LABEL, useSettings } from "../stores/settings";
import { isMac } from "../lib/platform";
import { useLibrary } from "../stores/library";
import { shownName, useSession } from "../lib/session";
import { displayNameProblem, normalizeDisplayName } from "../lib/account-validators";
import { askToDisconnectSpotify, connectSpotify, useSpotify } from "../lib/spotify";
import { useUpdates } from "../lib/updates";
import { SpotifyIcon } from "../components/SpotifyIcon";
import { MATCH_LANGUAGES, type MatchLanguage } from "../shared/track-match";
import { LYRICS_NUDGE_STEP, describeLyricsShift } from "../lib/lyricsOffset";
import { setOnboardingIntent } from "../lib/onboardingIntent";
import { GuestDeleteModal } from "../components/AccountModals";
import { Switch } from "../components/primitives";
import { useUI, type MenuItem } from "../stores/ui";
import { EQ_BANDS, listOutputDevices } from "../lib/audio";
import type { OutputDeviceChoice } from "../lib/audio-output";
import { avatarFor } from "../lib/avatar";
import { wallCovers } from "../lib/collection";
import { upgradeArtwork } from "../lib/artwork";
import { EQ_RANGE, eqY } from "../lib/eqScale";
import brandLogo from "../assets/brand/bytune-logo.svg";
import brandText from "../assets/brand/bytune-Text.svg";

type Glyph = React.ComponentType<{ className?: string }>;

/* ============================================================ categories */

const CATEGORIES = [
  { id: "account", label: "Account", icon: UserRound, lede: "Your name, your backup and the services you've connected" },
  { id: "playback", label: "Playback", icon: CirclePlay, lede: "How songs start, end and follow each other" },
  { id: "sound", label: "Sound", icon: AudioLines, lede: "Quality, loudness, where it plays and how it's shaped" },
  { id: "lyrics", label: "Lyrics", icon: MicVocal, lede: "How lyrics follow the song" },
  { id: "display", label: "Display", icon: Palette, lede: "Motion, glass and how covers show" },
  { id: "library", label: "Library", icon: Library, lede: "Your music folders and downloads" },
  { id: "data", label: "Your data", icon: Database, lede: "Your listening, your backups and a fresh start" },
  { id: "about", label: "About", icon: Info, lede: "The version you're running and where ByTune lives" },
] as const;
type CategoryId = (typeof CATEGORIES)[number]["id"];

const isCategory = (id: string | undefined): id is CategoryId => CATEGORIES.some((c) => c.id === id);
const indexOf = (id: CategoryId): number => CATEGORIES.findIndex((c) => c.id === id);

/* ============================================================ the pieces */

/** A group of rows in a card: a short title over it, a note under it. The search reads data-setting-*. */
function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section data-setting-group className="st-group">
      {title && (
        <h3 data-setting-header className="st-group-title">
          {title}
        </h3>
      )}
      <div className="st-card">{children}</div>
      {note && <p className="st-note">{note}</p>}
    </section>
  );
}

/**
 * One setting: a glyph tile, its name and what it does, and its control on the right.
 * - `toggle`: a switch; the whole row flips it (the switch is what the keyboard reaches).
 * - `onClick`: the row itself is the control (a page, a picker, a folder dialog), reachable by Tab
 *   and pressed with Enter or Space.
 * - `children` sit under the text, in its column (a slider, a choice); `wide` spans the whole row.
 */
function Row({
  icon: Icon,
  title,
  note,
  badge,
  toggle,
  onClick,
  onPointerDown,
  control,
  children,
  wide,
  disabled,
  danger,
}: {
  icon: Glyph;
  title: string;
  note?: ReactNode;
  badge?: string;
  toggle?: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean };
  onClick?: (row: HTMLElement) => void;
  /** pickers keep an open menu alive until the click, so the same row closes it again */
  onPointerDown?: (e: React.PointerEvent) => void;
  control?: ReactNode;
  children?: ReactNode;
  wide?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  const off = disabled || toggle?.disabled;
  const press = onClick && !disabled ? onClick : undefined;
  const flip = toggle && !off ? () => toggle.onChange(!toggle.checked) : undefined;
  const stop = (e: React.MouseEvent): void => e.stopPropagation();
  return (
    <div
      data-setting-row
      role={press ? "button" : undefined}
      tabIndex={press ? 0 : undefined}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onClick={press ? (e) => press(e.currentTarget) : flip}
      onKeyDown={
        press
          ? (e) => {
              if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                e.preventDefault();
                press(e.currentTarget);
              }
            }
          : undefined
      }
      className={`st-row${press || flip ? " is-action" : ""}${off ? " is-off" : ""}${danger ? " is-danger" : ""}`}
    >
      <span className="st-row-icon" aria-hidden>
        <Icon className="w-[18px] h-[18px]" />
      </span>
      <div className="st-row-text">
        <div className="st-row-title">
          <span className="truncate">{title}</span>
          {badge && <span className="st-badge">{badge}</span>}
        </div>
        {note && <div className="st-row-note">{note}</div>}
      </div>
      {(control || toggle) && (
        <div className="st-row-control">
          {control}
          {toggle && <Switch checked={toggle.checked} onChange={toggle.onChange} disabled={off} label={title} />}
        </div>
      )}
      {children && (
        <div className="st-row-body" onClick={stop}>
          {children}
        </div>
      )}
      {wide && (
        <div className="st-row-wide" onClick={stop}>
          {wide}
        </div>
      )}
    </div>
  );
}

/** A small button: plain, the page's one white one, or a danger one. */
function Button({
  kind = "plain",
  children,
  onClick,
  disabled,
}: {
  kind?: "plain" | "primary" | "danger";
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`st-btn${kind === "primary" ? " is-primary" : kind === "danger" ? " is-danger" : ""}`}
    >
      {children}
    </button>
  );
}

/** A picker's current value, with the up-down chevrons that say it opens a list. */
function Pick({ children }: { children: ReactNode }) {
  return (
    <span className="st-pick">
      <span className="truncate">{children}</span>
      <ChevronsUpDown className="w-4 h-4 shrink-0" />
    </span>
  );
}

/** A few options side by side; the thumb slides to the one picked. Arrow keys move along it. */
function Choice<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}) {
  const at = Math.max(0, options.indexOf(value));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const go = (k: number): void => {
    const to = (k + options.length) % options.length;
    onChange(options[to]);
    refs.current[to]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="st-choice" style={{ ["--n" as string]: options.length, ["--i" as string]: at } as CSSProperties}>
      <span aria-hidden className="st-choice-thumb" />
      {options.map((o, k) => (
        <button
          key={o}
          ref={(el) => {
            refs.current[k] = el;
          }}
          type="button"
          role="radio"
          aria-checked={k === at}
          tabIndex={k === at ? 0 : -1}
          onClick={() => onChange(o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              go(k + 1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              go(k - 1);
            }
          }}
          className="st-choice-option"
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

/** Thumb width of the .slider CSS: the fill ends exactly at the thumb's centre (the native input
    insets the thumb by half its width at both ends of the range). */
const SLIDER_THUMB_PX = 13;

/** A slider under a row's text: the stops it rests on ruled under the bar (one every `step`, taller
    every `major`, tallest at `origin`, the one it's on lit), then what its two ends mean. The bar fills
    from `origin` to the thumb: the low end, or the middle of a two-sided slider. */
function Range({
  label,
  valueText,
  min,
  max,
  step,
  value,
  onChange,
  ends,
  disabled,
  origin = min,
  major,
}: {
  label: string;
  valueText: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  ends: [string, string];
  disabled?: boolean;
  origin?: number;
  major: number;
}) {
  // A value's place on the bar: where the native thumb's centre is, half a thumb in from either end.
  const at = (v: number): string => {
    const f = max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
    return `calc((100% - ${SLIDER_THUMB_PX}px) * ${f} + ${SLIDER_THUMB_PX / 2}px)`;
  };
  const lo = Math.min(origin, value);
  const near = (a: number, b: number): boolean => Math.abs(a - b) < step / 2;
  const stops = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, k) => Math.round((min + k * step) * 1000) / 1000);
  const kind = (v: number): string =>
    near(v, origin) ? "is-origin" : Math.abs(v / major - Math.round(v / major)) < 1e-6 ? "is-major" : "";
  return (
    <div className="st-range">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={valueText}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider slider-dot"
        style={{ "--from": lo <= min ? "0%" : at(lo), "--fill": at(Math.max(origin, value)) } as CSSProperties}
      />
      <div className="st-range-marks" aria-hidden>
        {stops.map((v) => (
          <i key={v} className={`${kind(v)}${near(v, value) ? " is-on" : ""}`.trim() || undefined} style={{ left: at(v) }} />
        ))}
      </div>
      <div className="st-range-ends" aria-hidden>
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
      </div>
    </div>
  );
}

/** A slider's reading beside its row's title, always as wide as its widest values (`widest`), so the
    text next to it never re-wraps, and the row never changes height, while the slider moves. */
function Reading({ text, widest }: { text: string; widest: string[] }) {
  return (
    <span className="st-reading">
      {widest.map((w) => (
        <span key={w} aria-hidden className="st-value st-reading-size">
          {w}
        </span>
      ))}
      <span className="st-value">{text}</span>
    </span>
  );
}

/** The list for a picker: one choice per option, the current one checked; picking one commits it. */
function choiceMenu<T extends string>(order: readonly T[], labels: Record<T, string>, current: T, onPick: (q: T) => void): MenuItem[] {
  return order.map((q) => ({
    label: labels[q],
    checked: q === current,
    action: () => onPick(q),
  }));
}

/** Where a picker's list opens: right-aligned under its value. */
function menuAnchor(row: HTMLElement): DOMRect {
  return (row.querySelector<HTMLElement>(".st-pick") ?? row).getBoundingClientRect();
}

/** Opens a picker's list, or closes it when one is already open. Same contract as the playbar "+":
    the row's pointerdown keeps an open menu alive until this click, so the click itself can close it. */
function toggleMenuAt(row: HTMLElement, items: MenuItem[]): void {
  const ui = useUI.getState();
  if (ui.contextMenu) {
    ui.closeContextMenu();
    return;
  }
  const rect = menuAnchor(row);
  ui.openContextMenu(rect.right, rect.bottom + 6, items, { alignRight: true });
}
const keepMenu = (e: React.PointerEvent): void => e.stopPropagation();

/* ============================================================ account */

type SyncState = "idle" | "syncing" | "pending" | "error";

/**
 * ByTune account: the cloud layer above the YouTube cookie. Guests keep everything local; signed-in
 * users get automatic cloud backup of library, playlists, history and settings. Backups always run on
 * top of the local copy: restoring never deletes anything without writing a local backup first
 * (userData/data/backups).
 */
function AccountPane() {
  const toast = useUI((st) => st.toast);
  const openDialog = useUI((st) => st.openDialog);
  const session = useSession();
  const [status, setStatus] = useState<{ lastSyncAt: number | null; state: SyncState; lastError: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the sync line honest: poll while mounted (cheap local IPC), and after every mode change.
  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      void window.bytune
        ?.syncStatus()
        .then((st) => {
          if (cancelled) return;
          const s = st as { lastSyncAt: number | null; state?: string; lastError?: string | null } | undefined;
          setStatus({
            lastSyncAt: s?.lastSyncAt ?? null,
            state: (s?.state as SyncState) ?? "idle",
            lastError: s?.lastError ?? null,
          });
        })
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [session.mode]);

  const run = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      toast(done, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Sync failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const signOutWithConfirm = (): void => {
    openDialog({
      title: "Sign out of ByTune?",
      body: "Your account data is safely backed up to the cloud. You can sign in again any time to restore it.",
      confirmLabel: "Sign out",
      cancelLabel: "Cancel",
      onConfirm: () => void run(async () => { await window.bytune?.authSignOut(); }, "Signed out"),
    });
  };

  const changeUsername = (): void => {
    openDialog({
      title: "Change username",
      body: "Letters, numbers, _ and @. The new name must not already be taken.",
      initialValue: session.username ?? "",
      confirmLabel: "Rename",
      onConfirm: (value) => {
        const next = value.trim();
        if (!next || next === session.username) return;
        void run(async () => {
          await window.bytune?.authSetUsername(next);
          await useSession.getState().refresh();
        }, `Username changed to ${next}`);
      },
    });
  };

  const changeDisplayName = (): void => {
    openDialog({
      title: session.displayName ? "Change display name" : "Add a display name",
      body:
        session.mode === "account"
          ? "What people see in rooms and around ByTune. Up to 30 characters."
          : "Shown around ByTune on this PC. Up to 30 characters.",
      initialValue: session.displayName ?? "",
      placeholder: "Display name",
      confirmLabel: "Save",
      onConfirm: (value) => {
        if (normalizeDisplayName(value) === session.displayName) return;
        const problem = displayNameProblem(value);
        if (problem) {
          toast(problem, "error");
          return;
        }
        void run(async () => {
          await window.bytune?.authSetDisplayName(value);
          await useSession.getState().refresh();
        }, "Display name saved");
      },
    });
  };

  // Guests upgrade by re-running onboarding; their local data stays and merges into the account on
  // the first sync.
  const join = async (): Promise<void> => {
    if (session.mode === "guest") {
      try {
        await window.bytune?.authClearGuestProfile();
      } catch {
        toast("Couldn't open onboarding. Try again.", "error");
        return;
      }
    }
    void useSession.getState().refresh();
  };

  const signedIn = session.mode === "account";
  const sync: { text: string; tone: "good" | "busy" | "bad" | "local" } = !session.loaded
    ? { text: "…", tone: "local" }
    : signedIn
      ? status?.state === "syncing"
        ? { text: "Syncing…", tone: "busy" }
        : status?.state === "error"
          ? { text: "Sync error, will retry", tone: "bad" }
          : status?.state === "pending"
            ? { text: "Pending changes", tone: "busy" }
            : status?.lastSyncAt
              ? { text: `Synced ${new Date(status.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, tone: "good" }
              : { text: "Signed in, backing up automatically", tone: "good" }
      : session.mode === "guest"
        ? { text: "Your data is stored only on this device", tone: "local" }
        : { text: "Not signed in", tone: "local" };

  return (
    <>
      <IdentityCard sync={sync} onEditName={changeDisplayName} onChangeUsername={changeUsername} />
      {signedIn ? (
        <Group title="Backup">
          <Row
            icon={CloudUpload}
            title="Cloud backup"
            note="On. Changes upload within seconds"
            control={
              <Button disabled={busy} onClick={() => void run(async () => { await window.bytune?.syncBackupNow(); }, "Backup complete")}>
                Back up now
              </Button>
            }
          />
          <Row
            icon={CloudDownload}
            title="Restore from the cloud"
            note="Replaces this device's copy with the cloud's. A local backup is kept first"
            control={
              <Button disabled={busy} onClick={() => void run(async () => { await window.bytune?.syncRestoreNow(); }, "Restored from cloud")}>
                Restore
              </Button>
            }
          />
        </Group>
      ) : ACCOUNTS && (
        <Group title="Backup">
          <Row
            icon={CloudUpload}
            title="Back up your library"
            note="With an account it stays safe even if this PC's app data is wiped"
            control={
              <Button kind="primary" onClick={() => void join()}>
                {session.mode === "guest" ? "Create account or sign in" : "Sign in or create account"}
              </Button>
            }
          />
        </Group>
      )}
      <ConnectedServices />
      {signedIn && (
        <Group title="Session">
          <Row
            icon={LogOut}
            title="Sign out"
            note="Your library stays backed up, ready for when you sign in again"
            control={
              <Button kind="danger" disabled={busy} onClick={signOutWithConfirm}>
                Sign out
              </Button>
            }
          />
        </Group>
      )}
    </>
  );
}

/**
 * Who you are, at the top of Settings: the avatar from the top bar's profile button, your name and
 * how your backup stands, over a slow wall of your own covers (the collection pages' wall, small).
 */
function IdentityCard({
  sync,
  onEditName,
  onChangeUsername,
}: {
  sync: { text: string; tone: "good" | "busy" | "bad" | "local" };
  onEditName: () => void;
  onChangeUsername: () => void;
}) {
  const session = useSession();
  const liked = useLibrary((s) => s.liked);
  const history = useLibrary((s) => s.history);
  const covers = useMemo(() => wallCovers([...liked, ...history].map((t) => upgradeArtwork(t.thumb)), 36), [liked, history]);
  const signedIn = session.mode === "account";
  const shown = shownName(session);
  const name = shown ?? (signedIn ? "Account" : session.mode === "guest" ? "Guest" : "No account");
  const { color, letter } = avatarFor(session.mode, session.username, shown);
  return (
    <section data-setting-group className="st-group">
      <div data-setting-row className="st-id">
        {covers.length > 0 && (
          <div aria-hidden className="st-id-wall">
            {[0, 1, 2].map((r) => {
              const row = covers.slice(r * 12, r * 12 + 12);
              return (
                <div
                  key={r}
                  className="st-id-wall-row"
                  style={{ animationDuration: `${110 + r * 30}s`, animationDirection: r % 2 ? "reverse" : "normal" }}
                >
                  {[...row, ...row].map((src, i) => (
                    <span key={i} className="st-id-tile" style={{ backgroundImage: `url(${JSON.stringify(src)})` }} />
                  ))}
                </div>
              );
            })}
          </div>
        )}
        <span aria-hidden className="st-id-avatar" style={{ backgroundColor: color }}>
          {letter}
        </span>
        <div className="st-id-text">
          <div className="st-id-name">
            <span className="truncate">{name}</span>
            {/* A guest with a name of their own says they're a guest; one without is already called "Guest". */}
            {session.mode === "guest" && shown && <span className="st-badge">Guest</span>}
          </div>
          {/* The username shows here only: everywhere else it's the display name. */}
          {signedIn && <div className="st-id-user">@{session.username ?? ""}</div>}
          <div className={`st-id-sync is-${sync.tone}`}>{sync.text}</div>
        </div>
        <div className="st-id-actions">
          {session.mode && <Button onClick={onEditName}>{session.displayName ? "Edit name" : "Add name"}</Button>}
          {signedIn && <Button onClick={onChangeUsername}>Change username</Button>}
        </div>
      </div>
    </section>
  );
}

const MATCH_LANGUAGE_LABEL: Record<MatchLanguage | "", string> = {
  "": "Any",
  telugu: "Telugu",
  tamil: "Tamil",
  hindi: "Hindi",
  kannada: "Kannada",
  malayalam: "Malayalam",
  english: "English",
};

/**
 * Connect Spotify: the listener's own Spotify playlists and Liked Songs in the sidebar, matched to
 * YouTube Music. The session stays in main (electron/spotify.ts), sealed, never uploaded. The language
 * row applies to every import too.
 */
function ConnectedServices() {
  const status = useSpotify((s) => s.status);
  const connecting = useSpotify((s) => s.connecting);
  const language = useSettings((s) => s.matchLanguage);
  const connect = (): void => void connectSpotify();
  return (
    <Group
      title="Connected services"
      note="Connecting signs in to Spotify in a window of its own. ByTune keeps that session on this computer for this ByTune account, encrypted, and never uploads it. It reads your playlists the way Spotify's web player does, which isn't an official Spotify feature: it may stop working, and it isn't allowed by Spotify's terms. Songs are found on YouTube Music to play."
    >
      {SPOTIFY_CONNECT && (
      <Row
        icon={SpotifyIcon}
        title="Spotify"
        note={
          status.connected
            ? status.problem ?? (status.name ? `Connected as ${status.name}` : "Connected")
            : connecting
              ? "Finish signing in in the Spotify window"
              : "Your playlists and Liked Songs, in your library"
        }
        control={
          status.connected ? (
            <>
              {status.problem && <Button onClick={connect}>Reconnect</Button>}
              <Button onClick={askToDisconnectSpotify}>Disconnect</Button>
            </>
          ) : (
            <Button kind="primary" onClick={connect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          )
        }
      />
      )}
      <Row
        icon={Languages}
        title="Song versions"
        note="When a song has versions in several languages, imports and Spotify playlists pick this one"
        control={<Pick>{MATCH_LANGUAGE_LABEL[language]}</Pick>}
        onPointerDown={keepMenu}
        onClick={(row) =>
          toggleMenuAt(
            row,
            choiceMenu(["", ...MATCH_LANGUAGES] as (MatchLanguage | "")[], MATCH_LANGUAGE_LABEL, language, (l) =>
              useSettings.getState().setMatchLanguage(l)
            )
          )
        }
      />
    </Group>
  );
}

/* ============================================================ playback */

function PlaybackPane() {
  const s = useSettings();
  // At 0 the crossfade is also the Automix blend length, so it stays visible: Automix picks 6s then.
  const fade = s.crossfadeSeconds === 0 ? (s.smartFade ? "Auto" : "Off") : `${s.crossfadeSeconds}s`;
  const speed = `${s.playbackSpeed.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}x`;
  return (
    <>
      <Group title="Transitions">
        <Row icon={Activity} title="Crossfade" note="Blend the end of one track into the next" control={<Reading text={fade} widest={["Auto", "12s"]} />}>
          <Range
            label="Crossfade"
            valueText={fade}
            min={0}
            max={12}
            step={1}
            value={s.crossfadeSeconds}
            onChange={s.setCrossfadeSeconds}
            ends={[s.smartFade ? "Auto" : "Off", "12s"]}
            major={3}
          />
        </Row>
        <Row
          icon={Sparkles}
          title="Automix"
          note={s.smartFade ? "Blends where the music really ends and lines up beats when tempos match" : "Off: blends use the crossfade length above"}
          toggle={{ checked: s.smartFade, onChange: s.setSmartFade }}
        />
        <Row
          icon={VolumeX}
          title="Skip silence"
          note="Skip the silence at the start and end of songs"
          toggle={{ checked: s.skipSilence, onChange: s.setSkipSilence }}
        />
      </Group>
      <Group title="Suggestions">
        <Row
          icon={InfinityIcon}
          title="Autoplay"
          note="When your songs run out, keep playing music like them"
          toggle={{ checked: s.autoplay, onChange: s.setAutoplay }}
        />
        <Row
          icon={Repeat2}
          title="Don't repeat suggestions"
          note="Keep recently played tracks out of the home feed"
          toggle={{ checked: s.dontRepeatSuggestions, onChange: s.setDontRepeatSuggestions }}
        />
      </Group>
      <Group title="Speed">
        <Row icon={Gauge} title="Playback speed" note="Pitch-preserving tempo for everything you play" control={<Reading text={speed} widest={["1.75x"]} />}>
          <Range
            label="Playback speed"
            valueText={speed}
            min={0.5}
            max={2}
            step={0.05}
            value={s.playbackSpeed}
            onChange={s.setPlaybackSpeed}
            ends={["0.5x", "2x"]}
            origin={1}
            major={0.25}
          />
        </Row>
      </Group>
      {/* Not macOS: it always keeps the app running (and playing) with the window closed, and the Dock brings it back. */}
      {!isMac && (
        <Group title="Background">
          <Row
            icon={PanelBottom}
            title="Close to tray"
            note="Closing the window keeps the music playing; open or quit from the tray icon"
            toggle={{ checked: s.closeToTray, onChange: s.setCloseToTray }}
          />
        </Group>
      )}
    </>
  );
}

/* ============================================================ sound */

function SoundPane() {
  const s = useSettings();
  return (
    <>
      <Group title="Streaming">
        <Row icon={Wifi} title="Streaming quality" note="The highest quality ByTune streams">
          <Choice
            label="Streaming quality"
            value={s.streamingQuality}
            options={["low", "medium", "high", "lossless"] as const}
            labels={STREAM_QUALITY_LABEL}
            onChange={s.setStreamingQuality}
          />
        </Row>
      </Group>
      <Group title="Loudness">
        <Row icon={Volume2} title="Volume leveling" note="Bring every song to a similar loudness">
          <Choice
            label="Volume leveling"
            value={s.loudnessLevel}
            options={["off", "quiet", "normal", "loud"] as const}
            labels={LOUDNESS_LABEL}
            onChange={s.setLoudnessLevel}
          />
        </Row>
      </Group>
      <OutputDevice />
      <Group title="Equalizer">
        <Equalizer />
      </Group>
    </>
  );
}

/**
 * Output device: routes playback to a specific speaker or headset via setSinkId. Chromium hides device
 * labels until the page has held capture permission once, so the first menu open asks for it on
 * explicit intent; failure degrades to generic "Speaker N" names.
 */
function OutputDevice() {
  const sinkId = useSettings((st) => st.audioSinkId);
  const [devices, setDevices] = useState<OutputDeviceChoice[] | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void listOutputDevices().then((list) => {
        if (alive) setDevices(list);
      });
    };
    refresh();
    // Plugging or unplugging a device must update the row and the menu live.
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    md?.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      md?.removeEventListener?.("devicechange", refresh);
    };
  }, []);
  const current = devices?.find((d) => d.deviceId === sinkId);
  // Where sound is going right now: the pinned device, or, when following the system default,
  // whichever physical endpoint the OS currently routes "default" to. Resolving this is what makes
  // the row move when Windows hands the default to a newly connected headset.
  const active = devices?.find((d) => d.deviceId !== "" && d.activeDefault);
  const value = sinkId ? (current?.label ?? "System default") : active ? active.label : "System default";
  const itemsFor = (list: OutputDeviceChoice[]): MenuItem[] =>
    list.map((d) => ({
      // The default names the device it's following on a line of its own, so neither is cut short.
      label: d.deviceId === "" ? "System default" : d.label,
      note: d.deviceId === "" && active ? active.label : undefined,
      checked: d.deviceId === sinkId,
      action: () => useSettings.getState().setAudioSinkId(d.deviceId),
    }));
  return (
    <Group title="Output" note="If the device disappears (a headset unplugged, Bluetooth dropped), playback pauses and goes back to the system default.">
      <Row
        icon={Speaker}
        title="Output device"
        note={sinkId ? "Pinned to this device" : "Following the system default"}
        control={<Pick>{devices ? value : "System default"}</Pick>}
        onPointerDown={keepMenu}
        onClick={(row) => {
          // Same toggle contract as the other pickers: a click on the row closes the open menu;
          // otherwise the list resolves (async) and the menu opens anchored to the row. The anchor is
          // measured now: the row may re-render before the list arrives.
          const rect = menuAnchor(row);
          const ui = useUI.getState();
          if (ui.contextMenu) {
            ui.closeContextMenu();
            return;
          }
          void listOutputDevices().then((list) => {
            setDevices(list);
            ui.openContextMenu(rect.right, rect.bottom + 6, itemsFor(list), { alignRight: true });
          });
        }}
      />
    </Group>
  );
}

const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  Treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1],
  Loudness: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5],
};

const bandLabel = (hz: number): string => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const dB = (g: number): string => `${g > 0 ? "+" : ""}${g} dB`;

/** A band's gain as it reads over the band: +3, 0, −2 (a real minus). */
const gainText = (g: number): string => (g > 0 ? `+${g}` : g < 0 ? `−${-g}` : "0");

/** The bands' sliders and the thumb they travel with, px (index.css .st-eq-band input), and the
    board's rules, dB. */
const EQ_H = 160;
const EQ_THUMB = 16;
const EQ_RULES = [12, 6, 0, -6, -12];

/**
 * 10-band graphic EQ, a line per band: each a real vertical slider (±12 dB, double-click for 0) with
 * its gain over it and its frequency under it, on a board ruled every 6 dB, so the keyboard and screen
 * readers get real sliders. Presets above it (built in, and your own: right-click to rename, update or
 * delete), "Prevent clipping" under it. Off, it stays on view, dimmed. Nothing in it changes size while
 * a band moves, so a drag never shifts it under the pointer: Save as preset is always there (off while
 * the curve is a preset), and the note doesn't name the preset.
 */
function Equalizer() {
  const enabled = useSettings((st) => st.eqEnabled);
  const gains = useSettings((st) => st.eqGains);
  const saved = useSettings((st) => st.eqPresets);
  const autoHeadroom = useSettings((st) => st.eqAutoHeadroom);
  const { setEqEnabled, setEqGains, saveEqPreset, renameEqPreset, deleteEqPreset, setEqAutoHeadroom } = useSettings.getState();
  const eqRef = useRef<HTMLDivElement>(null);
  const same = (curve: number[]): boolean => curve.every((g, i) => g === gains[i]);
  const builtIn = Object.keys(EQ_PRESETS).find((k) => same(EQ_PRESETS[k]));
  const mine = saved.find((p) => same(p.gains))?.name;
  const preset = builtIn ?? mine;
  const zero = eqY(0, EQ_H, EQ_THUMB);
  const setBand = (i: number, g: number): void => setEqGains(gains.map((v, j) => (j === i ? g : v)));

  // While a band is dragged, its knob and fill follow the pointer without easing; a preset eases.
  const hold = (): void => {
    const eq = eqRef.current;
    if (!eq) return;
    eq.classList.add("is-dragging");
    const done = (): void => {
      eq.classList.remove("is-dragging");
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
    };
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  const askName = (title: string, initialValue: string, confirmLabel: string, done: (name: string) => void, except = ""): void =>
    useUI.getState().openDialog({
      title,
      initialValue,
      placeholder: "Preset name",
      confirmLabel,
      onConfirm: (value) => {
        const name = value.trim().slice(0, 40);
        if (!name) return;
        if (EQ_PRESETS[name]) {
          useUI.getState().toast(`"${name}" is a built-in preset. Pick another name`, "error");
          return;
        }
        if (name !== except && saved.some((p) => p.name === name)) {
          useUI.getState().toast(`You already have a preset called "${name}"`, "error");
          return;
        }
        done(name);
      },
    });

  return (
    <Row
      icon={SlidersVertical}
      title="Equalizer"
      note="Shape the sound with 10 bands"
      toggle={{ checked: enabled, onChange: setEqEnabled }}
      wide={
        <div ref={eqRef} className={`st-eq${enabled ? "" : " is-off"}`}>
          <div className="st-eq-presets">
            {Object.keys(EQ_PRESETS).map((name) => (
              <button
                key={name}
                type="button"
                disabled={!enabled}
                aria-pressed={name === preset}
                onClick={() => setEqGains(EQ_PRESETS[name])}
                className="st-chip"
              >
                {name}
              </button>
            ))}
            {saved.map((p) => (
              <button
                key={`mine-${p.name}`}
                type="button"
                disabled={!enabled}
                aria-pressed={p.name === preset}
                onClick={() => setEqGains(p.gains)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useUI.getState().openContextMenu(e.clientX, e.clientY, [
                    { label: "Rename", action: () => askName("Rename preset", p.name, "Rename", (to) => renameEqPreset(p.name, to), p.name) },
                    { label: "Update to current curve", disabled: same(p.gains), action: () => saveEqPreset(p.name, gains) },
                    { label: "Delete", danger: true, separatorBefore: true, action: () => deleteEqPreset(p.name) },
                  ]);
                }}
                title="Right-click to rename, update or delete"
                className="st-chip"
              >
                {p.name}
              </button>
            ))}
            <button
              type="button"
              disabled={!enabled || preset !== undefined}
              onClick={() => askName("Save preset", "My preset", "Save", (name) => saveEqPreset(name, gains))}
              className="st-chip is-new"
            >
              Save as preset
            </button>
          </div>
          <div className="st-eq-board" onPointerDown={hold}>
            <div className="st-eq-bands">
              <div aria-hidden className="st-eq-rules" style={{ height: EQ_H }}>
                {EQ_RULES.map((g) => (
                  <span key={g} className={g === 0 ? "is-zero" : undefined} style={{ top: eqY(g, EQ_H, EQ_THUMB) }}>
                    <b>{gainText(g)}</b>
                  </span>
                ))}
              </div>
              {EQ_BANDS.map((hz, i) => {
                const g = gains[i] ?? 0;
                const y = eqY(g, EQ_H, EQ_THUMB);
                const place = { height: EQ_H, "--y": `${y}px`, "--top": `${Math.min(y, zero)}px`, "--len": `${Math.abs(y - zero)}px` };
                return (
                  <label key={hz} className={`st-eq-band${g ? " is-set" : ""}`} onDoubleClick={() => enabled && setBand(i, 0)}>
                    <span aria-hidden className="st-eq-gain">
                      {gainText(g)}
                    </span>
                    <span className="st-eq-rail" style={place as CSSProperties}>
                      <input
                        type="range"
                        min={-EQ_RANGE}
                        max={EQ_RANGE}
                        step={1}
                        value={g}
                        disabled={!enabled}
                        aria-label={`${bandLabel(hz)} Hz`}
                        aria-valuetext={dB(g)}
                        // In px, not 100%: a vertical slider's percentage height resolves against the
                        // window, which would stretch its travel far past the rail and the knob.
                        style={{ height: EQ_H }}
                        onChange={(e) => setBand(i, Number(e.target.value))}
                      />
                      <span aria-hidden className="st-eq-fill" />
                      <span aria-hidden className="st-eq-knob" />
                    </span>
                    <span aria-hidden className="st-eq-hz">
                      {bandLabel(hz)}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="st-eq-clip">
            <span className="st-eq-clip-text">
              <span className="st-eq-clip-title">Prevent clipping</span>
              <span className="st-eq-clip-note">Lowers the level only when your boosts would distort at the current volume</span>
            </span>
            <Switch checked={autoHeadroom} onChange={setEqAutoHeadroom} disabled={!enabled} label="Prevent clipping" />
          </div>
        </div>
      }
    />
  );
}

/* ============================================================ lyrics */

/** The options under Synced lyrics stay on view while it's off, dimmed: the page keeps its shape and
    the search still finds them. */
function LyricsPane() {
  const s = useSettings();
  const off = !s.syncedLyrics;
  const shift = describeLyricsShift(s.lyricsOffset);
  return (
    <Group note={off ? "Blur, romanized lyrics and timing work while synced lyrics are on." : undefined}>
      <Row icon={ListMusic} title="Synced lyrics" note="Highlight the current line and auto-scroll" toggle={{ checked: s.syncedLyrics, onChange: s.setSyncedLyrics }} />
      <Row
        icon={Droplets}
        title="Blur unfocused lyrics"
        note="Keep the spotlight on the current line"
        toggle={{ checked: s.blurUnfocusedLyrics, onChange: s.setBlurUnfocusedLyrics, disabled: off }}
      />
      <Row
        icon={Languages}
        title="Romanized lyrics"
        note="Show a Latin-letters reading under lyrics in other scripts, like Hindi, Telugu or Korean"
        toggle={{ checked: s.romanizeLyrics, onChange: s.setRomanizeLyrics, disabled: off }}
      />
      <Row
        icon={Timer}
        title="Lyrics timing"
        note="On this device, for headphones that lag. [ and ] adjust one song while lyrics are open"
        control={<Reading text={shift} widest={["2.75 s earlier"]} />}
        disabled={off}
      >
        <Range
          label="Lyrics timing"
          valueText={shift}
          min={-3}
          max={3}
          step={LYRICS_NUDGE_STEP}
          value={s.lyricsOffset}
          onChange={s.setLyricsOffset}
          ends={["3 s earlier", "3 s later"]}
          disabled={off}
          origin={0}
          major={1}
        />
      </Row>
    </Group>
  );
}

/* ============================================================ display */

function DisplayPane() {
  const s = useSettings();
  return (
    <>
      <Group title="Motion and glass">
        <Row
          icon={AppWindow}
          title="Reduce animation"
          note="Cut crossfades and motion through the app"
          toggle={{ checked: s.reduceAnimation, onChange: s.setReduceAnimation }}
        />
        <Row
          icon={Droplets}
          title="Reduce dynamic blur"
          note="Fill glass surfaces solid instead of blurring"
          toggle={{ checked: s.reduceDynamicBlur, onChange: s.setReduceDynamicBlur }}
        />
        <Row
          icon={Sparkles}
          title="Liquid glass"
          note={s.reduceDynamicBlur ? "Off while dynamic blur is reduced" : "Refractive glass on the floating chrome"}
          toggle={{ checked: s.liquidGlass, onChange: s.setLiquidGlass, disabled: s.reduceDynamicBlur }}
        />
      </Group>
      <Group title="Now playing">
        <Row
          icon={Maximize2}
          title="Full-screen cover art"
          note="Let the artwork bleed behind the status area"
          toggle={{ checked: s.fullBleedArtwork, onChange: s.setFullBleedArtwork }}
        />
        <Row
          icon={Clapperboard}
          title="Animated cover art"
          note="Play canvas clips in place of the still cover"
          toggle={{ checked: s.animatedCanvas, onChange: s.setAnimatedCanvas }}
        />
        <Row
          icon={Image}
          title="Legacy mesh gradient"
          note="Use the older drifting-blob player backdrop"
          toggle={{ checked: s.legacyMeshGradient, onChange: s.setLegacyMeshGradient }}
        />
      </Group>
      <Group title="Player bar">
        <Row
          icon={SlidersHorizontal}
          title="Hide volume bar"
          note="Keep the player bar free of the volume slider"
          toggle={{ checked: s.hideVolumeBar, onChange: s.setHideVolumeBar }}
        />
      </Group>
    </>
  );
}

/* ============================================================ library */

function LibraryPane() {
  const s = useSettings();
  const toast = useUI((st) => st.toast);
  const [folderSummary, setFolderSummary] = useState<string | null>(null);

  const refreshFolderSummary = async (): Promise<void> => {
    const lib = await window.bytune?.localLibrary();
    const n = lib?.folders?.length ?? 0;
    setFolderSummary(n === 0 ? "No folders imported yet" : `${n} folder${n === 1 ? "" : "s"} imported`);
  };

  useEffect(() => {
    void refreshFolderSummary();
  }, []);

  const browse = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const dir = await window.bytune.pickFolder();
      if (dir) {
        s.setDownloadDir(dir);
        toast("Download folder updated", "success");
      }
    } catch {
      toast("Couldn't open the folder picker", "error");
    }
  };

  const chooseMusicFolder = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const dir = await window.bytune.pickFolder();
      if (!dir) return;
      toast("Importing folder…", "info");
      const res = await window.bytune.addLibraryFolders([dir]);
      if (res.added.length === 0) {
        setFolderSummary(`${res.lib.folders.length} folders imported`);
        toast("That folder is already in your library", "info");
        return;
      }
      s.setLocalMusicFolder(dir);
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      setFolderSummary(`${res.lib.folders.length} folder${res.lib.folders.length === 1 ? "" : "s"} imported`);
      toast("Local library scanned", "success");
    } catch {
      toast("Couldn't import that folder", "error");
    }
  };

  const rescanMusic = async (): Promise<void> => {
    if (!window.bytune) return;
    const lib = await window.bytune.localLibrary();
    if (!lib?.folders?.length) {
      toast("Import a local folder first", "info");
      return;
    }
    toast("Rescanning local library…", "info");
    try {
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      toast("Local library updated", "success");
    } catch {
      toast("Rescan failed", "error");
    }
  };

  return (
    <>
      <Group title="Local music">
        <Row
          icon={FolderOpen}
          title="Local music folders"
          note={folderSummary ?? "Your imported collections"}
          control={<ChevronRight className="st-go" />}
          onClick={() => useUI.getState().navigate({ name: "local" })}
        />
        <Row
          icon={FolderPlus}
          title="Add a folder"
          note="Import music folders. A parent folder brings its music subfolders along"
          control={<ChevronRight className="st-go" />}
          onClick={() => void chooseMusicFolder()}
        />
        <Row
          icon={RefreshCw}
          title="Rescan library"
          note="Re-read tags and artwork from every imported folder"
          control={<ChevronRight className="st-go" />}
          onClick={() => void rescanMusic()}
        />
        <Row
          icon={Filter}
          title="Filter non-music audio"
          note="Hide clips, recordings and voice notes (applies on rescan)"
          toggle={{
            checked: s.filterNonMusicAudio,
            onChange: (v) => {
              s.setFilterNonMusicAudio(v);
              void rescanMusic();
            },
          }}
        />
      </Group>
      <Group title="Downloads">
        <Row
          icon={FolderDown}
          title="Download folder"
          note={s.downloadDir ?? "Default: your system Downloads folder / ByTune"}
          control={<ChevronRight className="st-go" />}
          onClick={() => void browse()}
        />
        <Row icon={Download} title="Download quality" note="What a saved track costs on disk">
          <Choice
            label="Download quality"
            value={s.downloadQuality}
            options={["standard", "high", "lossless"] as const}
            labels={DOWNLOAD_QUALITY_LABEL}
            onChange={s.setDownloadQuality}
          />
        </Row>
        <Row
          icon={FileMusic}
          title="Export compatible downloads"
          note="Also save them into your Music library (Music/ByTune), so other players can use the files. Otherwise downloads stay in the folder above"
          badge={s.exportDownloads ? "Music/ByTune" : undefined}
          toggle={{ checked: s.exportDownloads, onChange: s.setExportDownloads }}
        />
      </Group>
    </>
  );
}

/* ============================================================ your data */

function DataPane() {
  const toast = useUI((st) => st.toast);
  const openDialog = useUI((st) => st.openDialog);
  const session = useSession();
  const [guestDeleteOpen, setGuestDeleteOpen] = useState(false);

  const exportData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupExport();
      if (res?.path) toast("Backup saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Export failed", "error");
    }
  };

  const importData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupImport();
      if (res?.restored) {
        toast(`Backup restored${typeof res.months === "number" && res.months > 0 ? ` (${res.months} months of history)` : ""}. Reloading…`, "success");
        window.setTimeout(() => window.location.reload(), 900);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Import failed", "error");
    }
  };

  const resetAppData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      // Main-process wipe: every store, history buckets and derived caches. Downloaded audio files are
      // the user's files and stay on disk.
      await window.bytune.resetData();
      window.location.reload();
    } catch {
      toast("Couldn't reset app data", "error");
    }
  };

  const reset = (): void => {
    // Guests have no cloud backup: deletion is unrecoverable, so route through the dedicated
    // protection modal instead.
    if (session.mode === "guest") {
      setGuestDeleteOpen(true);
      return;
    }
    openDialog({
      title: "Reset local data?",
      body: "Your local ByTune data will be removed from this device. Your account and cloud backup won't be deleted. Sign in again and everything restores. Downloaded audio files are not touched.",
      confirmLabel: "Reset local data",
      danger: true,
      onConfirm: () => void resetAppData(),
    });
  };

  const toOnboarding = async (intent: "signin" | "signup"): Promise<void> => {
    setGuestDeleteOpen(false);
    try {
      await window.bytune?.authClearGuestProfile();
    } catch {
      useUI.getState().toast("Couldn't open onboarding. Try again.", "error");
      return;
    }
    setOnboardingIntent(intent);
    void useSession.getState().refresh();
  };

  return (
    <>
      <Group title="Listening">
        <Row
          icon={BarChart3}
          title="Replay"
          note="Your listening wrapped over time"
          control={<ChevronRight className="st-go" />}
          onClick={() => useUI.getState().navigate({ name: "replay" })}
        />
      </Group>
      <Group title="Backups">
        <Row
          icon={FileUp}
          title="Export data"
          note="Write a backup of your library and history"
          control={<ChevronRight className="st-go" />}
          onClick={() => void exportData()}
        />
        <Row
          icon={FileDown}
          title="Import data"
          note="Restore a backup, replacing what's here"
          control={<ChevronRight className="st-go" />}
          onClick={() =>
            openDialog({
              title: "Import a backup?",
              body: "Your current library, playlists and history will be replaced by the backup's.",
              confirmLabel: "Choose file",
              danger: true,
              onConfirm: () => void importData(),
            })
          }
        />
      </Group>
      <Group title="Start over">
        <Row
          danger
          icon={Trash2}
          title="Reset app data"
          note="Erase library, playlists, history and settings on this device"
          control={
            <Button kind="danger" onClick={reset}>
              Reset
            </Button>
          }
        />
      </Group>
      {guestDeleteOpen && (
        <GuestDeleteModal
          onClose={() => setGuestDeleteOpen(false)}
          onSignIn={() => void toOnboarding("signin")}
          onCreateAccount={() => void toOnboarding("signup")}
          onDeleteAnyway={() => {
            setGuestDeleteOpen(false);
            void resetAppData();
          }}
        />
      )}
    </>
  );
}

/* ============================================================ about */

/** Where updates stand (electron/updater.ts), and the one thing to do about it. */
function UpdatesGroup() {
  const u = useUpdates();
  if (!u) return null;
  const { status, current, version, percent } = u;
  const check = <Button onClick={() => void window.bytune?.checkForUpdates()}>Check for updates</Button>;
  const view: { title: string; note: string; control?: ReactNode } =
    status === "checking"
      ? { title: "Checking for updates…", note: `You have version ${current}`, control: <Button disabled onClick={() => undefined}>Check for updates</Button> }
      : status === "current"
        ? { title: "ByTune is up to date", note: `Version ${current} is the newest`, control: check }
        : status === "available"
          ? {
              title: `Version ${version} is available`,
              note: u.installs ? `You have version ${current}. It installs right here.` : `You have version ${current}. Get it from bytune.space.`,
              control: <Button kind="primary" onClick={() => void window.bytune?.installUpdate()}>{u.installs ? "Update" : "Download"}</Button>,
            }
          : status === "downloading"
            ? { title: `Downloading version ${version}…`, note: `${percent ?? 0}%` }
            : status === "ready"
              ? {
                  title: `Version ${version} is ready`,
                  note: "Restart ByTune to finish updating",
                  control: <Button kind="primary" onClick={() => void window.bytune?.restartToUpdate()}>Restart to update</Button>,
                }
              : status === "error"
                ? {
                    title: version ? "Couldn't update" : "Couldn't check for updates",
                    note: u.error ?? "Try again in a moment",
                    control: version
                      ? <Button onClick={() => window.open("https://bytune.space", "_blank", "noopener")}>Download</Button>
                      : check,
                  }
                : { title: "Updates", note: `You have version ${current}`, control: check };
  return (
    <Group title="Updates">
      <Row icon={RefreshCw} title={view.title} note={view.note} control={view.control} />
    </Group>
  );
}

function AboutPane() {
  const versions = window.bytune?.versions;
  return (
    <>
      <section data-setting-group className="st-group">
        {/* The brand's stacked lockup, then the version and the licence, centred. */}
        <div data-setting-row className="st-about">
          <img src={brandLogo} alt="" aria-hidden className="st-about-mark" />
          <img src={brandText} alt="ByTune" className="st-about-word" />
          <p className="st-about-version">Version {versions?.app ?? "1.0.0"}</p>
          <p className="st-about-meta">Free and open source under GPL-3.0</p>
        </div>
      </section>
      <UpdatesGroup />
      <Group title="Links">
        <Row
          icon={Globe}
          title="ByTune website"
          note="bytune.space: downloads, news and help"
          control={<ExternalLink className="st-go" />}
          onClick={() => window.open("https://bytune.space", "_blank", "noopener")}
        />
      </Group>
    </>
  );
}

const PANES: Record<CategoryId, () => ReactNode> = {
  account: () => <AccountPane />,
  playback: () => <PlaybackPane />,
  sound: () => <SoundPane />,
  lyrics: () => <LyricsPane />,
  display: () => <DisplayPane />,
  library: () => <LibraryPane />,
  data: () => <DataPane />,
  about: () => <AboutPane />,
};

/* ============================================================ view */

export function SettingsView() {
  const param = useUI((s) => s.view.param);
  const active: CategoryId = isCategory(param) ? param : "account";
  const [filter, setFilter] = useState("");
  const q = filter.trim();
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // Which way the step went, for the pane's entrance: down the list rises, up the list drops.
  const last = useRef(active);
  const up = indexOf(active) < indexOf(last.current);
  useEffect(() => {
    last.current = active;
  }, [active]);
  const category = CATEGORIES[indexOf(active)];

  const pick = (id: CategoryId): void => {
    setFilter("");
    useUI.getState().replaceView({ name: "settings", param: id });
  };

  // The light under the category you're in: placed from the button's own box, so it slides between
  // categories in the rail and along the strip on a narrow page alike. It arrives without sliding the
  // first time.
  const [light, setLight] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [lightMoves, setLightMoves] = useState(false);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const place = (): void => {
      const el = nav.querySelector<HTMLElement>(`[data-cat="${active}"]`);
      if (!el) return;
      const next = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      setLight((prev) => (prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next));
      // On a narrow page the categories scroll sideways: keep the current one in view.
      if (nav.scrollWidth > nav.clientWidth) {
        const left = el.offsetLeft - 8;
        const right = el.offsetLeft + el.offsetWidth + 8;
        if (left < nav.scrollLeft) nav.scrollLeft = left;
        else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth;
      }
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [active]);
  useEffect(() => {
    if (!light || lightMoves) return;
    const id = window.requestAnimationFrame(() => setLightMoves(true));
    return () => window.cancelAnimationFrame(id);
  }, [light, lightMoves]);

  // Search: every category's rows are on the page; show the rows whose words match (a category's or a
  // group's title shows all of it), after every render so conditional rows follow. Inline display,
  // not [hidden]: utility display classes outrank [hidden].
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !q) return;
    const ql = q.toLowerCase();
    const hits = (el: Element | null): boolean => !!el && (el.textContent ?? "").toLowerCase().includes(ql);
    const show = (el: HTMLElement, on: boolean): void => {
      el.style.display = on ? "" : "none";
    };
    let any = false;
    root.querySelectorAll<HTMLElement>("[data-setting-category]").forEach((cat) => {
      const whole = hits(cat.querySelector("[data-setting-category-title]"));
      let anyGroup = false;
      cat.querySelectorAll<HTMLElement>("[data-setting-group]").forEach((group) => {
        const rows = [...group.querySelectorAll<HTMLElement>("[data-setting-row]")];
        const all = whole || hits(group.querySelector("[data-setting-header]"));
        let anyRow = false;
        for (const row of rows) {
          const on = all || hits(row);
          show(row, on);
          anyRow ||= on;
        }
        const on = rows.length ? anyRow : all || hits(group);
        show(group, on);
        anyGroup ||= on;
      });
      show(cat, anyGroup);
      any ||= anyGroup;
    });
    const empty = root.querySelector<HTMLElement>("[data-settings-empty]");
    if (empty) show(empty, !any);
  });

  const onNavKey = (e: React.KeyboardEvent): void => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const from = (e.target as HTMLElement).closest<HTMLElement>("[data-cat]")?.dataset.cat;
    if (!isCategory(from)) return;
    e.preventDefault();
    const next = CATEGORIES[(indexOf(from) + step + CATEGORIES.length) % CATEGORIES.length].id;
    pick(next);
    navRef.current?.querySelector<HTMLElement>(`[data-cat="${next}"]`)?.focus();
  };

  return (
    <div ref={rootRef} className={`st-wrap${q ? " st-searching" : ""}`}>
      <div className="st-layout">
        <aside className="st-rail">
          <h1 className="st-title">Settings</h1>
          <div className="st-search">
            <Search aria-hidden className="w-4 h-4" />
            <input
              id="settings-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filter) {
                  e.stopPropagation();
                  setFilter("");
                }
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              autoComplete="off"
              spellCheck={false}
            />
            {filter && (
              <button type="button" aria-label="Clear search" onClick={() => setFilter("")} className="st-search-clear">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <nav ref={navRef} aria-label="Settings categories" className="st-nav" onKeyDown={onNavKey}>
            <span
              aria-hidden
              className={`st-nav-light${lightMoves ? " is-moving" : ""}${q || !light ? " is-hidden" : ""}`}
              style={
                light
                  ? ({ "--x": `${light.x}px`, "--y": `${light.y}px`, "--w": `${light.w}px`, "--h": `${light.h}px` } as CSSProperties)
                  : undefined
              }
            />
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                data-cat={c.id}
                aria-current={!q && c.id === active ? "page" : undefined}
                onClick={() => pick(c.id)}
                className="st-nav-item"
              >
                <c.icon aria-hidden className="w-[18px] h-[18px]" />
                <span>{c.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="st-main">
          {q ? (
            <div className="st-results">
              {CATEGORIES.map((c) => (
                <section key={c.id} data-setting-category className="st-result">
                  <h2 data-setting-category-title className="st-result-title">
                    {c.label}
                  </h2>
                  {PANES[c.id]()}
                </section>
              ))}
              <p data-settings-empty style={{ display: "none" }} className="st-empty">
                No settings match “{q}”
              </p>
            </div>
          ) : (
            <div key={active} className={`st-pane${up ? " is-up" : ""}`}>
              <header className="st-pane-head">
                <h2 className="st-pane-title">{category.label}</h2>
                <p className="st-pane-lede">{category.lede}</p>
              </header>
              {PANES[active]()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
