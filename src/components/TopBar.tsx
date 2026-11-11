/**
 * Top bar — Spotify's three-cluster layout on a glass strip.
 *
 *  - Left: history chevrons + the brand mark (28dp), like Spotify's logo
 *    beside the back/forward buttons.
 *  - Centre: a centred floating search field, max 560px, on a glass pill.
 *  - Right: notifications, settings, and a round user avatar that opens the
 *    settings dropdown.
 *
 * The bar itself is `chrome-glass` (rgba(0,0,0,0.72) + blur(24) saturate(140%),
 * per index.css) — the same recipe the mobile status bar uses.
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpLeft,
  ChevronLeft,
  ChevronRight,
  Compass,
  Copy,
  History,
  Home,
  Minus,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { withSearchRows } from "../shared/ytm";
import { reloadHomeFeed } from "../lib/recs/feed";
import { searchPageOnce } from "../lib/searchOnce";
import { browseMenuItems, trackMenuItems } from "../lib/trackActions";
import { shownName, useSession } from "../lib/session";
import { isMac } from "../lib/platform";
import { avatarFor } from "../lib/avatar";
import { useUI } from "../stores/ui";
import { usePlayer } from "../stores/player";
import { useRecents } from "../stores/recents";
import { useRecentItems } from "../stores/recentItems";
import type { SearchSuggestion } from "../types";
import { Artwork } from "./primitives";
import { FitText } from "./FitText";
import { useMenuLight } from "./ContextMenu";
import { StreakChip } from "./Streak";
import { useUpdates } from "../lib/updates";
import brandLogo from "../assets/brand/bytune-logo.svg";
import brandText from "../assets/brand/bytune-Text.svg";

/** Brand mark + wordmark composed inline so the spacing follows the bar height.
    Both SVGs are pure white — they sit directly on the dark `chrome-glass` bar.
    Imported as assets so Vite hashes them and rewrites the URL relative to the
    bundle (base: "./"), which is what makes them resolve under file:// in the
    packaged app — a string like "/brand/x.svg" only works on the dev server. */
function BrandHeader() {
  return (
    <div className="flex items-center gap-2" data-intro-target>
      <img
        src={brandLogo}
        alt=""
        aria-hidden
        className="h-7 w-auto block"
      />
      <img
        src={brandText}
        alt="ByTune"
        className="h-[19px] w-auto block"
      />
    </div>
  );
}

/**
 * A newer ByTune: Update (downloads it on Windows, opens the download page on a Mac), its progress,
 * then Restart to update. Only there while there's one; a failed download sends you to Settings › About.
 */
function UpdateChip() {
  const u = useUpdates();
  // A known version stays up while Check for updates looks again ("checking" keeps it).
  if (!u?.version || u.status === "current") return null;
  const ready = u.status === "ready";
  const label = u.status === "downloading" ? `Updating ${u.percent ?? 0}%` : ready ? "Restart to update" : "Update";
  const act = (): void => {
    if (ready) void window.bytune?.restartToUpdate();
    else if (u.status === "available") void window.bytune?.installUpdate();
    else useUI.getState().openSettings("about");
  };
  return (
    <button
      onClick={act}
      title={ready ? `Restart ByTune to install version ${u.version}` : `ByTune ${u.version} is available`}
      aria-label={ready ? `Restart to install ByTune ${u.version}` : `${label}: ByTune ${u.version}`}
      className="update-chip"
    >
      {ready ? <RotateCw className="w-4 h-4" strokeWidth={2.5} /> : <ArrowDownToLine className="w-4 h-4" strokeWidth={2.5} />}
      <span className="update-label">{label}</span>
    </button>
  );
}

/** The profile button: opens Settings, and closes it again while it's showing. */
function Avatar({ onClick, active }: { onClick: () => void; active?: boolean }) {
  const mode = useSession((s) => s.mode);
  const username = useSession((s) => s.username);
  const displayName = useSession((s) => s.displayName);
  // The first letter of the display name (an account without one yet: its username's).
  const { color, letter } = avatarFor(mode, username, shownName({ mode, username, displayName }));
  return (
    <button
      onClick={onClick}
      title={active ? "Close settings" : "Settings"}
      aria-label={active ? "Close settings" : "Settings"}
      className={`w-11 h-11 rounded-full grid place-items-center transition-colors select-none ${
        active ? "bg-ink-hi/[0.16]" : "bg-ink-hi/[0.10] hover:bg-ink-hi/[0.16]"
      }`}
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-full text-[15px] font-semibold leading-none text-black/85"
        style={{ backgroundColor: color }}
      >
        {letter}
      </span>
    </button>
  );
}

