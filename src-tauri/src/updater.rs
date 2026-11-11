//! Updates — a port of ByTune's `electron/updater.ts`.
//!
//! The installed app asks GitHub for the newest release soon after launch, every six hours and on
//! "Check for updates", and says so when there's one: the button in the top bar, Settings › About,
//! and, once per version, a system notification.
//!
//! Where ByTune can replace itself (Windows, macOS, an AppImage) Update downloads the release's signed
//! package (Tauri's updater, `latest.json`), and Restart to update saves everything like a quit, puts
//! the new version in place and opens ByTune again. Nothing installs without that click. Installed
//! from a .deb or .rpm, the package manager owns the files, so Download opens the release page
//! instead — as it also does after a failed install.
//!
//! The check reads where github.com/…/releases/latest redirects to: no API, so no rate limit. A dev
//! run checks only with BYTUNE_UPDATE_TEST_VERSION set, and pretends to be that version.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const RELEASES: &str = "https://github.com/Sr1ya/bytune-rs/releases";
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const NOTIFIED_STORE: &str = "updates";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// idle | checking | current | available | downloading | ready | error
    status: &'static str,
    current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// This app installs updates itself; elsewhere Download opens the release page.
    installs: bool,
}

#[derive(Default)]
pub struct Updates {
    state: Mutex<UpdateState>,
    checking: Mutex<bool>,
    /// The downloaded, verified package, waiting for Restart to update.
    ready: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

/* ---------------- versions ---------------- */

fn parts(v: &str) -> Option<[u64; 3]> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split('.').map(|p| p.parse::<u64>().ok());
    let out = [it.next()??, it.next()??, it.next()??];
    it.next().is_none().then_some(out)
}

/// `tag` as a version when it's ahead of `current` ("v1.2.0" over "1.1.9" → "1.2.0").
pub fn newer_version(tag: &str, current: &str) -> Option<String> {
    let (a, b) = (parts(tag)?, parts(current)?);
    (a > b).then(|| format!("{}.{}.{}", a[0], a[1], a[2]))
}

/// The tag GitHub's /releases/latest redirects to (".../releases/tag/v1.2.0").
pub fn tag_from_location(location: &str) -> Option<String> {
    let re = regex::Regex::new(r"/releases/tag/([^/?#]+)/?$").ok()?;
    let tag = re.captures(location)?.get(1)?.as_str();
    urlencoding::decode(tag).ok().map(|t| t.into_owned())
}

/* ---------------- state ---------------- */

fn test_version() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var("BYTUNE_UPDATE_TEST_VERSION").ok().filter(|v| parts(v).is_some())
    } else {
        None
    }
}

fn enabled() -> bool {
    !cfg!(debug_assertions) || test_version().is_some()
}

/// Can this install replace itself? Not when a package manager owns the files.
fn installs_in_place() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        cfg!(any(windows, target_os = "macos"))
    }
}

fn set(app: &AppHandle, patch: impl FnOnce(&mut UpdateState)) {
    let snapshot = {
        let updates = app.state::<Updates>();
        let mut s = updates.state.lock().unwrap();
        patch(&mut s);
        s.clone()
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("updates:changed", snapshot);
    }
}

pub fn state(app: &AppHandle) -> UpdateState {
    app.state::<Updates>().state.lock().unwrap().clone()
}

/// Once per version, ever: a system notification, so an update shows while ByTune sits in the tray.
fn notify_once(app: &AppHandle, version: &str, installs: bool) {
    let st = app.state::<std::sync::Arc<crate::state::AppState>>().inner().clone();
    if st.persist.read(NOTIFIED_STORE)["notified"].as_str() == Some(version) {
        return;
    }
    let version_owned = version.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = st.persist.write(NOTIFIED_STORE, &serde_json::json!({ "notified": version_owned })).await;
    });
    let _ = app
        .notification()
        .builder()
        .title(format!("ByTune {version} is available"))
        .body(if installs { "Open ByTune to update." } else { "Open ByTune to download it." })
        .show();
}

