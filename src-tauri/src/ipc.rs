//! The one Tauri command the UI calls: `ipc(channel, args)`.
//!
//! It mirrors ByTune's `ipcMain.handle` / `ipcMain.on` channels (main.ts) so the
//! React UI keeps its exact API (`src/shared/api.ts`). Inputs are validated
//! here, as ByTune's main process did, before they reach a module.

use crate::state::AppState;
use crate::ytm::Track;
use crate::{downloads, pip, proxy};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

type Res = Result<Value, String>;

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn arg_str(args: &[Value], i: usize) -> String {
    arg(args, i).as_str().unwrap_or("").to_string()
}

fn opt_str(args: &[Value], i: usize) -> Option<String> {
    arg(args, i).as_str().map(String::from).filter(|s| !s.is_empty())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn is_video_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn safe_file_name(name: &str, fallback: &str) -> String {
    let re = regex::Regex::new(r#"[\\/:*?"<>|\x00-\x1f]+"#).unwrap();
    let s: String = re.replace_all(name, " ").trim().chars().take(100).collect();
    if s.is_empty() { fallback.to_string() } else { s }
}

/// A native dialog runs on a blocking thread so the async runtime keeps serving.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(err)
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

/* ---------------- backup ---------------- */

const DEVICE_LOCAL_SETTINGS: &[&str] = &["downloadDir", "localMusicFolder", "audioSinkId", "lyricsOffset", "closeToTray"];

fn envelope_state(v: &Value) -> serde_json::Map<String, Value> {
    v.get("state").and_then(|s| s.as_object()).cloned().or_else(|| v.as_object().cloned()).unwrap_or_default()
}

async fn backup_export(app: &AppHandle, state: &AppState) -> Res {
    let mut settings = envelope_state(&state.persist.read("settings"));
    for k in DEVICE_LOCAL_SETTINGS {
        settings.remove(*k);
    }
    let searches = state.persist.read("recent-searches");
    let searches = searches.pointer("/state/searches").cloned().unwrap_or(json!([]));
    let listening = state.persist.read(crate::stats::HISTORY_STORE).pointer("/state/buckets").cloned().unwrap_or(json!([]));
    let now = chrono::Utc::now();
    let file = json!({
        "app": "bytune", "version": 1, "exportedAt": now.to_rfc3339(),
        "settings": settings, "library": state.persist.read("library"), "player": state.persist.read("player"),
        "recentSearches": searches, "listening": listening,
    });
    let app = app.clone();
    let name = format!("bytune-backup-{}.json", now.format("%Y-%m-%d"));
    let path = blocking(move || app.dialog().file().set_title("Export ByTune backup").set_file_name(&name).add_filter("Backup", &["json"]).blocking_save_file())
        .await?;
    let Some(path) = path.and_then(|p| p.into_path().ok()) else { return Ok(json!({ "cancelled": true })) };
    tokio::fs::write(&path, serde_json::to_string_pretty(&file).map_err(err)?).await.map_err(err)?;
    Ok(json!({ "path": path }))
}

async fn backup_import(app: &AppHandle, state: &AppState) -> Res {
    let app = app.clone();
    let path = blocking(move || app.dialog().file().set_title("Import ByTune backup").add_filter("Backup", &["json"]).blocking_pick_file()).await?;
    let Some(path) = path.and_then(|p| p.into_path().ok()) else { return Ok(json!({ "cancelled": true })) };
    let meta = tokio::fs::metadata(&path).await.map_err(err)?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("That backup file is too large to import".into());
    }
    let doc: Value = serde_json::from_str(&tokio::fs::read_to_string(&path).await.map_err(err)?).map_err(|_| "That doesn't look like a ByTune backup")?;
    if doc["app"] != "bytune" && doc["app"] != "hitune" {
        return Err("That backup is from another app".into());
    }
    if doc["version"].as_f64().map(|v| v > 1.0).unwrap_or(true) {
        return Err("That backup was written by a newer version".into());
    }
    let mut settings = envelope_state(&state.persist.read("settings"));
    if let Some(incoming) = doc["settings"].as_object() {
        for (k, v) in incoming {
            if !DEVICE_LOCAL_SETTINGS.contains(&k.as_str()) {
                settings.insert(k.clone(), v.clone());
            }
        }
    }
    state.persist.write("settings", &json!({ "state": settings, "version": 0 })).await.map_err(err)?;
    for (key, store) in [("library", "library"), ("player", "player")] {
        if !doc[key].is_null() {
            let st = envelope_state(&doc[key]);
            state.persist.write(store, &json!({ "state": st, "version": doc[key]["version"].as_i64().unwrap_or(0) })).await.map_err(err)?;
        }
    }
    if let Some(searches) = doc["recentSearches"].as_array() {
        state.persist.write("recent-searches", &json!({ "state": { "searches": searches }, "version": 0 })).await.map_err(err)?;
    }
    let mut months = 0;
    if let Some(buckets) = doc["listening"].as_array() {
        let buckets: Vec<Value> = buckets.iter().filter(|b| b["month"].is_string()).take(36).cloned().collect();
        months = buckets.len();
        state.persist.write(crate::stats::HISTORY_STORE, &json!({ "state": { "buckets": buckets }, "version": 1 })).await.map_err(err)?;
        state.stats.reset();
    }
    state.note_library(None);
    Ok(json!({ "restored": true, "months": months }))
}

/* ---------------- the dispatcher ---------------- */

#[tauri::command]
pub async fn ipc(app: AppHandle, state: State<'_, Arc<AppState>>, channel: String, args: Vec<Value>) -> Res {
    let st: Arc<AppState> = state.inner().clone();
    let music = &st.music;
    match channel.as_str() {
        /* ---- music ---- */
        "music:search" => music.search_all(&arg_str(&args, 0)).await.map_err(err),
        "music:searchPage" => music.search_page(&arg_str(&args, 0), &arg_str(&args, 1)).await.map_err(err),
        "music:searchMore" => music.search_more(&arg_str(&args, 0), &arg_str(&args, 1)).await.map_err(err),
        "music:suggestions" => {
            let q = arg_str(&args, 0);
            if q.chars().count() > 200 {
                return Ok(json!({ "items": [] }));
            }
            Ok(music.suggestions(&q).await)
        }
        "music:artist" => music.artist_page(&arg_str(&args, 0)).await.map_err(err),
        "music:album" => music.album(&arg_str(&args, 0)).await.map_err(err),
        "music:playlist" => music.playlist(&arg_str(&args, 0)).await.map_err(err),
        "music:playlistPage" => music.playlist_page(&arg_str(&args, 0)).await.map_err(err),
        "music:home" => music.home().await.map_err(err),
        "music:radio" => {
            let id = arg_str(&args, 0);
            if !is_video_id(&id) {
                return Err("No radio for this track".into());
            }
            let token = opt_str(&args, 1).filter(|t| t.len() <= 4096);
            music.radio(&id, token.as_deref()).await.map_err(err)
        }
        "music:charts" => music.charts().await.map_err(err),
        "music:moods" => music.moods().await.map_err(err),
        "music:moodCovers" | "music:moodPage" => {
            let (browse_id, params) = (arg_str(&args, 0), arg_str(&args, 1));
            let params_ok = regex::Regex::new(r"^[A-Za-z0-9_%=-]{1,300}$").unwrap().is_match(&params);
            if browse_id != "FEmusic_moods_and_genres_category" || !params_ok {
                return Err("Not a mood page".into());
            }
            if channel == "music:moodPage" {
                music.mood_page(&browse_id, &params).await.map_err(err)
            } else {
                music.mood_covers(&browse_id, &params).await.map_err(err)
            }
        }
        "market:current" => Ok(music.current_market()),
        "music:lyrics" => {
            let meta: crate::lyrics::LyricsMeta = serde_json::from_value(arg(&args, 0).clone()).map_err(err)?;
            let local = if meta.id.starts_with("local:") { st.local_stream_path(&meta.id) } else { None };
            Ok(st.lyrics.get(music, meta, local).await)
        }
        "music:podcast" => {
            let id = arg_str(&args, 0);
            if !id.starts_with("MPSP") || id.len() > 90 {
                return Err("Not a podcast".into());
            }
            music.podcast(&id).await.map_err(err)
        }
        "music:podcasts" => music.podcasts().await.map_err(err),
        "local:gainDb" => {
            let id = arg_str(&args, 0);
            Ok(json!(if id.starts_with("local:") { st.library.track_by_id(&st.persist, &id).and_then(|t| t.gain_db) } else { None }))
        }
        "music:enrich" => {
            let ids: Vec<String> = arg(&args, 0).as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            Ok(music.enrich_durations(ids).await)
        }
        "music:stream" => {
            let id = arg_str(&args, 0);
            if !is_video_id(&id) {
                return Err("Invalid track id".into());
            }
            let retry = arg(&args, 1).as_bool() == Some(true);
            let max_kbps = if arg_str(&args, 2) == "low" { Some(64) } else { None };
            if retry {
                music.retry_stream(&id);
            }
            Ok(json!(proxy::url_for(st.port(), &id, retry, max_kbps)))
        }

        /* ---- local library ---- */
        "library:get" => Ok(json!(st.library.read(&st.persist))),
        "library:scan" => {
            let filter = arg(&args, 0).as_bool() != Some(false);
            st.library.scan(&st.persist, filter).await.map(|l| json!(l)).map_err(err)
        }
        "library:setFolders" | "library:addFolders" => {
            let paths: Vec<String> = arg(&args, 0).as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).take(8).collect()).unwrap_or_default();
            // Only folders approved through the native picker may enter the library.
            let approved: Vec<String> = paths.into_iter().filter(|p| st.is_approved(p)).collect();
            if channel == "library:setFolders" {
                st.library.set_folders(&st.persist, approved).await.map(|l| json!(l)).map_err(err)
            } else {
                st.library.add_folders(&st.persist, approved).await.map_err(err)
            }
        }
        "library:renameFolder" => st.library.rename_folder(&st.persist, &arg_str(&args, 0), &arg_str(&args, 1)).await.map(|l| json!(l)).map_err(err),
        "library:removeFolder" => st.library.remove_folder(&st.persist, &arg_str(&args, 0)).await.map(|l| json!(l)).map_err(err),
        "library:folderStatuses" => Ok(st.library.folder_statuses(&st.persist)),
        "library:trackurl" => {
            let id = arg_str(&args, 0);
            Ok(match st.local_stream_path(&id) {
                Some(_) => json!(proxy::url_for_local(st.port(), &id)),
                None => Value::Null,
            })
        }
        "library:artbytes" => Ok(json!(st.library.art_bytes(&arg_str(&args, 0)))),
        "art:remoteBytes" => Ok(json!(remote_art_bytes(&music.http, &arg_str(&args, 0)).await)),
        "files:take" => Ok(json!(std::mem::take(&mut *st.opened_batches.lock().unwrap()))),
        "files:dropped" => {
            let paths: Vec<String> = arg(&args, 0).as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).take(100).collect()).unwrap_or_default();
            open_files(&app, &st, paths).await;
            Ok(Value::Null)
        }
        "library:opened" => Ok(json!(st.library.opened_files(&st.persist))),
        "library:forgetOpened" => {
            let id = arg_str(&args, 0);
            if !id.starts_with("local:") {
                return Ok(json!(st.library.opened_files(&st.persist)));
            }
            st.library.forget_opened(&st.persist, &id).await.map(|l| json!(l)).map_err(err)
        }

        /* ---- canvas (canvas.rs) and updates (updater.rs) ---- */
        "canvas:get" => {
            let q = arg(&args, 0);
            let field = |k: &str| q[k].as_str().filter(|v| v.len() <= 500).unwrap_or("").to_string();
            Ok(crate::canvas::canvas_for(&st, &field("title"), &field("artist"), Some(field("album").as_str()).filter(|a| !a.is_empty())).await)
        }
        "updates:state" => Ok(json!(crate::updater::state(&app))),
        "updates:check" => {
            crate::updater::check(&app, false).await;
            Ok(Value::Null)
        }
        "updates:install" => {
            crate::updater::install(&app).await;
            Ok(Value::Null)
        }
        "updates:restart" => {
            crate::updater::restart(&app);
            Ok(Value::Null)
        }

        /* ---- Replay ---- */
        "playback:event" => {
            let ev = arg(&args, 0);
            let kind = ev["type"].as_str().unwrap_or("");
            let track: Option<Track> = serde_json::from_value(ev["track"].clone()).ok();
            if let Some(t) = track {
                if kind == "start" && !t.id.is_empty() {
                    st.stats.note_track_start(&t.id);
                }
                let delta = ev["deltaMs"].as_f64().unwrap_or(0.0);
                if matches!(kind, "progress" | "stop" | "pause") && t.episode != Some(true) && delta > 0.0 {
                    st.stats.record(&st.persist, &t, delta.min(10.0 * 60.0 * 1000.0));
                }
            }
            Ok(Value::Null)
        }
        "stats:summary" => Ok(st.stats.summary(&st.persist, &arg_str(&args, 0))),

        /* ---- window ---- */
        "window:minimize" => {
            if let Some(w) = main_window(&app) {
                let _ = w.minimize();
            }
            Ok(Value::Null)
        }
        "window:maximizeToggle" => {
            if let Some(w) = main_window(&app) {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
            Ok(Value::Null)
        }
        "window:close" => {
            if let Some(w) = main_window(&app) {
                let _ = w.close();
            }
            Ok(Value::Null)
        }
        "app:quitReady" => {
            crate::quit::finish(&app);
            Ok(Value::Null)
        }
        "window:introDone" => Ok(Value::Null),
        "window:isMaximized" => Ok(json!(main_window(&app).map(|w| w.is_maximized().unwrap_or(false)).unwrap_or(false))),
        "input:naturalScrolling" => Ok(Value::Null),
        "window:setOverlayChrome" => Ok(json!("unsupported")),
        "window:setFullScreen" => {
            if let Some(w) = main_window(&app) {
                let _ = w.set_fullscreen(arg(&args, 0).as_bool() == Some(true));
            }
            Ok(json!(true))
        }

        /* ---- mini player ---- */
        "pip:toggle" => Ok(json!(pip::toggle(&app, &st))),
        "pip:isOpen" => Ok(json!(pip::is_shown(&app))),
        "pip:close" => {
            pip::close(&app, &st);
            Ok(Value::Null)
        }
        "pip:minimize" => {
            pip::minimize(&app);
            Ok(Value::Null)
        }
        "pip:compact" => {
            pip::set_compact(&app, &st, arg(&args, 0).as_bool() == Some(true));
            Ok(Value::Null)
        }
        "pip:show-main" => {
            if let Some(w) = main_window(&app) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok(Value::Null)
        }

        /* ---- persistence ---- */
        "data:read" => {
            let name = arg_str(&args, 0);
            if !crate::persist::RENDERER_STORES.contains(&name.as_str()) {
                return Err("Store not allowed".into());
            }
            Ok(st.persist.read(&name))
        }
        "data:write" => {
            let name = arg_str(&args, 0);
            if !crate::persist::RENDERER_STORES.contains(&name.as_str()) {
                return Err("Store not allowed".into());
            }
            let data = arg(&args, 1);
            st.persist.write(&name, data).await.map_err(err)?;
            if name == "library" {
                st.note_library(Some(data));
            }
            Ok(Value::Null)
        }
        "app:resetData" => {
            st.spotify.forget_everyone(&app, &st).await;
            st.downloads().reset();
            st.stats.reset();
            st.library.reset();
            st.persist.reset().await.map_err(err)?;
            st.note_library(None);
            Ok(Value::Null)
        }

        /* ---- filesystem ---- */
        "app:defaultDownloadDir" => Ok(json!(st.downloads().default_dir)),
        "app:pickFolder" => {
            let a = app.clone();
            let dir = blocking(move || a.dialog().file().set_title("Choose a folder").blocking_pick_folder()).await?;
            let dir = dir.and_then(|d| d.into_path().ok());
            if let Some(d) = &dir {
                st.approve_dir(d);
            }
            Ok(json!(dir))
        }
        "app:revealPath" => {
            let p = arg_str(&args, 0);
            if !p.is_empty() && st.is_approved(&p) {
                let _ = app.opener().reveal_item_in_dir(&p);
            }
            Ok(Value::Null)
        }
        "app:openPath" => {
            let p = arg_str(&args, 0);
            if !p.is_empty() && st.is_approved(&p) {
                return Ok(match app.opener().open_path(&p, None::<&str>) {
                    Ok(()) => json!(""),
                    Err(e) => json!(e.to_string()),
                });
            }
            Ok(json!("Not allowed"))
        }

        /* ---- downloads ---- */
        "download:start" => {
            let track: Track = serde_json::from_value(arg(&args, 0).clone()).map_err(err)?;
            if !is_video_id(&track.id) {
                return Err("Only YouTube Music songs can be downloaded".into());
            }
            let dir = opt_str(&args, 1);
            if let Some(d) = &dir {
                if !st.is_approved(d) {
                    return Err("Download folder not approved".into());
                }
            }
            let export = arg(&args, 3).as_bool() == Some(true);
            let caps = match arg_str(&args, 2).as_str() {
                "standard" => Some(128),
                "high" => Some(192),
                _ => None,
            };
            st.downloads().enqueue(music.clone(), track, dir, caps, export)
        }
        "download:cancel" => Ok(json!(st.downloads().cancel(&arg_str(&args, 0)))),
        "download:queue" => Ok(st.downloads().snapshot()),

        /* ---- backup and playlist files ---- */
        "backup:export" => backup_export(&app, &st).await,
        "backup:import" => backup_import(&app, &st).await,
        "playlist:export" => {
            let (name, m3u8, js) = (arg_str(&args, 0), arg_str(&args, 1), arg_str(&args, 2));
            if m3u8.len() > 5 * 1024 * 1024 || js.len() > 5 * 1024 * 1024 {
                return Err("Playlist too large to export".into());
            }
            let file_name = format!("{}.m3u8", safe_file_name(&name, "playlist"));
            let a = app.clone();
            let path = blocking(move || {
                a.dialog()
                    .file()
                    .set_title("Export playlist")
                    .set_file_name(&file_name)
                    .add_filter("Playlist (M3U8)", &["m3u8"])
                    .add_filter("ByTune playlist (JSON)", &["json"])
                    .blocking_save_file()
            })
            .await?;
            let Some(path) = path.and_then(|p| p.into_path().ok()) else { return Ok(json!({ "cancelled": true })) };
            let body = if path.extension().map(|e| e.eq_ignore_ascii_case("json")).unwrap_or(false) { js } else { m3u8 };
            tokio::fs::write(&path, body).await.map_err(err)?;
            Ok(json!({ "path": path }))
        }
        "playlist:import" => {
            let a = app.clone();
            let path = blocking(move || {
                a.dialog().file().set_title("Import playlist").add_filter("Playlists and song lists", &["m3u8", "m3u", "json", "csv", "txt"]).blocking_pick_file()
            })
            .await?;
            let Some(path) = path.and_then(|p| p.into_path().ok()) else { return Ok(Value::Null) };
            if tokio::fs::metadata(&path).await.map_err(err)?.len() > 5 * 1024 * 1024 {
                return Err("That file is too large for a playlist".into());
            }
            let text = tokio::fs::read_to_string(&path).await.map_err(err)?;
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            Ok(json!({ "name": name, "ext": ext, "text": text }))
        }
        "replay:saveImage" => {
            let png = png_bytes(arg(&args, 0))?;
            let file_name = format!("{}.png", safe_file_name(&arg_str(&args, 1), "ByTune Replay"));
            let a = app.clone();
            let path = blocking(move || a.dialog().file().set_title("Save your Replay").set_file_name(&file_name).add_filter("PNG image", &["png"]).blocking_save_file()).await?;
            let Some(mut path) = path.and_then(|p| p.into_path().ok()) else { return Ok(json!({ "cancelled": true })) };
            if !path.extension().map(|e| e.eq_ignore_ascii_case("png")).unwrap_or(false) {
                path.set_extension("png");
            }
            tokio::fs::write(&path, png).await.map_err(err)?;
            Ok(json!({ "path": path }))
        }
        "replay:copyImage" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let png = png_bytes(arg(&args, 0))?;
            let image = tauri::image::Image::from_bytes(&png).map_err(err)?;
            app.clipboard().write_image(&image).map_err(err)?;
            Ok(json!(true))
        }

        /* ---- Spotify ---- */
        "spotify:publicPlaylist" => {
            let link = arg_str(&args, 0);
            if link.len() > 500 {
                return Err("That isn't a link to a Spotify playlist.".into());
            }
            st.spotify.public_playlist(&music.http, &st.persist, &link).await
        }
        "spotify:status" => Ok(st.spotify.status(&st)),
        "spotify:connect" => Ok(st.spotify.connect(&app, &music.http, &st).await),
        "spotify:disconnect" => {
            st.spotify.disconnect(&app, &st).await;
            Ok(json!(true))
        }
        "spotify:playlists" => st.spotify.playlists(&music.http, &st).await,
        "spotify:playlist" => {
            let id = arg_str(&args, 0);
            let ok = id == crate::spotify::LIKED_ID || (id.len() == 22 && id.chars().all(|c| c.is_ascii_alphanumeric()));
            if !ok {
                return Err("Not a Spotify playlist".into());
            }
            st.spotify.playlist(&music.http, &st, &id).await
        }
        // A guest who creates an account brings their Spotify along (src/cloud/index.ts).
        "spotify:moveGuest" => {
            let owner = arg_str(&args, 0);
            if owner.len() == 36 && owner.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                st.spotify.move_guest(&st, &owner).await;
            }
            Ok(Value::Null)
        }
        "match:song" => {
            let song: crate::spotify::ImportSong = serde_json::from_value(arg(&args, 0).clone()).map_err(|_| "Not a song")?;
            if song.title.trim().is_empty() || song.title.len() > 300 || song.artist.len() > 300 {
                return Err("Not a song".into());
            }
            st.spotify.match_song(music, &st.persist, song, &arg_str(&args, 1)).await
        }

        // Web links from the page (window.open): http(s) only, to the default browser.
        "app:openExternal" => {
            let url = arg_str(&args, 0);
            match url::Url::parse(&url) {
                Ok(u) if matches!(u.scheme(), "https" | "http") && url.len() <= 4096 => {
                    app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())?;
                    Ok(Value::Null)
                }
                _ => Err("Only web links open in the browser".into()),
            }
        }

        /* ---- accounts, cloud sync and Rooms: the page's src/cloud/ owns them; these are its backend ---- */
        "room:takeInvite" => Ok(json!(crate::links::take_invite(&app))),
        "auth:takeOAuthCallbacks" => Ok(json!(crate::links::take_oauth(&app))),
        "auth:loadSession" => Ok(crate::cloud::load_session(&st)),
        "auth:saveSession" => {
            crate::cloud::save_session(&st, arg(&args, 0)).await.map_err(err)?;
            Ok(Value::Null)
        }
        "cloud:read" => {
            let name = arg_str(&args, 0);
            if !crate::cloud::store_allowed(&name) {
                return Err("Store not allowed".into());
            }
            if name == crate::stats::HISTORY_STORE {
                crate::cloud::flush_history(&app, &st).await.map_err(err)?;
            }
            Ok(st.persist.read(&name))
        }
        "cloud:write" => {
            let name = arg_str(&args, 0);
            if !crate::cloud::store_allowed(&name) {
                return Err("Store not allowed".into());
            }
            let data = arg(&args, 1);
            st.persist.write(&name, data).await.map_err(err)?;
            match name.as_str() {
                "library" => st.note_library(if data.is_null() { None } else { Some(data) }),
                // Replay's history was replaced (a restore, an account switch): drop what memory held,
                // or its next flush would write the old copy back over it.
                n if n == crate::stats::HISTORY_STORE => st.stats.reset(),
                _ => {}
            }
            Ok(Value::Null)
        }
        "cloud:backup" => {
            crate::cloud::backup_store(&st, &arg_str(&args, 0), arg(&args, 1)).await.map_err(err)?;
            Ok(Value::Null)
        }

        /* ---- tray / MPRIS ---- */
        "menu:push-state" => {
            let playing = arg(&args, 0)["playing"].as_bool() == Some(true);
            st.playing.store(playing, Ordering::Relaxed);
            crate::tray::update(&app, playing);
            Ok(Value::Null)
        }
        // MPRIS comes from WebKitGTK (navigator.mediaSession), so these Windows-flyout channels are no-ops.
        "media:metadata" | "media:position" => Ok(Value::Null),

        other => {
            log::warn!("unknown ipc channel: {other}");
            Err(format!("Unknown channel {other}"))
        }
    }
}

