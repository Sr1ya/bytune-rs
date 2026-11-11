//! ByTune — a Tauri + Rust port of the ByTune desktop music player (Linux, Windows, macOS).
//!
//! The React UI (src/) is ByTune's, talking to this backend through one
//! `ipc` command (ipc.rs). Modules:
//!   innertube/ytm/music  YouTube Music browse, search and streams (rustypipe)
//!   proxy                local 127.0.0.1 streaming proxy the <audio> element plays from
//!   lyrics               synced lyrics from several sources
//!   local_library        imported folders, tags and cover art
//!   downloads            offline .m4a downloads
//!   stats                Replay listening stats
//!   spotify              public playlist import + song matching
//!   pip, tray            mini player window, tray menu
//! Media keys come from the webview itself, off the page's navigator.mediaSession (MPRIS on Linux).

mod canvas;
mod cloud;
mod downloads;
mod han_fold;
mod innertube;
mod ipc;
mod links;
mod local_library;
mod lyrics;
mod music;
mod persist;
mod pip;
mod proxy;
mod quit;
mod spotify;
mod state;
mod stats;
mod tray;
mod updater;
mod ytm;

use state::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::http::{Response, StatusCode};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

/// The botguard helper ships next to the ByTune binary (a Tauri sidecar); in a dev
/// checkout it is also found on PATH by rustypipe itself.
fn botguard_bin() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(format!("rustypipe-botguard{}", std::env::consts::EXE_SUFFIX));
    candidate.exists().then_some(candidate)
}

/// The app was called HiTune (identifier `app.hitune.player`) before it became ByTune. On the first
/// run as ByTune, the old profile — library, settings, Replay history and the webview's own storage —
/// is copied into the new data folder. Copied, not moved: the old build keeps working if it is
/// still installed. Runs before the webview opens, so its storage is in place when the page loads.
fn adopt_legacy_profile(data_dir: &std::path::Path) {
    let Some(legacy) = data_dir.parent().map(|p| p.join("app.hitune.player")) else { return };
    if !legacy.join("data").is_dir() || data_dir.join("data").exists() {
        return;
    }
    fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let dest = to.join(entry.file_name());
            if kind.is_dir() {
                copy_tree(&entry.path(), &dest)?;
            } else if kind.is_file() && !dest.exists() {
                std::fs::copy(entry.path(), &dest)?;
            }
        }
        Ok(())
    }
    match copy_tree(&legacy, data_dir) {
        Ok(()) => log::info!("copied the HiTune profile from {}", legacy.display()),
        Err(e) => log::warn!("couldn't copy the HiTune profile from {}: {e}", legacy.display()),
    }
}

/// Minimized or hidden (closed to the tray): the page rests its decorative motion
/// (src/lib/motionRest.ts). Sent only when it changes.
pub(crate) fn note_asleep(w: &tauri::WebviewWindow) {
    static ASLEEP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let now = w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true);
    if ASLEEP.swap(now, std::sync::atomic::Ordering::Relaxed) != now {
        let _ = w.emit("window:asleep", now);
    }
}

/// Audio files among launch arguments ("Open with", a double-click, `bytune song.mp3`).
fn cli_files(args: &[String]) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && !a.starts_with("bytune://"))
        .filter_map(|a| std::path::absolute(a).ok())
        .filter(|p| p.is_file() && links::is_audio(p))
        .collect()
}

