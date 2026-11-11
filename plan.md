# Plan: migrate the ByTune frontend from React/WebKitGTK to Rune

Written 2026-11-11. Rune facts come from the `anomalyco/rune` repository docs (README, crate READMEs,
WEB.md, CHANGELOG, PLAN.md) as read that day; parts of the core README and CHANGELOG were read only
in summary, and those points are marked "(unverified)". Nothing here has been tried in code yet.

## 1. Summary

- **What changes:** the UI stops being a web page inside WebKitGTK and becomes native Rust drawn on
  the GPU by Rune. Tauri, React, Tailwind and the `ipc` bridge go away; the Rust backend modules stay.
- **Why it could be worth it:** every smoothness problem found so far (main-thread animation, repaint
  cost at 2x, WebKit crashes, 300–500 MB web process) comes from WebKitGTK. Rune composites on the GPU
  and only draws frames while something moves.
- **Why it is risky:** Rune is pre-release with no versioned releases, and on Linux it has **no audio
  or video playback**, no documented fullscreen, and unconfirmed Indic text shaping. The app is about
  35,000 lines of TypeScript/CSS to rewrite, plus a new audio engine.
- **Recommendation:** do not commit to the full migration yet. Run the Phase 0 spike (section 5). It
  answers the four questions that can kill the project. Keep the current app shipping until the Rune
  build reaches parity.

## 2. What Rune is today

| Topic | State |
|---|---|
| Maturity | "Rune is pre-release. Pin a rev of `dev`." No releases, no version number, API stability not promised |
| Distribution | Git dependency: `rune = { git = "https://github.com/anomalyco/rune", rev = "<dev rev>" }`. Not confirmed on crates.io |
| License | MIT |
| Contributions | "We don't take pull requests" — bugs we hit can only be reported, not fixed upstream by us |
| Model | `fn view(s: &State, cx: &mut Cx<State>) -> El`; one app state struct; handlers get `&mut State` between frames; the view re-runs and is diffed. No signals, no CSS |
| Layout / style | Taffy flexbox; builder methods (`.size`, `.radius`, `.fill`, `.gradient`, `.shadow`, `.blur`); OKLCH theme tokens from JSON |
| Rendering | wgpu; on-demand frames, continuous only while an animation runs; occluded windows stop drawing |
| Text | Parley shaping, swash outlines, bundled Inter. Font fallback and Devanagari/Gurmukhi/CJK shaping on native: **not stated** |
| Linux windowing | winit 0.30, Wayland and X11. Needs `libxkbcommon`, `libwayland` |
| Components (`rune-kit`) | Button, TextInput, Select, Popover, Menu (context menus, submenus), Tooltip, Toast, List, virtualised Table and Tree, SegmentedControl, Combobox, Progress, SplitView/Sidebar shell |
| Animation | Springs, tweens, presence transitions, keyframe sequences, matched-element flights; honours reduced motion |
| Dev tools | Headless `--snap` screenshots, scripted runs, element-tree dump, opt-in hot reload |

## 3. Fit against ByTune

| ByTune needs | Rune on Linux | Consequence |
|---|---|---|
| Audio playback | Not supported ("playback isn't supported on this platform yet") | Build a Rust audio engine (section 6). Largest single piece of work |
| Animated cover video ("canvas") | Video not supported | Drop the feature on Linux, or decode frames ourselves later |
| Media keys / MPRIS | Came free from WebKit's `navigator.mediaSession` | Add an MPRIS crate (e.g. `souvlaki` or `mpris-server`) |
| Punjabi / Hindi lyrics and titles | Shaping and fallback not stated | **Spike item 1.** A blocker if it fails |
| Long lists (queue, playlists, search) | `.virtualize`, `virtual_rows`, Table | Good fit |
| Album-art grids | Images and flex layout exist; no grid example | Build from rows; verify |
| Remote cover images | "Rune has no HTTP client" (unverified) | Fetch with our existing `reqwest`, hand bytes to the image cache |
| Blurred cover backdrop | `.blur(sigma)`, `backdrop_blur` (max 4 per frame) | Should replace `softArt.ts` |
| Synced lyrics with fades and glide | Opacity tracks, springs, transitions | Building blocks only; verify at 100+ lines |
| Seek and volume sliders | No slider widget in `rune-kit` | Write our own from `.on_drag` and step handlers |
| Scrollbars | Not drawn | Write our own overlay thumb (we already do, `PanelScrollbar`) |
| Context menus, dialogs, toasts, tooltips | Present | Good fit |
| Drag songs onto playlists | Internal drag and drop present | Good fit |
| Drop files onto the window | `on_drop_files` (unverified) | Verify |
| Frameless window with our title bar | `borderless`, `window_drag` documented; Linux behaviour not stated | **Spike item 3** |
| Fullscreen Now Playing | Only a macOS API is documented | **Spike item 3.** May need direct winit access |
| Mini player (second, always-on-top window) | Multi-window exists; overlays are edge-anchored and never focused; Wayland can't set window position | **Spike item 4.** Likely a reduced feature |
| Tray icon | `Tray` behind the `dbus` feature | Should work; verify menu items and click |
| Text input (search, dialogs) | Present, IME preedit handled; Wayland text-input-v3 only planned | Fine for Latin; IME for Indic input unverified |
| Clipboard | Text copy/paste present | Good fit |

