//! Local music library — a port of `electron/local-library.ts`.
//!
//! Imported folders are entries (path + optional display name); a scan walks
//! them for audio files, reads tags with lofty (falling back to "Artist - Title"
//! file names), extracts cover art once into `<data>/local-art`, and filters out
//! short clips and voice notes. Art is served to the UI as `localart://<hash>.jpg`.

use crate::persist::Persist;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MIN_DURATION_SEC: f64 = 30.0;
const MAX_FOLDERS: usize = 200;
const MAX_WALK_DEPTH: usize = 8;
const MAX_OPENED: usize = 200;
const LIBRARY_STORE: &str = "local-library";
const OPENED_STORE: &str = "opened-files";

const NON_MUSIC_PATHS: &[&str] = &[
    "recordings", "voice recorder", "sound_recorder", "voicenotes", "whatsapp voice notes", "telegram", "screen recorder",
    "call recordings", "call_rec", "alarms", "notifications", "ringtones", "podcasts", "audiobooks",
];
const NON_MUSIC_NAMES: &[&str] = &["voice", "recording", "record_", "call_", "memo", "note", "audio_", "clip"];

/// Containers GStreamer (WebKitGTK's media backend) plays with the usual plugin sets.
const PLAYABLE_EXTS: &[&str] = &["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "webm", "aiff", "aif", "wma"];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mtime: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain_db: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub added_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalLibrary {
    #[serde(default)]
    pub folders: Vec<FolderEntry>,
    #[serde(default)]
    pub scanned_at: i64,
    #[serde(default)]
    pub tracks: Vec<LocalTrack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unplayable: Option<Vec<Value>>,
}

pub struct Library {
    art_dir: PathBuf,
    cache: Mutex<Option<LocalLibrary>>,
    opened: Mutex<Option<Vec<LocalTrack>>>,
    /// Library mutations run one at a time (ByTune's mutateLibrary chain).
    mutate: tokio::sync::Mutex<()>,
}

