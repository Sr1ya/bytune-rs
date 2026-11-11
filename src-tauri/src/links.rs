//! What reaches ByTune from outside the window: `bytune://` links and audio files.
//!
//!   bytune://oauth/callback?code=…   Google sign-in coming back from the browser; the page's cloud
//!                                     module (src/cloud/auth.ts) finishes it with the PKCE verifier
//!   bytune://room/CODE               a Rooms invite; the page asks before joining
//!   files                            "Open with", a double-click on an associated file, a second
//!                                     launch with paths, or files dropped on the window
//!
//! Links that arrive before the page is listening are parked here and taken by the page when it
//! starts (`auth:takeOAuthCallbacks`, `room:takeInvite`), as ByTune's main process did.
//!
//! Dropped files: on Linux Tauri's native drop handler reports real paths and leaves the page's own
//! HTML5 drags (songs onto playlists) alone. On Windows and macOS that handler captures every drag,
//! which would break those, so it stays off there and the page sends the dropped files' bytes
//! instead (`drop_file`); they are kept under the app's data folder and opened from there.

use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// The file types ByTune plays (also the bundle's file associations, tauri.conf.json).
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "webm", "alac", "aiff", "aif", "wma"];

pub fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Default)]
pub struct Links {
    oauth: Mutex<Vec<String>>,
    invite: Mutex<Option<String>>,
    /// Files waiting to be opened together (ten files opened at once in a file manager play as one
    /// batch, in order).
    files: Mutex<Vec<String>>,
}

/// A Rooms code in a `bytune://room/CODE` link: letters and digits, as the server issues them.
fn room_code(url: &url::Url) -> Option<String> {
    if url.host_str() != Some("room") {
        return None;
    }
    let code: String = url.path().trim_matches('/').chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    (4..=12).contains(&code.len()).then(|| code.to_ascii_uppercase())
}

/// A `bytune://` link from the OS (a launch, a second launch, macOS open-url).
pub fn handle_url(app: &AppHandle, raw: &str) {
    let Ok(url) = url::Url::parse(raw) else { return };
    if url.scheme() != "bytune" || raw.len() > 4096 {
        return;
    }
    let links = app.state::<Links>();
    if let Some(code) = room_code(&url) {
        *links.invite.lock().unwrap() = Some(code);
        let _ = app.emit("room:invite", ());
        crate::tray::show_main(app);
        return;
    }
    if url.host_str() == Some("oauth") {
        {
            let mut parked = links.oauth.lock().unwrap();
            parked.push(raw.to_string());
            let excess = parked.len().saturating_sub(3);
            parked.drain(..excess);
        }
        let _ = app.emit("auth:oauthCallback", ());
        crate::tray::show_main(app);
    }
}

pub fn take_oauth(app: &AppHandle) -> Vec<String> {
    std::mem::take(&mut *app.state::<Links>().oauth.lock().unwrap())
}

pub fn take_invite(app: &AppHandle) -> Option<String> {
    app.state::<Links>().invite.lock().unwrap().take()
}

/// Audio files to open; gathered for a moment so files opened together play together.
pub fn queue_files(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| p.is_absolute() && p.is_file() && is_audio(p))
        .take(100)
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    if paths.is_empty() {
        return;
    }
    let links = app.state::<Links>();
    let first = {
        let mut queued = links.files.lock().unwrap();
        let first = queued.is_empty();
        queued.extend(paths);
        first
    };
    if !first {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let batch = std::mem::take(&mut *app.state::<Links>().files.lock().unwrap());
        let st = app.state::<Arc<AppState>>().inner().clone();
        crate::ipc::open_files(&app, &st, batch).await;
    });
}

/// Windows/macOS drop: one dropped file's bytes from the page, kept under the data folder (named by
/// content, so dropping the same file again reuses it) and opened like any other file.
pub async fn drop_file(app: &AppHandle, name: &str, bytes: &[u8]) -> Result<(), String> {
    use sha1::{Digest, Sha1};
    let name = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    if name.is_empty() || !is_audio(Path::new(&name)) {
        return Err("Not an audio file".into());
    }
    if bytes.is_empty() || bytes.len() > 1024 * 1024 * 1024 {
        return Err("That file is empty or too large".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("dropped");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let hash = hex::encode(Sha1::digest(bytes));
    let path = dir.join(format!("{}-{}", &hash[..12], name));
    if !path.exists() {
        let part = path.with_extension("part");
        tokio::fs::write(&part, bytes).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(&part, &path).await.map_err(|e| e.to_string())?;
    }
    queue_files(app, vec![path]);
    Ok(())
}
