//! Process-wide state shared by the IPC handlers, the stream proxy and the window code.

use crate::downloads::Downloads;
use crate::local_library::Library;
use crate::lyrics::Lyrics;
use crate::music::Music;
use crate::persist::Persist;
use crate::spotify::Spotify;
use crate::stats::Stats;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

pub struct AppState {
    pub persist: Persist,
    pub music: Arc<Music>,
    pub library: Library,
    pub stats: Stats,
    pub lyrics: Lyrics,
    pub spotify: Spotify,
    pub downloads: OnceLock<Arc<Downloads>>,
    pub proxy_port: OnceLock<u16>,
    /// Files opened with ByTune, waiting for the UI to take them.
    pub opened_batches: Mutex<Vec<Value>>,
    /// Folders the user chose (pickers, library, downloads): the only places open/reveal may touch.
    pub approved_dirs: Mutex<Vec<PathBuf>>,
    /// Downloaded songs by track id → file, off the library store.
    downloaded: Mutex<Option<HashMap<String, String>>>,
    pub playing: AtomicBool,
}

impl AppState {
    pub fn new(persist: Persist, music: Music) -> Self {
        let root = persist.root().to_path_buf();
        Self {
            library: Library::new(&root),
            persist,
            music: Arc::new(music),
            stats: Stats::new(),
            lyrics: Lyrics::new(),
            spotify: Spotify::new(),
            downloads: OnceLock::new(),
            proxy_port: OnceLock::new(),
            opened_batches: Mutex::new(Vec::new()),
            approved_dirs: Mutex::new(Vec::new()),
            downloaded: Mutex::new(None),
            playing: AtomicBool::new(false),
        }
    }

    pub fn downloads(&self) -> &Arc<Downloads> {
        self.downloads.get().expect("downloads initialised in setup")
    }

    pub fn port(&self) -> u16 {
        self.proxy_port.get().copied().unwrap_or(0)
    }

    pub fn local_stream_path(&self, id: &str) -> Option<String> {
        self.library.stream_path_with(&self.persist, id)
    }

    fn downloaded_index(&self, data: &Value) -> HashMap<String, String> {
        let mut files = HashMap::new();
        if let Some(downloads) = data.pointer("/state/downloads").and_then(|d| d.as_object()) {
            for (id, d) in downloads {
                if d["status"] == "done" {
                    if let Some(p) = d["path"].as_str().filter(|p| !p.is_empty()) {
                        files.insert(id.clone(), p.to_string());
                    }
                }
            }
        }
        files
    }

    pub fn note_library(&self, data: Option<&Value>) {
        *self.downloaded.lock().unwrap() = data.map(|d| self.downloaded_index(d));
    }

    pub fn note_downloaded(&self, id: &str, path: &str) {
        let mut guard = self.downloaded.lock().unwrap();
        let index = guard.get_or_insert_with(|| self.downloaded_index(&self.persist.read("library")));
        index.insert(id.to_string(), path.to_string());
    }

    /// A downloaded song's file, when it still exists in an approved folder.
    pub fn downloaded_file(&self, id: &str) -> Option<String> {
        let file = {
            let mut guard = self.downloaded.lock().unwrap();
            let index = guard.get_or_insert_with(|| self.downloaded_index(&self.persist.read("library")));
            index.get(id).cloned()?
        };
        (Path::new(&file).is_file() && self.is_approved(&file)).then_some(file)
    }

    pub fn approve_dir(&self, dir: &Path) {
        let mut dirs = self.approved_dirs.lock().unwrap();
        if !dirs.iter().any(|d| d == dir) {
            dirs.push(dir.to_path_buf());
        }
    }

    pub fn is_approved(&self, p: &str) -> bool {
        let Ok(abs) = std::path::absolute(p) else { return false };
        let abs = abs.to_string_lossy().to_string();
        let mut roots: Vec<String> = self.approved_dirs.lock().unwrap().iter().map(|d| d.to_string_lossy().to_string()).collect();
        roots.extend(self.library.read(&self.persist).folders.into_iter().map(|f| f.path));
        roots.iter().any(|r| crate::local_library::is_under_path(&abs, r))
    }
}