fn hash_path(p: &str) -> String {
    let mut h = Sha1::new();
    h.update(p.to_lowercase().as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn normalize_folder(p: &str) -> Option<String> {
    let p = p.trim();
    if p.is_empty() {
        return None;
    }
    let abs = std::path::absolute(p).ok()?;
    let s = abs.to_string_lossy().to_string();
    if s == "/" {
        return Some(s);
    }
    Some(s.trim_end_matches('/').to_string())
}

fn folder_key(p: &str) -> String {
    p.to_lowercase()
}

/// `child` is `root` itself or anywhere inside it (case-insensitive, like the ids).
pub fn is_under_path(child: &str, root: &str) -> bool {
    let c = child.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let r = root.replace('\\', "/").trim_end_matches('/').to_lowercase();
    if c.is_empty() || r.is_empty() {
        return false;
    }
    c == r || c.starts_with(&format!("{r}/"))
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

pub fn is_playable_audio(p: &Path) -> bool {
    PLAYABLE_EXTS.contains(&ext_of(p).as_str())
}

fn is_non_music(rel_path: &str, file_name: &str) -> bool {
    let rp = rel_path.to_lowercase();
    if NON_MUSIC_PATHS.iter().any(|f| rp.contains(f)) {
        return true;
    }
    let name = file_name.to_lowercase();
    NON_MUSIC_NAMES.iter().any(|f| name.starts_with(f) || name.contains(&format!(" {f} ")))
}

fn title_from_file(file_name: &str) -> (String, Option<String>) {
    let stem = Path::new(file_name).file_stem().and_then(|s| s.to_str()).unwrap_or(file_name).replace('_', " ");
    let stem = stem.trim();
    let re = regex::Regex::new(r"^(.*?)\s*[-–]\s*(.+)$").unwrap();
    if let Some(c) = re.captures(stem) {
        if !c[1].trim().is_empty() && !c[2].trim().is_empty() {
            return (c[2].trim().to_string(), Some(c[1].trim().to_string()));
        }
    }
    (stem.to_string(), None)
}

fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string())
}

fn new_folder_entry(norm: &str) -> FolderEntry {
    FolderEntry { path: norm.to_string(), name: file_name(norm), display_name: None, added_at: now_ms() }
}

fn is_dir(p: &str) -> bool {
    Path::new(p).is_dir()
}

fn walk_audio(root: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    walkdir::WalkDir::new(root)
        .max_depth(MAX_WALK_DEPTH + 1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
}

fn contains_audio(dir: &Path) -> bool {
    walk_audio(dir).any(|e| {
        is_playable_audio(e.path()) && {
            let rel = e.path().strip_prefix(dir).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
            !is_non_music(&rel, &e.file_name().to_string_lossy())
        }
    })
}

fn music_subfolders(root: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else { return vec![] };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| contains_audio(p))
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    out.sort();
    out
}

/// "−6.53 dB" → -6.53
fn parse_gain(v: &str) -> Option<f64> {
    let cleaned: String = v.replace('\u{2212}', "-").chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+').collect();
    cleaned.parse::<f64>().ok().filter(|g| g.is_finite())
}

impl Library {
    pub fn new(root: &Path) -> Self {
        Self { art_dir: root.join("local-art"), cache: Mutex::new(None), opened: Mutex::new(None), mutate: tokio::sync::Mutex::new(()) }
    }

    pub fn read(&self, persist: &Persist) -> LocalLibrary {
        if let Some(lib) = self.cache.lock().unwrap().clone() {
            return lib;
        }
        let raw: LocalLibrary = serde_json::from_value(persist.read(LIBRARY_STORE)).unwrap_or_default();
        let mut seen = HashSet::new();
        let folders = raw.folders.into_iter().filter(|f| seen.insert(folder_key(&f.path))).collect();
        let lib = LocalLibrary { folders, ..raw };
        *self.cache.lock().unwrap() = Some(lib.clone());
        lib
    }

    async fn save(&self, persist: &Persist, lib: &LocalLibrary) -> anyhow::Result<()> {
        persist.write(LIBRARY_STORE, &serde_json::to_value(lib)?).await?;
        *self.cache.lock().unwrap() = Some(lib.clone());
        Ok(())
    }

    pub fn reset(&self) {
        *self.cache.lock().unwrap() = None;
        *self.opened.lock().unwrap() = None;
    }

    pub async fn add_folders(&self, persist: &Persist, paths: Vec<String>) -> anyhow::Result<Value> {
        let _g = self.mutate.lock().await;
        let mut lib = self.read(persist);
        let mut existing: HashSet<String> = lib.folders.iter().map(|f| folder_key(&f.path)).collect();
        let mut added: Vec<FolderEntry> = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        for raw in paths.into_iter().take(MAX_FOLDERS) {
            let Some(norm) = normalize_folder(&raw) else { continue };
            if !is_dir(&norm) {
                skipped.push(norm);
                continue;
            }
            let mut store = |p: &str, lib: &mut LocalLibrary| {
                let key = folder_key(p);
                if existing.contains(&key) || lib.folders.len() >= MAX_FOLDERS {
                    skipped.push(p.to_string());
                    return;
                }
                let entry = new_folder_entry(p);
                lib.folders.push(entry.clone());
                existing.insert(key);
                added.push(entry);
            };
            store(&norm, &mut lib);
            for sub in music_subfolders(&norm) {
                store(&sub, &mut lib);
            }
        }
        if !added.is_empty() {
            self.save(persist, &lib).await?;
        }
        Ok(json!({ "lib": lib, "added": added, "skipped": skipped }))
    }

    pub async fn rename_folder(&self, persist: &Persist, p: &str, display_name: &str) -> anyhow::Result<LocalLibrary> {
        let _g = self.mutate.lock().await;
        let mut lib = self.read(persist);
        if let Some(norm) = normalize_folder(p) {
            if let Some(entry) = lib.folders.iter_mut().find(|f| folder_key(&f.path) == folder_key(&norm)) {
                let name: String = display_name.trim().chars().take(80).collect();
                entry.display_name = if name.is_empty() { None } else { Some(name) };
                self.save(persist, &lib).await?;
            }
        }
        Ok(lib)
    }

    pub async fn remove_folder(&self, persist: &Persist, p: &str) -> anyhow::Result<LocalLibrary> {
        let _g = self.mutate.lock().await;
        let mut lib = self.read(persist);
        let Some(norm) = normalize_folder(p) else { return Ok(lib) };
        let key = folder_key(&norm);
        if !lib.folders.iter().any(|f| folder_key(&f.path) == key) {
            return Ok(lib);
        }
        lib.folders.retain(|f| folder_key(&f.path) != key);
        let folders = lib.folders.clone();
        lib.tracks.retain(|t| folders.iter().any(|f| is_under_path(&t.path, &f.path)));
        self.save(persist, &lib).await?;
        Ok(lib)
    }

    pub async fn set_folders(&self, persist: &Persist, folders: Vec<String>) -> anyhow::Result<LocalLibrary> {
        let _g = self.mutate.lock().await;
        let mut lib = self.read(persist);
        let by_key: HashMap<String, FolderEntry> = lib.folders.iter().map(|f| (folder_key(&f.path), f.clone())).collect();
        let mut next: Vec<FolderEntry> = Vec::new();
        for f in folders {
            let Some(norm) = normalize_folder(&f) else { continue };
            if !is_dir(&norm) {
                continue;
            }
            let key = folder_key(&norm);
            if next.iter().any(|e| folder_key(&e.path) == key) {
                continue;
            }
            next.push(by_key.get(&key).cloned().unwrap_or_else(|| new_folder_entry(&norm)));
        }
        lib.tracks.retain(|t| next.iter().any(|e| is_under_path(&t.path, &e.path)));
        lib.folders = next;
        self.save(persist, &lib).await?;
        Ok(lib)
    }

    pub fn folder_statuses(&self, persist: &Persist) -> Value {
        json!(self.read(persist).folders.iter().map(|f| json!({ "path": f.path, "exists": is_dir(&f.path) })).collect::<Vec<_>>())
    }

}

fn extract_art(art_dir: &Path, hash: &str, data: &[u8], mime: &str) -> Option<String> {
    {
        if data.is_empty() || data.len() > 8 * 1024 * 1024 {
            return None;
        }
        std::fs::create_dir_all(art_dir).ok()?;
        let ext = if mime.contains("png") { "png" } else { "jpg" };
        for e in ["jpg", "png"] {
            let _ = std::fs::remove_file(art_dir.join(format!("{hash}.{e}")));
        }
        std::fs::write(art_dir.join(format!("{hash}.{ext}")), data).ok()?;
        Some(format!("localart://{hash}.{ext}"))
    }
}

/// Tags, length, codec, ReplayGain and cover of one file (the file name stands in for missing tags).
fn read_track_file(art_dir: &Path, abs: &Path) -> Option<LocalTrack> {
    {
        let meta = std::fs::metadata(abs).ok()?;
        let abs_s = abs.to_string_lossy().to_string();
        let (title, artist) = title_from_file(&file_name(&abs_s));
        let mut track = LocalTrack {
            id: format!("local:{}", hash_path(&abs_s)),
            path: abs_s.clone(),
            title: if title.is_empty() { file_name(&abs_s) } else { title },
            artist: artist.unwrap_or_else(|| "Unknown artist".into()),
            album: "Unknown album".into(),
            size: meta.len(),
            mtime: meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
            ..Default::default()
        };
        let Ok(tagged) = lofty::read_from_path(abs) else {
            track.codec = Some(ext_of(abs));
            return Some(track);
        };
        track.duration = tagged.properties().duration().as_secs_f64().round();
        track.codec = Some(format!("{:?}", tagged.file_type()).to_lowercase());
        let bounded = |v: Option<std::borrow::Cow<'_, str>>| -> Option<String> {
            v.map(|s| s.trim().chars().take(200).collect::<String>()).filter(|s| !s.is_empty())
        };
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(t) = bounded(tag.title()) {
                track.title = t;
            }
            if let Some(a) = bounded(tag.artist()).or_else(|| bounded(tag.get_string(ItemKey::AlbumArtist).map(Into::into))) {
                track.artist = a;
            }
            if let Some(al) = bounded(tag.album()) {
                track.album = al;
            }
            track.genre = bounded(tag.genre());
            track.gain_db = tag.get_string(ItemKey::ReplayGainTrackGain).and_then(parse_gain);
            if let Some(pic) = tag.pictures().first() {
                let mime = pic.mime_type().map(|m| m.as_str().to_string()).unwrap_or_default();
                track.art = extract_art(art_dir, &hash_path(&abs_s), pic.data(), &mime);
            }
        }
        Some(track)
    }
}

