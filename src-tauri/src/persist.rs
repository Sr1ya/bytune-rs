//! JSON persistence in the app data directory — a port of `electron/persist.ts`.
//! Each store is `<data>/data/<name>.json`, written atomically (temp file + rename),
//! with writes serialized so a later write never lands before an earlier one.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Persist {
    dir: PathBuf,
    root: PathBuf,
    write_lock: tokio::sync::Mutex<()>,
}

/// Stores the UI may read and write (ByTune's RENDERER_STORES, minus account-only ones).
pub const RENDERER_STORES: &[&str] = &[
    "settings",
    "library",
    "player",
    "recent-searches",
    "listening-signals",
    "artist-meta-cache",
    "artist-bundle-cache",
    "artist-about-cache",
    "lyrics-nudges",
    "recent-items",
    "listen-journal",
    "home-engagement",
    "track-matches",
];

/// Everything "Reset app data" removes.
const RESET_STORES: &[&str] = &[
    "player", "library", "settings", "recent-searches", "listening-signals", "listening-history", "artist-meta-cache",
    "artist-bundle-cache", "artist-about-cache", "profile", "local-library", "opened-files", "track-matches",
    "lyrics-nudges", "recent-items", "listen-journal", "home-engagement",
];

fn safe_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    if clean.is_empty() { "store".into() } else { clean }
}

impl Persist {
    pub fn new(root: &Path) -> Self {
        let dir = root.join("data");
        let _ = std::fs::create_dir_all(&dir);
        // Leftover temp files from an interrupted write.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().ends_with(".tmp") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        Self { dir, root: root.to_path_buf(), write_lock: tokio::sync::Mutex::new(()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{}.json", safe_name(name)))
    }

    pub fn read(&self, name: &str) -> Value {
        std::fs::read_to_string(self.file(name))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    }

    pub async fn write(&self, name: &str, data: &Value) -> anyhow::Result<()> {
        let json = serde_json::to_string(data)?;
        let file = self.file(name);
        let _guard = self.write_lock.lock().await;
        let tmp = file.with_extension(format!("{}.tmp", rand::random::<u32>()));
        tokio::fs::write(&tmp, json).await?;
        if let Err(e) = tokio::fs::rename(&tmp, &file).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e.into());
        }
        Ok(())
    }

    pub async fn reset(&self) -> anyhow::Result<()> {
        let _guard = self.write_lock.lock().await;
        for name in RESET_STORES {
            let _ = tokio::fs::remove_file(self.file(name)).await;
        }
        let _ = tokio::fs::remove_dir_all(self.dir.join("stats")).await;
        let _ = tokio::fs::remove_dir_all(self.root.join("local-art")).await;
        Ok(())
    }
}