## 4. Target architecture

```
bytune/                        (Cargo workspace)
  crates/bytune-core/          backend, moved from src-tauri/src with Tauri removed
    music, ytm, innertube      catalog and streams
    proxy                      kept only if the audio engine wants an HTTP source
    lyrics, local_library, downloads, stats, spotify, persist
  crates/bytune-audio/         new: playback engine (section 6)
  crates/bytune-ui/            new: Rune app
    state/                     player, library, settings, ui (from src/stores)
    views/                     home, search, playlist, album, artist, ...
    components/                player bar, lists, cards, lyrics, now playing
    theme.json                 colours and type scale from tailwind.config.js / index.css
```

- **State:** the eleven zustand stores become plain structs inside one `AppState`. Persistence keeps
  the existing JSON files and shapes (`player.json`, `library.json`, `settings.json`, ...), so a
  user's data carries over untouched.
- **Backend calls:** the 88 `ipc` channels become direct async function calls on `bytune-core`.
  A tokio runtime runs in the background; results come back to the UI through Rune's waker
  (`AppHandle::update` / `poll`).
- **Logic ports:** the non-visual TypeScript in `src/lib` (recommendations, queue and shuffle,
  autoplay, lyric line selection, romanisation, formatting) is ported to Rust with unit tests
  written from the current behaviour first.

## 5. Phase 0 — spike (do this before anything else)

A throwaway Rune app, pinned to one `dev` rev, that answers four questions on this laptop
(KDE Wayland, 2x scale, AMD Vega 8).

1. **Text:** render real lyric lines in Gurmukhi, Devanagari and Latin at 54 px with a system
   fallback font. Pass: correct conjuncts and vowel signs, no fallback boxes.
2. **Lyrics performance:** 150 lines, per-line opacity fades and a glide on each line change,
   over a blurred full-screen cover. Pass: steady 60 fps through line changes, and near-zero CPU
   when nothing moves.
3. **Window:** frameless window with a custom drag region, minimise/maximise/close, and
   fullscreen in and out. Pass: all work on KDE Wayland.
4. **Second window and tray:** a small always-on-top window, and a tray icon with a menu.
   Pass: tray works; record exactly what the mini window can and cannot do.

Also measure: idle RAM, RAM with a 500-row virtual list of covers, cold start time.

**Decision after the spike**

- Items 1–3 pass → continue to Phase 1.
- Item 1 fails → stop; the app cannot show its users' lyrics.
- Item 2 fails → stop; the migration would not deliver its purpose.
- Item 3 fails → continue only if a winit-level workaround is found.
- Item 4 fails → continue, and plan the mini player as a compact mode of the main window.

## 6. The audio engine (new work, independent of the UI)

Today `src/lib/audio.ts` (1,805 lines) drives two HTML audio elements. It has to be rebuilt in Rust.

- **Recommended base:** GStreamer through `gstreamer-rs`. It is what WebKit uses underneath today,
  so the same streams and codecs are known to work, and the `.deb` already depends on the plugins.
- **Alternative:** `symphonia` + `cpal`: fewer system dependencies, but HTTP range streaming, seeking
  and gapless handling are ours to write.
- **Features to carry over:** play/pause with short ramps, seek, buffering state, two-deck crossfade
  and Automix, playback speed, 10-band EQ, loudness levelling, skip silence, sleep timer, resume
  position, stream failure retry and rotation, listening-time accounting for Replay.
