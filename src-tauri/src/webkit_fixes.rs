//! WebKitGTK workarounds for the app's webviews (Linux only).
//!
//! WebKitGTK 2.52's GPU painting (Skia "Ganesh") corrupts its heap when a GPU-backed <canvas> buffer
//! is torn down: every recorded WebKitWebProcess crash (SIGILL/SIGSEGV) runs through
//! `~HTMLCanvasElement` → `~ImageBufferSkiaAcceleratedBackend` → `~SkSurface_Ganesh` →
//! `GrResourceCache`, resolved with Ubuntu's debug symbols. The page's canvases are all small (40 px
//! cover blurs, palette sampling), so they're drawn on the CPU instead; the page itself keeps painting
//! on the GPU.
//!
//! Should the web process die anyway, the window would sit blank while ByTune ran on: it's reloaded.

#[cfg(target_os = "linux")]
pub fn apply(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let applied = window.with_webview(move |wv| {
        use webkit2gtk::glib::prelude::ObjectExt;
        use webkit2gtk::WebViewExt;
        let view = wv.inner();
        if let Some(settings) = view.settings() {
            if settings.find_property("enable-2d-canvas-acceleration").is_some() {
                settings.set_property("enable-2d-canvas-acceleration", false);
            }
        }
        let label = label.clone();
        view.connect_web_process_terminated(move |view, reason| {
            log::warn!("{label}: the web process ended ({reason:?}); reloading the page");
            view.reload();
        });
    });
    if let Err(e) = applied {
        log::warn!("webview workarounds not applied: {e}");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn apply(_window: &tauri::WebviewWindow) {}