/// Only real PNG bytes (from the Replay share card) pass.
fn png_bytes(v: &Value) -> Result<Vec<u8>, String> {
    let bytes: Vec<u8> = v.as_array().ok_or("Invalid image")?.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect();
    if bytes.len() < 8 || bytes.len() > 20 * 1024 * 1024 || bytes[..8] != [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Err("Not a PNG image".into());
    }
    Ok(bytes)
}

/// YouTube's thumbnail host sends no CORS header; the UI reads colours from these bytes instead.
async fn remote_art_bytes(http: &reqwest::Client, raw: &str) -> Option<Vec<u8>> {
    let re = regex::Regex::new(r"^https://i\d?\.ytimg\.com/").unwrap();
    if !re.is_match(raw) {
        return None;
    }
    let res = http.get(raw).timeout(std::time::Duration::from_secs(8)).send().await.ok()?;
    let is_image = res.headers().get("content-type").and_then(|c| c.to_str().ok()).map(|c| c.starts_with("image/")).unwrap_or(false);
    if !res.status().is_success() || !is_image {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    (bytes.len() <= 4 * 1024 * 1024).then(|| bytes.to_vec())
}

/// Audio files handed to ByTune (command line, "Open with"): read, queued for the UI, and announced.
pub async fn open_files(app: &AppHandle, st: &Arc<AppState>, paths: Vec<String>) {
    let paths: Vec<String> = paths.into_iter().filter(|p| Path::new(p).is_absolute() && p.len() < 4096).collect();
    if paths.is_empty() {
        return;
    }
    for p in &paths {
        if let Some(parent) = PathBuf::from(p).parent() {
            st.approve_dir(parent);
        }
    }
    match st.library.open_files(&st.persist, paths).await {
        Ok(batch) => {
            st.opened_batches.lock().unwrap().push(batch);
            let _ = app.emit("files:opened", ());
        }
        Err(e) => log::warn!("opening files failed: {e}"),
    }
}

pub fn download_event(app: &AppHandle, st: &Arc<AppState>, e: Value) {
    if e["type"] == "done" {
        if let (Some(id), Some(path)) = (e["id"].as_str(), e["path"].as_str()) {
            st.note_downloaded(id, path);
        }
    }
    let _ = app.emit("download:event", e);
}

#[allow(dead_code)]
fn _assert_send(_: &downloads::Downloads) {}
