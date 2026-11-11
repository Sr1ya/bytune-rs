//! Quitting: the window close button, Alt+F4 and tray Quit all end here.
//!
//! The windows hide at once, so closing feels instant. The page is then asked to go quiet and hand
//! over its coalesced writes (src/main.tsx), and answers `app:quitReady` once they are on disk. Then
//! Replay's stats flush and the process ends, taking its WebKit children with it. Before this,
//! `app.exit(0)` ran straight away: the page's pending writes were lost, and a busy WebKitWebProcess
//! could keep running (and holding its RAM) for seconds after the window had gone, or the exit
//! itself could stall in teardown for ~10 s.

use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static QUITTING: AtomicBool = AtomicBool::new(false);
static FINISHING: AtomicBool = AtomicBool::new(false);
static EXITING: AtomicBool = AtomicBool::new(false);
/// Runs on the way out, once everything is saved (an update put in place, then ByTune reopened).
static ON_EXIT: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

/// True once quitting began: nothing should bring a window back.
pub fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// How long the page gets to save before the app quits without it.
const PAGE_GRACE: Duration = Duration::from_millis(2000);
/// The last-resort bound on the whole quit, stats flush included.
const HARD_LIMIT: Duration = Duration::from_millis(4000);

/// Starts quitting (once): hide every window, ask the page to save, and arm the fallbacks.
pub fn request(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    for w in app.webview_windows().values() {
        let _ = w.hide();
    }
    match app.get_webview_window("main") {
        Some(main) if main.emit("app:quit", ()).is_ok() => {}
        _ => finish(app),
    }
    // A page that never answers (hung, still booting) doesn't keep ByTune alive.
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PAGE_GRACE);
        finish(&h);
        std::thread::sleep(HARD_LIMIT - PAGE_GRACE);
        log::warn!("quit: stats flush overran, exiting anyway");
        exit_now();
    });
}

/// Quits like `request`, running `last` after every write is on disk and just before the process ends.
pub fn request_with(app: &AppHandle, last: Box<dyn FnOnce() + Send>) {
    *ON_EXIT.lock().unwrap() = Some(last);
    request(app);
}

/// The page has saved (or ran out of time): flush stats, then end the process.
pub fn finish(app: &AppHandle) {
    // Only as part of a quit (a stray `app:quitReady` must not end the app).
    if !quitting() || FINISHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let st = app.state::<Arc<AppState>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Some(payload) = st.stats.take_dirty_payload() {
            if let Err(e) = st.persist.write(crate::stats::HISTORY_STORE, &payload).await {
                log::warn!("stats flush on quit failed: {e}");
            }
        }
        exit_now();
    });
}

/// Every write is on disk by now (each store is written whole, atomically). Ends the WebKit helper
/// processes first, so none outlives the app, then leaves at once: `_exit`, not `exit`, so no atexit
/// handler or C++ static destructor (GLib, WebKitGTK, Mesa) runs under a main thread still dispatching
/// events, and two callers can't race through `exit`.
fn exit_now() -> ! {
    if EXITING.swap(true, Ordering::SeqCst) {
        loop {
            std::thread::park();
        }
    }
    kill_webkit_children();
    if let Some(last) = ON_EXIT.lock().ok().and_then(|mut f| f.take()) {
        last();
    }
    // SAFETY: _exit(2) ends the process immediately; nothing after it runs.
    #[cfg(unix)]
    unsafe {
        libc_exit(0);
    }
    // Windows: WebView2's helper processes end with this one.
    #[cfg(not(unix))]
    std::process::exit(0);
}

/// Linux: SIGKILL to this process's WebKit children (WebKitWebProcess, WebKitNetworkProcess): not to
/// any other child, such as the botguard helper or an `xdg-open` still handing a file over. Elsewhere
/// the webview's helper processes end with the app.
#[cfg(not(target_os = "linux"))]
fn kill_webkit_children() {}

#[cfg(target_os = "linux")]
fn kill_webkit_children() {
    let me = std::process::id().to_string();
    let Ok(entries) = std::fs::read_dir("/proc") else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.parse::<i32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        // "pid (comm) state ppid …" — comm may hold spaces or parentheses, so read after the last ')'.
        let ppid = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1));
        let webkit = std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|c| c.starts_with("WebKit")).unwrap_or(false);
        if ppid == Some(me.as_str()) && webkit {
            // SAFETY: plain kill(2) on a pid we just read as our own child.
            let _ = unsafe { libc_kill(pid, 9) };
        }
    }
}

#[cfg(target_os = "linux")]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[cfg(unix)]
extern "C" {
    #[link_name = "_exit"]
    fn libc_exit(code: i32) -> !;
}