/** Windows caption buttons, drawn by the renderer so they match the theme:
    #242424 hover on min/max, Windows red on close. macOS renders native
    traffic lights instead (hiddenInset) and this component is not mounted. */
export function CaptionButtons() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    window.bytune?.isMaximized().then(setMaximized).catch(() => undefined);
    const off = window.bytune?.onMaximizeChange(setMaximized);
    return () => off?.();
  }, []);

  const base =
    "app-no-drag w-[46px] h-full grid place-items-center text-ink-hi/85 transition-colors";
  return (
    <div className="app-no-drag h-full flex items-stretch">
      <button
        onClick={() => window.bytune?.windowMinimize()}
        title="Minimize"
        aria-label="Minimize"
        className={`${base} hover:bg-ink-hi/[0.08]`}
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        onClick={() => window.bytune?.windowMaximizeToggle()}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        className={`${base} hover:bg-ink-hi/[0.08]`}
      >
        {maximized ? <Copy className="w-[13px] h-[13px]" /> : <Square className="w-[13px] h-[13px]" />}
      </button>
      <button
        onClick={() => window.bytune?.windowClose()}
        title="Close"
        aria-label="Close"
        className={`${base} hover:bg-[#c42b1c] hover:text-white`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function TopBar() {
  const query = useUI((s) => s.searchQuery);
  const setQuery = useUI((s) => s.setSearchQuery);
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const goBack = useUI((s) => s.goBack);
  const goForward = useUI((s) => s.goForward);
  const canBack = useUI((s) => s.navPast.length > 0);
  const canForward = useUI((s) => s.navFuture.length > 0);
  /** Settings is what you're looking at (not hidden under the lyrics): the profile button closes it. */
  const settingsShown = useUI((s) => s.view.name === "settings" && !s.lyricsCenter);
  const toggleSettings = useUI((s) => s.toggleSettings);
  const recents = useRecents((s) => s.searches);
  const removeSearch = useRecents((s) => s.removeSearch);
  const clearSearches = useRecents((s) => s.clearSearches);
  const track = usePlayer((s) => s.queue[s.index] ?? null);

  // Typing only feeds the dropdown — the page behind it stays put. The
  // results page is where songs get chosen; navigation happens on Enter or
  // a completion click, and the dropdown closes either way.

  // Type-ahead dropdown — YouTube Music's typeahead model: row 0 offers the
  // typed query itself, then up to 3 text completions (each with a fill
  // arrow), then up to 12 rich rows that play or open straight away. The
  // main process drops a completion that just echoes the query.
  const [suggests, setSuggests] = useState<SearchSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  /** keyboard highlight: 0 = the typed-query row, 1..n = suggestions (text, then rich), -1 = none */
  const [activeIdx, setActiveIdx] = useState(-1);
  const suggestSeq = useRef(0);
  /** finished dropdowns per query — retyping one never refetches */
  const suggestCache = useRef(new Map<string, SearchSuggestion[]>());
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** the field + both dropdowns — blur is ignored while focus stays inside */
  const searchClusterRef = useRef<HTMLDivElement | null>(null);
  const suggestListRef = useRef<HTMLDivElement | null>(null);
  /** the dropdowns' lights, as on every menu: one glides to the row under the pointer or the keys */
  const suggestLight = useMenuLight();
  const recentLight = useMenuLight();

  useEffect(() => {
    const q = query.trim();
    if (!fieldFocused || q.length < 2) {
      // Invalidate any request still in flight, or it reopens the dropdown
      // after Enter, a blur or a cleared field.
      suggestSeq.current++;
      setSuggests([]);
      setSuggestOpen(false);
      setActiveIdx(-1);
      return;
    }
    const seq = ++suggestSeq.current;
    const show = (items: SearchSuggestion[]): void => {
      if (suggestSeq.current !== seq) return; // a newer keystroke won
      setSuggests(items);
      setSuggestOpen(items.length > 0);
    };
    const cached = suggestCache.current.get(q);
    if (cached) {
      show(cached);
      setActiveIdx(-1);
      return;
    }
    const timer = window.setTimeout(() => {
      const api = window.bytune;
      if (!api) return;
      const first = api.suggestions(q).then((res) => res?.items ?? [], () => null);
      void first.then((items) => {
        show(items ?? []);
        setActiveIdx(-1);
      });
      // The search page's own rows top the rich rows up to 12, appended once
      // the suggestions have painted — never ahead of them.
      void Promise.all([first, searchPageOnce(q, "all").catch(() => null)]).then(([items, page]) => {
        if (!page) return;
        const full = withSearchRows(items ?? [], page.rows ?? []);
        if (items) {
          suggestCache.current.set(q, full);
          const oldest = suggestCache.current.keys().next().value;
          if (suggestCache.current.size > 30 && oldest !== undefined) suggestCache.current.delete(oldest);
        }
        show(full);
      });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [query, fieldFocused]);

  // Arrow keys can walk past the dropdown's fold, and the light follows them.
  useEffect(() => {
    const row = suggestListRef.current?.querySelector('[data-active="true"]') ?? null;
    row?.scrollIntoView({ block: "nearest" });
    if (activeIdx >= 0) suggestLight.to(row);
  }, [activeIdx]);
  // New rows: the light would sit on whatever row now holds its old place.
  useEffect(() => suggestLight.to(null), [suggests]);

  const closeDropdown = (): void => {
    suggestSeq.current++;
    setSuggestOpen(false);
    setActiveIdx(-1);
  };

  /** Going home always lands clean — a stale query left in the field would
      read as "a search is still active" while the feed shows behind it. */
  const goHome = (): void => {
    setQuery("");
    closeDropdown();
    setSuggests([]);
    setFieldFocused(false);
    inputRef.current?.blur();
    navigate({ name: "home" });
  };

  /** Mobile model: an empty focused field drops the recent-searches panel. */
  const historyOpen = fieldFocused && suggestOpen === false && recents.length > 0 && query.trim().length === 0;

  /** Run a search: commit the text, close the dropdown, blur the field. */
  const submitSearch = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    setQuery(t);
    useRecents.getState().pushSearch(t);
    closeDropdown();
    setFieldFocused(false);
    inputRef.current?.blur();
    navigate({ name: "search" });
  };

  /** The fill arrow: the completion goes into the field to keep typing — no search. */
  const fillSuggestion = (text: string): void => {
    setQuery(text);
    setActiveIdx(-1);
    inputRef.current?.focus();
  };

  /** A rich row, as the search page's row does it: a song, video or episode
      plays on its own (AutoPlay carries on); a page opens. */
  const openSuggestion = (s: SearchSuggestion): void => {
    const q = query.trim();
    if (q) useRecents.getState().pushSearch(q);
    closeDropdown();
    setFieldFocused(false);
    inputRef.current?.blur();
    const recent = useRecentItems.getState();
    if (s.track) {
      recent.add({ kind: "song", id: s.track.id, title: s.track.title, subtitle: s.track.artist, thumb: s.track.thumb, track: s.track });
      usePlayer.getState().playQueue([s.track], 0);
    } else if (s.browse) {
      const b = s.browse;
      if (b.type === "artist" || b.type === "album" || b.type === "playlist") {
        recent.add({ kind: b.type, id: b.browseId, title: b.title, subtitle: b.subtitle, thumb: b.thumb });
      }
      if (b.type === "artist" || b.browseId.startsWith("UC")) navigate({ name: "artist", param: b.browseId });
      else if (b.type === "album") navigate({ name: "album", param: b.browseId });
      else if (b.type === "playlist") navigate({ name: "ytplaylist", param: b.browseId });
      else navigate({ name: "podcast", param: b.browseId });
    }
  };

  /** The search page's menu for the same kind of row; it takes over from the dropdown. */
  const openSuggestionMenu = (e: React.MouseEvent, s: SearchSuggestion): void => {
    const items = s.track ? trackMenuItems(s.track) : s.browse ? browseMenuItems(s.browse) : [];
    if (!items.length) return;
    e.preventDefault();
    closeDropdown();
    setFieldFocused(false);
    inputRef.current?.blur();
    useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDropdown();
      setFieldFocused(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown" && suggestOpen && suggests.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggests.length));
    } else if (e.key === "ArrowUp" && suggestOpen) {
      e.preventDefault();
      setActiveIdx((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // A keyboard-highlighted row runs itself; anything else runs the typed
      // query. Either way the dropdown goes away.
      const pick = suggestOpen && activeIdx >= 1 ? suggests[activeIdx - 1] : undefined;
      if (pick?.kind) openSuggestion(pick);
      else submitSearch(pick?.text ?? query);
    }
  };

  // Refresh is route-aware: Home drops its feed caches and re-orchestrates
  // (its own central mechanism); every other view gets its data lifecycle
  // re-run in place — App keys the view container on viewReloadNonce, so the
  // bump remounts the page and its fetch effects, with route and params
  // untouched. Never navigates: a refresh on Search stays on Search.
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const refreshCurrentView = (): void => {
    if (feedRefreshing) return;
    setFeedRefreshing(true);
    if (view.name === "home") reloadHomeFeed();
    else useUI.getState().bumpViewReload();
    window.setTimeout(() => setFeedRefreshing(false), 800);
  };

  return (
    /* The bar runs to the window edge: Windows draws renderer caption
       buttons top-right; macOS reserves the top-left strip for the native
       traffic lights (hiddenInset) — 84px clears the three lights plus
       breathing room, so the brand mark starts where they end. The bar owns
       the 12px breathing strip under it (App's shell no longer adds one),
       so its content centres in the full 68px — equal space above and below. */
    <div
      className={`app-drag relative h-[68px] shrink-0 flex items-center gap-3 chrome-glass z-20 ${
        isMac ? "pl-[84px]" : "pl-3"
      }`}
    >
      {/* Left cluster — brand flush to the edge, then a hairline divider so the
          logo reads as separate from the history + refresh controls (Spotify's
          top-bar model: 32px circular buttons, 16px glyphs). */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={goHome}
          className="app-no-drag flex items-center gap-2 pl-1 pr-2 h-10 rounded-full hover:bg-ink-hi/[0.06] transition-colors"
          title="ByTune"
        >
          <BrandHeader />
        </button>
        <div className="mx-1.5 h-6 w-px bg-ink-hi/15" />
        <button
          onClick={() => goBack()}
          title="Go back"
          aria-label="Go back"
          disabled={!canBack}
          className={`app-no-drag w-9 h-9 grid place-items-center rounded-full transition-colors ${
            canBack
              ? "text-ink-hi/90 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              : "text-ink-hi/30 pointer-events-none"
          }`}
        >
          <ChevronLeft className="w-5 h-5" strokeWidth={2.5} />
        </button>
        <button
          onClick={() => goForward()}
          title="Go forward"
          aria-label="Go forward"
          disabled={!canForward}
          className={`app-no-drag w-9 h-9 grid place-items-center rounded-full transition-colors ${
            canForward
              ? "text-ink-hi/90 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              : "text-ink-hi/30 pointer-events-none"
          }`}
        >
          <ChevronRight className="w-5 h-5" strokeWidth={2.5} />
        </button>
        <button
          onClick={refreshCurrentView}
          title="Refresh"
          aria-label="Refresh"
          className="app-no-drag w-9 h-9 grid place-items-center rounded-full text-ink-hi/60 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${feedRefreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Centre cluster — home button beside the search field, Spotify-style:
          pinned to the true window centre (not balanced between the side
          clusters), centred on the bar's vertical midline. */}
      <div className="absolute left-1/2 top-0 h-full -translate-x-1/2 flex items-center gap-3">
        <button
          onClick={goHome}
          title="Home"
          aria-label="Home"
          aria-current={view.name === "home" ? "page" : undefined}
          className={`app-no-drag w-12 h-12 shrink-0 grid place-items-center rounded-full transition-colors ${
            view.name === "home"
              ? "bg-elevated text-ink-hi"
              : "bg-panel text-ink-hi/75 hover:text-ink-hi hover:bg-ink-hi/[0.06]"
          }`}
        >
          <Home className="w-5 h-5" />
        </button>
        <div ref={searchClusterRef} className="app-no-drag relative w-[min(474px,36vw)]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-ink-hi/55 pointer-events-none" />
          <input
            id="global-search"
            ref={inputRef}
            type="text"
            value={query}
            maxLength={200}
            placeholder="What do you want to play?"
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              setFieldFocused(true);
              if (suggests.length > 0) setSuggestOpen(true);
            }}
            onBlur={(e) => {
              // Close the moment focus genuinely leaves the cluster — no
              // timer. Dropdown rows keep focus on the field with
              // onMouseDown preventDefault, so a click on a row never blurs
              // here; and if focus moves INTO the dropdown (keyboard Tab),
              // the popover stays open for it. A pending blur timeout used
              // to fire after a quick re-focus and hide the popover while
              // the field was focused again.
              const next = e.relatedTarget as Node | null;
              if (next && searchClusterRef.current?.contains(next)) return;
              setFieldFocused(false);
              setSuggestOpen(false);
              setActiveIdx(-1);
            }}
            onKeyDown={onSearchKeyDown}
            className={`w-full h-12 pl-12 rounded-full bg-panel border border-transparent text-[16px] text-ink-hi placeholder:text-ink-hi/45 outline-none hover:bg-ink-hi/[0.06] focus:border-ink-hi/25 focus:bg-ink-hi/[0.06] transition-all duration-150 ${
              query.trim() !== "" ? "pr-[104px]" : "pr-[72px]"
            }`}
          />
          {/* Type-ahead dropdown — the typed query, text completions (the
              arrow fills one in without searching), then rich rows in the
              queue's compact row style: round art for artists, rounded
              squares for the rest. */}
          {fieldFocused && suggestOpen && suggests.length > 0 && (
            <div
              ref={suggestListRef}
              className="menu absolute left-0 right-0 top-full mt-2 z-50 max-h-[min(600px,calc(100vh_-_88px))] overflow-y-auto"
              style={{ "--menu-origin": "top center" } as React.CSSProperties}
              role="listbox"
              aria-label="Search suggestions"
            >
              <div className="menu-list" {...suggestLight.track}>
              {suggestLight.light}
              <button
                data-active={activeIdx === 0}
                data-menu-row=""
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submitSearch(query)}
                className="fit-host relative w-full flex items-center gap-3 px-2.5 h-11 rounded-[10px] text-left"
              >
                <Search className="w-4 h-4 text-ink-hi/55 shrink-0" />
                <FitText text={`Search “${query.trim()}”`} className="text-[14px] font-medium text-ink-hi" />
              </button>
              {suggests.map((s, i) =>
                s.kind ? (
                  <button
                    key={s.id}
                    data-active={activeIdx === i + 1}
                    data-menu-row=""
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => openSuggestion(s)}
                    onContextMenu={(e) => openSuggestionMenu(e, s)}
                    className="fit-host relative w-full flex items-center gap-3 px-2.5 h-14 rounded-[10px] text-left"
                  >
                    <Artwork
                      src={s.thumb}
                      rounded={s.kind === "artist" ? "rounded-full" : "rounded-md"}
                      className="w-11 h-11 shrink-0"
                      iconClassName="w-4 h-4"
                      alt=""
                    />
                    <span className="min-w-0 flex-1">
                      <FitText text={s.text} className="text-[14px] font-semibold text-ink-hi" />
                      <FitText text={s.subtitle ?? ""} className="text-[12px] text-ink-hi/55 mt-0.5" />
                    </span>
                  </button>
                ) : (
                  <div
                    key={`t:${s.text}`}
                    data-active={activeIdx === i + 1}
                    data-menu-row=""
                    /* Whole row is the click target, as in Recent searches. */
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => submitSearch(s.text)}
                    className="fit-host relative w-full flex cursor-pointer items-center gap-3 pl-2.5 pr-1.5 h-11 rounded-[10px]"
                  >
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        submitSearch(s.text);
                      }}
                      className="min-w-0 flex-1 flex items-center gap-3 text-left cursor-pointer"
                    >
                      <Search className="w-4 h-4 text-ink-hi/55 shrink-0" />
                      <FitText text={s.text} className="text-[14px] text-ink-hi" />
                    </button>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        fillSuggestion(s.text);
                      }}
                      title="Fill in"
                      aria-label={`Fill in "${s.text}"`}
                      className="p-1.5 rounded-full text-ink-hi/35 hover:text-ink-hi hover:bg-ink-hi/10 transition-colors cursor-pointer"
                    >
                      <ArrowUpLeft className="w-4 h-4" />
                    </button>
                  </div>
                )
              )}
              </div>
            </div>
          )}
          {/* Recent searches — BitChord mobile's model: an empty focused field
              drops the history list, with a clear-all in the header and a
              per-row ✕. Choosing a row runs that search. */}
          {historyOpen && (
            <div
              className="menu absolute left-0 right-0 top-full mt-2 z-50 max-h-[420px] overflow-y-auto"
              style={{ "--menu-origin": "top center" } as React.CSSProperties}
              role="listbox"
              aria-label="Recent searches"
            >
              <div className="flex items-center justify-between pl-3 pr-1.5 h-9">
                <span className="text-[12px] font-semibold text-ink-hi/45">Recent searches</span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearSearches}
                  className="px-2.5 h-7 rounded-full text-[12px] font-medium text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
                >
                  Clear all
                </button>
              </div>
              <div className="menu-list" {...recentLight.track}>
              {recentLight.light}
              {recents.map((q) => (
                <div
                  key={q}
                  data-menu-row=""
                  /* Whole row is the click target: the inner button only spans
                     its content height, so the rest of the highlighted row
                     showed the arrow cursor and ate clicks. */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => submitSearch(q)}
                  onContextMenu={(e) => {
                    // The menu takes over from the dropdown, as a typeahead row's does.
                    e.preventDefault();
                    closeDropdown();
                    setFieldFocused(false);
                    inputRef.current?.blur();
                    useUI.getState().openContextMenu(e.clientX, e.clientY, [
                      { label: `Search "${q}"`, icon: Search, action: () => submitSearch(q) },
                      { label: "Remove from recent searches", icon: X, separatorBefore: true, action: () => removeSearch(q) },
                    ]);
                  }}
                  className="fit-host group relative w-full flex cursor-pointer items-center gap-3 pl-2.5 pr-1.5 h-11 rounded-[10px]"
                >
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      submitSearch(q);
                    }}
                    className="min-w-0 flex-1 flex items-center gap-3 text-left cursor-pointer"
                  >
                    <History className="w-4 h-4 text-ink-hi/55 shrink-0" />
                    <FitText text={q} className="text-[14px] text-ink-hi" />
                  </button>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSearch(q);
                    }}
                    title="Remove"
                    aria-label={`Remove "${q}" from recent searches`}
                    className="p-1.5 rounded-full text-ink-hi/35 hover:text-ink-hi hover:bg-ink-hi/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              </div>
            </div>
          )}
          {/* Spotify's right side of the field: clear (once there's text), a
              hairline divider, and the Explore (browse) button. Clearing
              from the results view would leave the empty search shell
              behind, so it hops home instead; from any other view it just
              wipes the field and stays put. */}
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2.5">
            {query.trim() !== "" && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery("");
                  closeDropdown();
                  setSuggests([]);
                  setFieldFocused(false);
                  inputRef.current?.blur();
                  if (view.name === "search") navigate({ name: "home" });
                }}
                title="Clear search"
                aria-label="Clear search"
                className="p-1.5 rounded-full text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
              >
                <X className="w-[18px] h-[18px]" />
              </button>
            )}
            <div className="h-6 w-px bg-ink-hi/20" />
            <button
              onClick={() => navigate({ name: "explore" })}
              title="Explore"
              aria-label="Explore"
              className={`p-1.5 rounded-full transition-colors ${
                view.name === "explore"
                  ? "text-ink-hi bg-ink-hi/[0.10]"
                  : "text-ink-hi/70 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              }`}
            >
              <Compass className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {/* Right cluster — user badge, then (Windows only) the renderer-drawn
          caption buttons flush to the window edge. macOS uses the native
          traffic lights, so nothing is drawn here. */}
      <div className="ml-auto h-full flex items-center gap-1 shrink-0">
        <div className="app-no-drag flex items-center gap-1">
          <UpdateChip />
          <StreakChip />
        </div>
        <div className="app-no-drag ml-1 mr-2 flex items-center">
          <Avatar onClick={toggleSettings} active={settingsShown} />
        </div>
        {!isMac && <CaptionButtons />}
      </div>
    </div>
  );
}