impl Library {
    pub async fn scan(&self, persist: &Persist, filter_non_music: bool) -> anyhow::Result<LocalLibrary> {
        let existing = self.read(persist);
        let folders = existing.folders.clone();
        let prev: HashMap<String, LocalTrack> = existing.tracks.iter().map(|t| (t.path.clone(), t.clone())).collect();
        let art_dir = self.art_dir.clone();
        // Tag reading is blocking I/O: do the walk on a blocking thread.
        let tracks = tokio::task::spawn_blocking(move || {
            let mut seen = HashSet::new();
            let mut tracks = Vec::new();
            for folder in &folders {
                let root = Path::new(&folder.path);
                for e in walk_audio(root) {
                    let p = e.path();
                    if !is_playable_audio(p) {
                        continue;
                    }
                    let abs = p.to_string_lossy().to_string();
                    if !seen.insert(abs.to_lowercase()) {
                        continue;
                    }
                    let mtime = e
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    if let Some(prev) = prev.get(&abs) {
                        if prev.mtime == mtime && prev.codec.is_some() {
                            tracks.push(prev.clone());
                            continue;
                        }
                    }
                    let Some(track) = read_track_file(&art_dir, p) else { continue };
                    if track.duration < MIN_DURATION_SEC {
                        continue;
                    }
                    let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
                    if filter_non_music && is_non_music(&rel, &e.file_name().to_string_lossy()) {
                        continue;
                    }
                    tracks.push(track);
                }
            }
            tracks
        })
        .await?;
        let _g = self.mutate.lock().await;
        let current_folders = self.read(persist).folders;
        let lib = LocalLibrary { folders: current_folders, scanned_at: now_ms(), tracks, unplayable: Some(vec![]) };
        self.save(persist, &lib).await?;
        Ok(lib)
    }