/// Ask GitHub. An automatic check stays quiet: no "checking", no error, a notification when it finds one.
pub async fn check(app: &AppHandle, auto: bool) {
    if !enabled() {
        if !auto {
            set(app, |s| {
                s.status = "error";
                s.error = Some("Updates are checked in the installed app.".into());
            });
        }
        return;
    }
    let before = state(app);
    // One found and downloading or downloaded: nothing to ask until it's installed.
    if before.status == "downloading" || before.status == "ready" {
        return;
    }
    {
        let updates = app.state::<Updates>();
        let mut checking = updates.checking.lock().unwrap();
        if *checking {
            return;
        }
        *checking = true;
    }
    if !auto {
        set(app, |s| {
            s.status = "checking";
            s.error = None;
        });
    }
    let current = before.current.clone();
    let result: Result<Option<String>, String> = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .get(format!("{RELEASES}/latest"))
            .header("User-Agent", format!("ByTune/{current}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let location = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let tag = tag_from_location(&location).ok_or_else(|| format!("GitHub answered {}", res.status().as_u16()))?;
        Ok(newer_version(&tag, &current))
    }
    .await;
    *app.state::<Updates>().checking.lock().unwrap() = false;
    match result {
        Ok(None) => set(app, |s| {
            s.status = "current";
            s.version = None;
            s.percent = None;
            s.error = None;
        }),
        Ok(Some(version)) => {
            let installs = before.installs;
            set(app, |s| {
                s.status = "available";
                s.version = Some(version.clone());
                s.percent = None;
                s.error = None;
            });
            if auto {
                notify_once(app, &version, installs);
            }
        }
        Err(e) => {
            if auto {
                let back = if before.status == "checking" { "idle" } else { before.status };
                set(app, |s| s.status = back);
            } else {
                set(app, |s| {
                    s.status = "error";
                    s.error = Some(format!("Couldn't reach GitHub ({e})."));
                });
            }
        }
    }
}

/* ---------------- installing ---------------- */

fn open_release_page(app: &AppHandle) {
    let _ = app.opener().open_url(format!("{RELEASES}/latest"), None::<&str>);
}

/// Update: download and get it ready, or open the release page (a package-manager install, or after
/// an install that failed).
pub async fn install(app: &AppHandle) {
    let s = state(app);
    if s.status == "ready" {
        restart(app);
        return;
    }
    if s.status == "downloading" || s.version.is_none() {
        return;
    }
    if !s.installs || s.status == "error" {
        open_release_page(app);
        return;
    }
    set(app, |s| {
        s.status = "downloading";
        s.percent = Some(0);
        s.error = None;
    });
    let result: Result<(tauri_plugin_updater::Update, Vec<u8>), String> = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "the release has no update for this app yet".to_string())?;
        let mut got: u64 = 0;
        let handle = app.clone();
        let bytes = update
            .download(
                move |chunk, total| {
                    got += chunk as u64;
                    if let Some(total) = total.filter(|t| *t > 0) {
                        let pct = ((got * 100) / total).min(99) as u32;
                        if state(&handle).percent != Some(pct) {
                            set(&handle, |s| s.percent = Some(pct));
                        }
                    }
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok((update, bytes))
    }
    .await;
    match result {
        Ok(ready) => {
            *app.state::<Updates>().ready.lock().unwrap() = Some(ready);
            set(app, |s| {
                s.status = "ready";
                s.percent = Some(100);
            });
        }
        Err(e) => {
            log::warn!("update: {e}");
            set(app, |s| {
                s.status = "error";
                s.percent = None;
                s.error = Some("The update couldn't download. Download it from GitHub instead.".into());
            });
        }
    }
}

/// Restart to update: ByTune saves and quits as usual, the new version is put in place on the way
/// out, and the app opens again (on Windows the installer does that itself).
pub fn restart(app: &AppHandle) {
    let Some((update, bytes)) = app.state::<Updates>().ready.lock().unwrap().take() else { return };
    crate::quit::request_with(
        app,
        Box::new(move || {
            if let Err(e) = update.install(&bytes) {
                log::warn!("update install failed: {e}");
                return;
            }
            // Windows: install() has launched the installer and ended the process already.
            relaunch();
        }),
    );
}

/// Starts the new version a moment after this process is gone (the single-instance lock must be free).
fn relaunch() {
    let Ok(exe) = std::env::current_exe() else { return };
    // An AppImage relaunches the image, not the binary mounted from it.
    let target = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from).unwrap_or(exe);
    #[cfg(target_os = "macos")]
    let target = target
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(|p| p.to_path_buf())
        .unwrap_or(target);
    #[cfg(unix)]
    {
        let opener = if cfg!(target_os = "macos") && target.extension().is_some_and(|e| e == "app") {
            format!("open -n {}", shell_quote(&target.to_string_lossy()))
        } else {
            shell_quote(&target.to_string_lossy())
        };
        let _ = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("sleep 1; exec {opener}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

#[cfg(unix)]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Start checking: soon after launch, then every six hours.
pub fn start(app: &AppHandle) {
    let current = test_version().unwrap_or_else(|| app.package_info().version.to_string());
    *app.state::<Updates>().state.lock().unwrap() = UpdateState { status: "idle", current, installs: installs_in_place(), ..Default::default() };
    if !enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app, true).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(newer_version("v1.2.0", "1.1.9").as_deref(), Some("1.2.0"));
        assert_eq!(newer_version("v0.1.0", "0.1.0"), None);
        assert_eq!(newer_version("v0.1.0", "0.2.0"), None);
        assert_eq!(newer_version("nightly", "0.1.0"), None);
        assert_eq!(tag_from_location("https://github.com/Sr1ya/bytune-rs/releases/tag/v0.2.0").as_deref(), Some("v0.2.0"));
        assert_eq!(tag_from_location("https://github.com/Sr1ya/bytune-rs/releases"), None);
    }
}