- **Analysis:** `analysis.ts` (decode, loudness, beat grids) moves to Rust, where it can run on a
  worker thread instead of time-slicing the UI thread.
- **Sequencing:** this can be built and tested headless before any UI exists, and could even be
  wired into the current app first to de-risk it.

## 7. Phases after the spike

| Phase | Work | Source being replaced | Done when |
|---|---|---|---|
| 1. Core extraction | Move backend modules into `bytune-core`, remove Tauri types, add a typed API in place of `ipc.rs` | `src-tauri/src` (6,915 lines) | Current Tauri app still runs on top of `bytune-core` |
| 2. Audio engine | Section 6 | `audio.ts`, `analysis.ts`, `autoplay.ts`, `sleepTimer.ts` | Plays, seeks, crossfades and resumes from a CLI test harness |
| 3. State and logic | Stores, persistence, queue/shuffle, recommendations | `src/stores` (2,107), most of `src/lib` (12,470), `src/shared` (1,959) | Unit tests match current behaviour; old data files load |
| 4. Shell | Theme, window, title bar, sidebar, player bar, navigation, toasts, dialogs, context menu | `App.tsx`, `TopBar`, `Sidebar`, `PlayerBar`, `Controls`, `primitives`, `ContextMenu` | A song can be searched, played and controlled |
| 5. Lists and pages | Track list, cards, search, playlist, album, artist, liked, library, downloads, local music | `TrackList`, `Cards`, most of `src/views` (8,506) | Daily use is possible without the old app |
| 6. Lyrics and Now Playing | Synced lyrics, word sweep, fullscreen view, queue panel | `SyncedLyrics`, `LyricsCenter`, `NowPlaying`, `RightRail` | Matches the spike's frame rate with real data |
| 7. Secondary features | Home feed, Explore, Replay, Settings, onboarding, Spotify import, rooms, drag and drop, file drop | remaining views and components | Feature list in section 8 is checked off |
| 8. System integration | Tray, close-to-tray, single instance, MPRIS, file associations, mini player | `tray.rs`, `pip.rs`, `quit.rs`, `src/pip` (1,211) | Behaves like the current build from the desktop's side |
| 9. Packaging and switch | `.deb`/AppImage/rpm without WebKitGTK, side-by-side beta, then retire the React app | `tauri.conf.json`, bundling | Rune build is the installed one |

Phases 1–3 are useful even if the UI migration is abandoned: they leave a cleaner backend and an
audio engine that no longer depends on a browser.

## 8. Parity checklist

To be filled in during Phase 4 onward; one line per user-visible feature, ticked when it works in
the Rune build: playback controls, queue, shuffle/repeat, crossfade, EQ, lyrics (synced, word sweep,
romanised, timing nudge), Now Playing, search, library, playlists, liked songs, downloads, local
music, Replay, Home, Explore, moods, podcasts, Spotify import, rooms, settings, onboarding, backup
import/export, tray, close-to-tray, media keys, mini player, file open, drag and drop.

## 9. Risks

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| Rune API changes under us (pre-release, pin-a-rev) | High | Rework on every bump | Pin one rev; bump deliberately; keep Rune calls behind our own component layer |
| Upstream takes no pull requests | Certain | A Rune bug can block us | Keep a fork ready; avoid depending on unverified features |
| Indic text shaping or fallback is wrong | Unknown | Blocker | Spike item 1 |
| Linux fullscreen / frameless gaps | Medium | Now Playing degraded | Spike item 3; winit escape hatch |
| Mini player cannot float freely on Wayland | High | Feature reduced | Accept a compact mode instead |
| Audio engine regressions (crossfade, seeking, stream errors) | Medium | Core function | Build and test it first, headless; consider shipping it in the current app before the UI moves |
| No animated cover video | Certain | Feature lost on Linux | Decide whether it matters before starting |
| Rewrite stalls half-way | Medium | Two half-finished UIs | Keep the React app shippable until Phase 9; stop points after Phases 0 and 3 |

## 10. A cheaper alternative to weigh first

If the goal is only "smoother", most of the remaining cost is WebKitGTK's repaint path. Two smaller
options exist before a rewrite: keep trimming what repaints (as done on 2026-11-11, which took Now
Playing from about 3 fps to about 48 fps), or test the NVIDIA offload path. Neither removes the
WebKit crashes or its memory use; the migration does.

## 11. Next step

Approve Phase 0. It needs a new folder (for example `spike/rune`) and touches nothing in the
current app.
