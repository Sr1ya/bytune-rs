//! The mini player (picture-in-picture) window — a port of `electron/pip.ts`.
//!
//! A second, frameless, always-on-top window loads the same UI bundle with
//! `?window=pip`. Playback state and commands travel between the two windows as
//! app events emitted from the UI; this module only opens, closes, resizes and
//! remembers the window, and tells the main window when it opens or closes.

use crate::state::AppState;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "pip";
const DEFAULT_W: f64 = 352.0;
const DEFAULT_H: f64 = 353.0;
const MIN_W: f64 = 262.0;
const MIN_H: f64 = 233.0;
const MAX_W: f64 = 578.0;
const MAX_H: f64 = 574.0;
const BAR_W: f64 = 320.0;
const BAR_H: f64 = 110.0;
const REST_MARGIN: f64 = 16.0;
const RECT_STORE: &str = "pip-rect";

static COMPACT: AtomicBool = AtomicBool::new(false);

fn notify_main(app: &AppHandle, event: &str, payload: serde_json::Value) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(event, payload);
    }
}

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

pub fn is_shown(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).map(|w| !w.is_minimized().unwrap_or(false)).unwrap_or(false)
}

pub fn toggle(app: &AppHandle, state: &Arc<AppState>) -> bool {
    if let Some(win) = app.get_webview_window(LABEL) {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
            let _ = win.show();
            return true;
        }
        close(app, state);
        false
    } else {
        open(app, state);
        true
    }
}

fn save_rect(app: &AppHandle, state: &Arc<AppState>) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
    let compact = COMPACT.load(Ordering::Relaxed);
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
    let mut rect = json!({ "x": pos.x as f64 / scale, "y": pos.y as f64 / scale, "w": w, "h": h, "compact": compact });
    if compact {
        // Keep the square's size; the bar sits at its bottom-right corner.
        let prev = state.persist.read(RECT_STORE);
        let sw = prev["w"].as_f64().unwrap_or(DEFAULT_W);
        let sh = prev["h"].as_f64().unwrap_or(DEFAULT_H);
        rect = json!({ "x": pos.x as f64 / scale + BAR_W - sw, "y": pos.y as f64 / scale + BAR_H - sh, "w": sw, "h": sh, "compact": true });
    }
    let persist = state.clone();
    tauri::async_runtime::spawn(async move {
        let _ = persist.persist.write(RECT_STORE, &rect).await;
    });
}

pub fn open(app: &AppHandle, state: &Arc<AppState>) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        return;
    }
    let saved = state.persist.read(RECT_STORE);
    let compact = saved["compact"] == json!(true);
    COMPACT.store(compact, Ordering::Relaxed);
    let sw = saved["w"].as_f64().unwrap_or(DEFAULT_W).clamp(MIN_W, MAX_W);
    let sh = saved["h"].as_f64().unwrap_or(DEFAULT_H).clamp(MIN_H, MAX_H);
    let (w, h) = if compact { (BAR_W, BAR_H) } else { (sw, sh) };
    let url = WebviewUrl::App("index.html?window=pip".into());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, url)
        .title("ByTune Miniplayer")
        .inner_size(w, h)
        .min_inner_size(if compact { BAR_W } else { MIN_W }, if compact { BAR_H } else { MIN_H })
        .max_inner_size(if compact { BAR_W } else { MAX_W }, if compact { BAR_H } else { MAX_H })
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .maximizable(false)
        .visible(false)
        .disable_drag_drop_handler()
        .background_color(tauri::window::Color(0, 0, 0, 255));
    match (saved["x"].as_f64(), saved["y"].as_f64()) {
        (Some(x), Some(y)) => {
            let (x, y) = if compact { (x + sw - BAR_W, y + sh - BAR_H) } else { (x, y) };
            builder = builder.position(x, y);
        }
        _ => {
            if let Some(m) = app.primary_monitor().ok().flatten() {
                let scale = m.scale_factor();
                let size = m.size();
                let x = size.width as f64 / scale - w - REST_MARGIN;
                let y = size.height as f64 / scale - h - REST_MARGIN - 40.0;
                builder = builder.position(x.max(0.0), y.max(0.0));
            }
        }
    }
    let win = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            log::warn!("miniplayer failed to open: {e}");
            return;
        }
    };
    let _ = win.show();
    notify_main(app, "pip:open-changed", json!(true));
    notify_main(app, "pip:need-state", json!(null));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if is_open(&handle) {
            notify_main(&handle, "pip:need-state", json!(null));
        }
    });

    // Remember where it sits; tell the main window when it closes.
    let (h2, s2) = (app.clone(), state.clone());
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => save_rect(&h2, &s2),
        tauri::WindowEvent::Destroyed => notify_main(&h2, "pip:open-changed", json!(false)),
        _ => {}
    });

    // The OS cursor against the window: the one reliable inside/outside signal over its drag pad.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last: Option<bool> = None;
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let Some(win) = handle.get_webview_window(LABEL) else { break };
            let (Ok(cursor), Ok(pos), Ok(size)) = (handle.cursor_position(), win.outer_position(), win.outer_size()) else { continue };
            let p: PhysicalPosition<f64> = cursor;
            let inside = p.x >= pos.x as f64 && p.x < (pos.x + size.width as i32) as f64 && p.y >= pos.y as f64 && p.y < (pos.y + size.height as i32) as f64;
            if last != Some(inside) {
                last = Some(inside);
                let _ = win.emit("pip:cursor-inside", inside);
            }
        }
    });
}

pub fn close(app: &AppHandle, state: &Arc<AppState>) {
    save_rect(app, state);
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.destroy();
    }
    notify_main(app, "pip:open-changed", json!(false));
}

pub fn minimize(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.minimize();
        notify_main(app, "pip:open-changed", json!(false));
    }
}

/// The compact bar, or back to the square.
pub fn set_compact(app: &AppHandle, state: &Arc<AppState>, on: bool) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if COMPACT.load(Ordering::Relaxed) == on {
        return;
    }
    save_rect(app, state);
    let saved = state.persist.read(RECT_STORE);
    let sw = saved["w"].as_f64().unwrap_or(DEFAULT_W).clamp(MIN_W, MAX_W);
    let sh = saved["h"].as_f64().unwrap_or(DEFAULT_H).clamp(MIN_H, MAX_H);
    COMPACT.store(on, Ordering::Relaxed);
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = win.outer_position().ok().map(|p| (p.x as f64 / scale, p.y as f64 / scale));
    if on {
        let _ = win.set_min_size(Some(LogicalSize::new(BAR_W, BAR_H)));
        let _ = win.set_max_size(Some(LogicalSize::new(BAR_W, BAR_H)));
        let _ = win.set_size(LogicalSize::new(BAR_W, BAR_H));
        if let Some((x, y)) = pos {
            let _ = win.set_position(tauri::LogicalPosition::new(x + sw - BAR_W, y + sh - BAR_H));
        }
    } else {
        let _ = win.set_max_size(Some(LogicalSize::new(MAX_W, MAX_H)));
        let _ = win.set_min_size(Some(LogicalSize::new(MIN_W, MIN_H)));
        let _ = win.set_size(LogicalSize::new(sw, sh));
        if let Some((x, y)) = pos {
            let _ = win.set_position(tauri::LogicalPosition::new(x + BAR_W - sw, y + BAR_H - sh));
        }
    }
    save_rect(app, state);
}