    pub fn art_path(&self, name: &str) -> Option<PathBuf> {
        let re = regex::Regex::new(r"^[a-f0-9]{16}\.(jpg|png)$").unwrap();
        if !re.is_match(name) {
            return None;
        }
        let p = self.art_dir.join(name);
        p.is_file().then_some(p)
    }

    /// Raw cover bytes for a `localart://` thumb (the UI's palette extractors read pixels from these).
    pub fn art_bytes(&self, thumb: &str) -> Option<Vec<u8>> {
        let name = thumb.trim().strip_prefix("localart://")?.to_lowercase();
        std::fs::read(self.art_path(&name)?).ok()
    }

    pub fn opened_files(&self, persist: &Persist) -> Vec<LocalTrack> {
        if let Some(list) = self.opened.lock().unwrap().clone() {
            return list;
        }
        let list: Vec<LocalTrack> = serde_json::from_value(persist.read(OPENED_STORE)).unwrap_or_default();
        *self.opened.lock().unwrap() = Some(list.clone());
        list
    }

    async fn save_opened(&self, persist: &Persist, list: Vec<LocalTrack>) -> anyhow::Result<()> {
        persist.write(OPENED_STORE, &serde_json::to_value(&list)?).await?;
        *self.opened.lock().unwrap() = Some(list);
        Ok(())
    }

    /// Files opened with ByTune (command line, file manager): read and remembered.
    pub async fn open_files(&self, persist: &Persist, paths: Vec<String>) -> anyhow::Result<Value> {
        let mut tracks: Vec<LocalTrack> = Vec::new();
        for p in paths {
            let Ok(abs) = std::path::absolute(&p) else { continue };
            if !abs.is_file() || !is_playable_audio(&abs) {
                continue;
            }
            if let Some(t) = read_track_file(&self.art_dir, &abs) {
                if !tracks.iter().any(|x| x.id == t.id) {
                    tracks.push(t);
                }
            }
        }
        if !tracks.is_empty() {
            let ids: HashSet<String> = tracks.iter().map(|t| t.id.clone()).collect();
            let mut list = tracks.clone();
            list.extend(self.opened_files(persist).into_iter().filter(|t| !ids.contains(&t.id)));
            list.truncate(MAX_OPENED);
            self.save_opened(persist, list).await?;
        }
        Ok(json!({ "tracks": tracks, "unplayable": [] }))
    }

    pub async fn forget_opened(&self, persist: &Persist, id: &str) -> anyhow::Result<Vec<LocalTrack>> {
        let list: Vec<LocalTrack> = self.opened_files(persist).into_iter().filter(|t| t.id != id).collect();
        self.save_opened(persist, list.clone()).await?;
        Ok(list)
    }

    pub fn track_by_id(&self, persist: &Persist, id: &str) -> Option<LocalTrack> {
        self.read(persist)
            .tracks
            .into_iter()
            .find(|t| t.id == id)
            .or_else(|| self.opened_files(persist).into_iter().find(|t| t.id == id))
    }
}

impl Library {
    /// The file behind a local id, when it still exists. Needs the persist store; see AppState::local_stream_path.
    pub fn stream_path_with(&self, persist: &Persist, id: &str) -> Option<String> {
        let t = self.track_by_id(persist, id)?;
        Path::new(&t.path).is_file().then_some(t.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn scan_folder() {
        let root = std::env::temp_dir().join("bytune-lib-test");
        let _ = std::fs::remove_dir_all(&root);
        let persist = Persist::new(&root);
        let lib = Library::new(&root);
        let added = lib.add_folders(&persist, vec![std::env::temp_dir().join("bytune-dl-test").to_string_lossy().to_string()]).await.unwrap();
        println!("added {}", added["added"].as_array().unwrap().len());
        let scanned = lib.scan(&persist, true).await.unwrap();
        for t in &scanned.tracks {
            println!("{} | {} | {} | {}s | art={:?} codec={:?}", t.id, t.title, t.artist, t.duration, t.art, t.codec);
            assert!(lib.art_bytes(t.art.as_deref().unwrap()).is_some());
            assert!(lib.stream_path_with(&persist, &t.id).is_some());
        }
        assert_eq!(scanned.tracks.len(), 1);
    }
}
