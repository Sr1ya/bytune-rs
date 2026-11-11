//! System tray: open the window, play/pause, next, previous, quit
//! (ByTune's close-to-tray.ts buildTrayMenu). Commands reach the UI as `menu:command`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

static PLAY_ITEM: Mutex<Option<MenuItem<Wry>>> = Mutex::new(None);
static AVAILABLE: AtomicBool = AtomicBool::new(false);

/// True when the tray icon exists: only then may closing the window keep ByTune running behind it.
pub fn available() -> bool {
    AVAILABLE.load(Ordering::Relaxed)
}

pub fn show_main(app: &AppHandle) {
    if crate::quit::quitting() {
        return; // hidden for good: the process is about to end
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // Back from the tray: the page wakes its motion again.
        crate::note_asleep(&w);
    }
}

fn command(app: &AppHandle, cmd: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("menu:command", cmd);
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open ByTune", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "play-pause", "Play", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ByTune", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep1, &play, &next, &prev, &sep2, &quit])?;
    *PLAY_ITEM.lock().unwrap() = Some(play);
    let mut builder = TrayIconBuilder::with_id("main").tooltip("ByTune").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => crate::quit::request(app),
            id => command(app, id),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    AVAILABLE.store(true, Ordering::Relaxed);
    Ok(())
}

/// The Play/Pause label follows the player.
pub fn update(_app: &AppHandle, playing: bool) {
    if let Some(item) = PLAY_ITEM.lock().unwrap().as_ref() {
        let _ = item.set_text(if playing { "Pause" } else { "Play" });
    }
}