/// A dropped file's bytes from the page (Windows and macOS; see links.rs).
#[tauri::command]
async fn drop_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| urlencoding::decode(v).ok())
        .map(|v| v.into_owned())
        .unwrap_or_default();
    links::drop_file(&app, &name, bytes).await
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("bytune_lib=info")).format_timestamp_millis().init();

    tauri::Builder::default()
        // A second launch (Start menu, a shortcut, an audio file, a bytune:// link) brings back the
        // running window, from the tray too; its links reach the deep-link plugin, its files play.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            tray::show_main(app);
            links::queue_files(app, cli_files(&argv));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(updater::Updates::default())
        .manage(links::Links::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Local cover art: localart://<hash>.jpg (extracted by the library scan).
        .register_uri_scheme_protocol("localart", |ctx, request| {
            let uri = request.uri().to_string();
            let name = uri.trim_start_matches("localart://").trim_start_matches("localhost/").trim_matches('/').to_lowercase();
            let st = ctx.app_handle().state::<Arc<AppState>>();
            match st.library.art_path(&name).and_then(|p| std::fs::read(p).ok()) {
                Some(bytes) => Response::builder()
                    .header("Content-Type", if name.ends_with(".png") { "image/png" } else { "image/jpeg" })
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            adopt_legacy_profile(&data_dir);
            std::fs::create_dir_all(&data_dir)?;
            let persist = persist::Persist::new(&data_dir);
            let http = reqwest::Client::builder().gzip(true).brotli(true).connect_timeout(Duration::from_secs(10)).build()?;
            let music = music::Music::new(http, &data_dir, botguard_bin()).map_err(|e| e.to_string())?;
            let state = Arc::new(AppState::new(persist, music));

            // Downloads land in ~/Downloads/ByTune ("export" copies in ~/Music/ByTune). Songs saved
            // under the old HiTune folders stay playable.
            let home = app.path().home_dir()?;
            let downloads_root = app.path().download_dir().unwrap_or_else(|_| home.join("Downloads"));
            let music_root = app.path().audio_dir().unwrap_or_else(|_| home.join("Music"));
            let download_dir = downloads_root.join("ByTune");
            let export_dir = music_root.join("ByTune");
            state.approve_dir(&download_dir);
            state.approve_dir(&export_dir);
            for legacy in [downloads_root.join("HiTune"), music_root.join("HiTune")] {
                if legacy.is_dir() {
                    state.approve_dir(&legacy);
                }
            }
            let (h, s) = (handle.clone(), state.clone());
            let dl = downloads::Downloads::new(download_dir, export_dir, Arc::new(move |e| ipc::download_event(&h, &s, e)));
            let _ = state.downloads.set(dl);

            let port = tauri::async_runtime::block_on(proxy::start(state.clone())).map_err(|e| e.to_string())?;
            let _ = state.proxy_port.set(port);

            // Replay's history flushes every 30 s while it changes (each write is the whole history),
            // and on quit (quit.rs).
            let (h, s) = (handle.clone(), state.clone());
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    if let Err(e) = cloud::flush_history(&h, &s).await {
                        log::warn!("stats flush failed: {e}");
                    }
                }
            });

            app.manage(state.clone());
            updater::start(&handle);

            // Logout or shutdown (SIGTERM) quits like tray Quit: the page saves, Replay flushes.
            #[cfg(unix)]
            {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                        term.recv().await;
                        quit::request(&h);
                    }
                });
            }
            if let Err(e) = tray::create(&handle) {
                log::warn!("tray unavailable: {e}");
            }

            // bytune:// links: Google sign-in coming back, Rooms invites. Installers register the
            // scheme; a dev run or an AppImage registers it for itself.
            #[cfg(any(target_os = "linux", windows))]
            if cfg!(debug_assertions) || std::env::var_os("APPIMAGE").is_some() {
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("bytune:// links not registered: {e}");
                }
            }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    links::handle_url(&handle, url.as_str());
                }
            }
            let h = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    links::handle_url(&h, url.as_str());
                }
            });

            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("ByTune")
                .inner_size(1280.0, 820.0)
                .min_inner_size(1000.0, 640.0)
                .center();
            // Files dropped from a file manager: Linux reports their paths natively without touching
            // the page's own drags (songs onto playlists); on Windows and macOS the native handler would
            // capture those too, so it stays off and the page sends dropped files itself (links.rs).
            #[cfg(not(target_os = "linux"))]
            let builder = builder.disable_drag_drop_handler();
            // macOS keeps its own traffic-light buttons over the page's top bar (which leaves room for
            // them and draws no caption buttons there); elsewhere the page draws the whole title bar.
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            #[cfg(not(target_os = "macos"))]
            let builder = builder.decorations(false);
            let window = builder
                .background_color(tauri::window::Color(10, 10, 10, 255))
                .build()?;
            let w = window.clone();
            // Maximized / fullscreen go to the page only when they change: Resized fires for every
            // size step, and each event used to restart work in the page.
            let maximized = std::sync::atomic::AtomicU8::new(2);
            let fullscreen = std::sync::atomic::AtomicU8::new(2);
            let note_state = move |w: &tauri::WebviewWindow| {
                let m = w.is_maximized().unwrap_or(false);
                if maximized.swap(m as u8, std::sync::atomic::Ordering::Relaxed) != m as u8 {
                    let _ = w.emit("window:maximized", m);
                }
                let f = w.is_fullscreen().unwrap_or(false);
                if fullscreen.swap(f as u8, std::sync::atomic::Ordering::Relaxed) != f as u8 {
                    let _ = w.emit("window:fullscreen", f);
                }
            };
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Resized(_) => {
                    note_state(&w);
                    note_asleep(&w);
                }
                tauri::WindowEvent::Focused(_) => note_asleep(&w),
                tauri::WindowEvent::DragDrop(drag) => match drag {
                    tauri::DragDropEvent::Enter { paths, .. } => {
                        if paths.iter().any(|p| links::is_audio(p)) {
                            let _ = w.emit("files:drag", true);
                        }
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let _ = w.emit("files:drag", false);
                        links::queue_files(w.app_handle(), paths.clone());
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = w.emit("files:drag", false);
                    }
                    _ => {}
                },
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    // "Close to tray" (on unless switched off in Settings): the window goes, ByTune
                    // and the music stay, and the tray icon brings it back or quits. Without a tray
                    // icon there would be no way back, so closing quits: the windows hide now and
                    // the process ends once the page has saved (quit.rs).
                    let app = w.app_handle();
                    let to_tray = tray::available()
                        && app.state::<Arc<AppState>>().persist.read("settings").pointer("/state/closeToTray") != Some(&serde_json::Value::Bool(false));
                    if to_tray && !quit::quitting() {
                        let _ = w.hide();
                        note_asleep(&w);
                    } else {
                        quit::request(app);
                    }
                }
                _ => {}
            });

            links::queue_files(&handle, cli_files(&std::env::args().collect::<Vec<_>>()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::ipc, drop_file])
        .build(tauri::generate_context!())
        .expect("error while starting ByTune")
        .run(|app, event| match event {
            // Cmd+Q on macOS, or anything else ending the event loop, goes through the same save-then-exit
            // path as tray Quit (quit.rs ends the process itself).
            tauri::RunEvent::ExitRequested { api, .. } if !quit::quitting() => {
                api.prevent_exit();
                quit::request(app);
            }
            // macOS: clicking the Dock icon brings back a window closed to the tray.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows: false, .. } => tray::show_main(app),
            // macOS: Finder's Open With, or a double-click on an audio file ByTune opens. (bytune://
            // links arrive the same way and are the deep-link plugin's.)
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                links::queue_files(app, urls.iter().filter_map(|u| u.to_file_path().ok()).collect());
            }
            _ => {}
        });
}
