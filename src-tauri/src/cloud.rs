//! What the page's cloud module (src/cloud/: accounts, cloud sync, Rooms) needs from the backend.
//!
//! ByTune ran Supabase in Electron's main process. Here it runs in the main window with Supabase's own
//! client, and the backend keeps the parts a page can't: the signed-in session sealed in the OS
//! keychain (ByTune sealed it with safeStorage), the cloud's bookkeeping stores, pre-merge backups,
//! and Replay's history, which this backend records.

use crate::persist::RENDERER_STORES;
use crate::state::AppState;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const KEYRING_SERVICE: &str = "app.bytune.player";
const KEYRING_SESSION: &str = "supabase-session";
/// Where the session goes when the OS keychain isn't there (no Secret Service on a bare Linux
/// desktop): the data folder, as ByTune's `plain:` fallback did.
const PLAIN_STORE: &str = "auth";
const BACKUPS_KEPT: usize = 5;

/// The stores the cloud module may touch besides the page's own: its bookkeeping, and each
/// account's archived copies ("owner-<sha256>-<store>", src/cloud/transition.ts).
const CLOUD_STORES: &[&str] = &["profile", "sync-meta", "data-owner", "room-stash", "listening-history", "listen-journal", "home-engagement"];

pub fn store_allowed(name: &str) -> bool {
    if RENDERER_STORES.contains(&name) || CLOUD_STORES.contains(&name) {
        return true;
    }
    let Some(rest) = name.strip_prefix("owner-") else { return false };
    let (hash, store) = rest.split_at(rest.len().min(64));
    hash.len() == 64
        && hash.chars().all(|c| c.is_ascii_hexdigit())
        && store.strip_prefix('-').is_some_and(|s| RENDERER_STORES.contains(&s) || CLOUD_STORES.contains(&s))
}

/* ---------------- the session ---------------- */

fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_SESSION).ok()
}

pub fn load_session(st: &AppState) -> Value {
    if let Some(entry) = keyring_entry() {
        match entry.get_password() {
            Ok(raw) => return serde_json::from_str(&raw).unwrap_or(Value::Null),
            Err(keyring::Error::NoEntry) => {}
            Err(e) => log::info!("keychain unavailable, using the data folder: {e}"),
        }
    }
    let plain = st.persist.read(PLAIN_STORE);
    plain["plain"].as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null)
}

pub async fn save_session(st: &AppState, session: &Value) -> anyhow::Result<()> {
    let raw = if session.is_null() { None } else { Some(serde_json::to_string(session)?) };
    let mut sealed = false;
    if let Some(entry) = keyring_entry() {
        sealed = match &raw {
            Some(r) => entry.set_password(r).is_ok(),
            None => matches!(entry.delete_credential(), Ok(()) | Err(keyring::Error::NoEntry)),
        };
    }
    // Sealed in the keychain: no copy stays in the data folder. Otherwise the fallback keeps it.
    let plain = match (&raw, sealed) {
        (Some(r), false) => serde_json::json!({ "plain": r }),
        _ => Value::Null,
    };
    st.persist.write(PLAIN_STORE, &plain).await
}

/* ---------------- backups ---------------- */

/// A copy of a store about to be replaced by a sync, under data/backups; the newest few are kept.
pub async fn backup_store(st: &AppState, name: &str, payload: &Value) -> anyhow::Result<()> {
    if payload.is_null() || !store_allowed(name) {
        return Ok(());
    }
    let dir = st.persist.root().join("data").join("backups");
    tokio::fs::create_dir_all(&dir).await?;
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ");
    tokio::fs::write(dir.join(format!("{name}-{stamp}.json")), serde_json::to_vec(payload)?).await?;
    let prefix = format!("{name}-");
    let mut siblings: Vec<String> = std::fs::read_dir(&dir)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|f| f.starts_with(&prefix) && f.ends_with(".json"))
        .collect();
    siblings.sort();
    let excess = siblings.len().saturating_sub(BACKUPS_KEPT);
    for stale in &siblings[..excess] {
        let _ = tokio::fs::remove_file(dir.join(stale)).await;
    }
    Ok(())
}

/* ---------------- Replay's history ---------------- */

/// Replay's history was written by the backend: the page's sync engine is told, as ByTune's
/// stats.onStoreWrite told its sync, or Replay would upload once on sign-in and never again.
pub fn history_written(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("store:written", crate::stats::HISTORY_STORE);
    }
}

/// Writes what Replay holds in memory now (before a sync reads the store).
pub async fn flush_history(app: &AppHandle, st: &Arc<AppState>) -> anyhow::Result<()> {
    if let Some(payload) = st.stats.take_dirty_payload() {
        st.persist.write(crate::stats::HISTORY_STORE, &payload).await?;
        history_written(app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_stores() {
        assert!(store_allowed("library"));
        assert!(store_allowed("sync-meta"));
        assert!(store_allowed(&format!("owner-{}-library", "a".repeat(64))));
        assert!(!store_allowed(&format!("owner-{}-auth", "a".repeat(64))));
        assert!(!store_allowed("owner-abc-library"));
        assert!(!store_allowed("auth"));
        assert!(!store_allowed("../library"));
    }
}
