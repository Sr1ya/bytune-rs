# ByTune (bytune-rs)

A desktop music player for Linux, Windows and macOS: a **Tauri + Rust** rewrite of
[ByTune](https://github.com/rishiteja21/ByTune) (Electron). It plays the YouTube Music catalog and your own music files, with synced lyrics,
offline downloads, a mini player and Replay listening stats.

- **UI:** ByTune's React + TypeScript interface, unchanged apart from the backend bridge
  (`src/shared/api.ts`) and a few feature flags (`src/lib/features.ts`).
- **Backend:** Rust (`src-tauri/`), replacing ByTune's Electron main process.

## Downloads

Installers are built by GitHub Actions (`.github/workflows/release.yml`) for:

| Platform | Packages |
|---|---|
| Linux x86_64 | `.deb`, `.rpm`, `.AppImage` |
| Windows x64 | `.exe` (NSIS installer), `.msi` |
| macOS Apple Silicon and Intel | `.dmg`, `.app` |

Push a tag such as `v0.1.0` to build all of them and attach them to a draft GitHub release, or run
the workflow by hand (Actions → Release → Run workflow) to get them as build artifacts only.
The builds are not code-signed: Windows SmartScreen and macOS Gatekeeper warn on first launch
(macOS: right-click the app → Open).

## Build and run

Requirements on Linux (Ubuntu/Debian names):

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
curl https://sh.rustup.rs -sSf | sh     # Rust toolchain
npm install
```

The bundle includes `rustypipe-botguard` (a fallback stream helper) as a sidecar, named after
the Rust target it runs on. Build it once:

```bash
cargo install rustypipe-botguard --locked
mkdir -p src-tauri/binaries
cp ~/.cargo/bin/rustypipe-botguard src-tauri/binaries/rustypipe-botguard-$(rustc -vV | sed -n 's/host: //p')
# Windows: the copy is rustypipe-botguard-x86_64-pc-windows-msvc.exe
```

Then:

```bash
npm run app:dev      # development (Vite + hot-rebuilt Rust)
npm run app:build    # release installers for this OS in src-tauri/target/release/bundle/
```

Rust tests: `cd src-tauri && cargo test --lib`. Network tests against the live services:
`cargo test --lib -- --ignored --nocapture`.

## How it is put together

| ByTune (Electron, TypeScript)              | bytune-rs (Rust, `src-tauri/src/`)                       |
|--------------------------------------------|----------------------------------------------------------|
| `preload.ts` + `ipcMain` channels           | `src/shared/api.ts` → one `ipc` command → `ipc.rs`       |
| `ytm.ts` (InnerTube parsers)               | `ytm.rs` (line-by-line port)                             |
| `music-service.ts` (youtubei.js)           | `innertube.rs` + `music.rs`                              |
| BotGuard PO tokens in JSDOM                | not needed: VISIONOS / ANDROID_VR clients give plain URLs; rustypipe (+ botguard) as fallback |
| `stream-proxy.ts`                          | `proxy.rs` (axum on 127.0.0.1)                           |
| `lyrics.ts`                                | `lyrics.rs`                                              |
| `local-library.ts` (music-metadata)        | `local_library.rs` (lofty)                               |
| `downloads.ts` + `m4a-tags.ts`             | `downloads.rs` (lofty tags + cover)                      |
| `stats.ts`                                 | `stats.rs`                                               |
| `spotify*.ts` + `track-match.ts`           | `spotify.rs`                                             |
| `pip.ts`                                   | `pip.rs`                                                 |
| tray, `persist.ts`                         | `tray.rs`, `persist.rs`                                  |
| Windows media flyout (`media-controls.ts`) | the webview's own `navigator.mediaSession` (MPRIS on Linux) |

Audio plays in the webview's `<audio>` element (WebKitGTK and GStreamer on Linux, WebView2 on
Windows, WKWebView on macOS) from the local proxy,
so ByTune's audio engine (EQ, crossfade, Automix, leveling) works as-is.

## Not ported yet

- Accounts, cloud sync and Rooms (Supabase); the app runs as a local guest profile.
- Connecting a Spotify account (public playlist links still import).
- Lyrics sources: only BetterLyrics, YouTube captions, the YouTube Music lyrics tab and LRCLIB
  (ByTune asks 13 sources).
- Spotify Canvas videos, in-app updates, dropping files from the file manager onto the window
  (`bytune song.mp3` from the command line works; no file-manager association is registered yet).

Data lives in the app data folder for `app.bytune.player` (Linux: `~/.local/share/app.bytune.player/`);
downloads go to `~/Downloads/ByTune`. The app was called HiTune before: on its first run, ByTune
copies an existing `app.hitune.player` profile into its own folder.

## License

GPL-3.0, like ByTune (and rustypipe) — see `LICENSE`.
