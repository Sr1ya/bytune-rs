//! Offline downloads — a port of `electron/downloads.ts`.
//!
//! A small queue (two at a time) saves songs as tagged `.m4a` files (AAC, the
//! most portable rendition) with title, artist, album and cover art. Transfers
//! resume where they stopped on a retry, stalls abort after 20 s, and every step
//! is reported to the UI as a `download:event`.

use crate::music::Music;
use crate::ytm::{upgrade_thumb, Track};
use futures_util::StreamExt;
use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::tag::{Accessor, Tag, TagExt};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const MAX_CONCURRENT: usize = 2;
const STALL: Duration = Duration::from_secs(20);
const ATTEMPTS: u32 = 4;

#[derive(Clone)]
enum Phase {
    Queued,
    Running { downloaded: u64, total: u64 },
}

struct Job {
    track: Track,
    dir: Option<String>,
    max_kbps: Option<u32>,
    export_compat: bool,
}

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

pub struct Downloads {
    queue: Mutex<VecDeque<Job>>,
    state: Mutex<HashMap<String, Phase>>,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    active: Mutex<usize>,
    pub default_dir: PathBuf,
    pub export_dir: PathBuf,
    emit: Emit,
}

pub fn sanitize_filename(name: &str) -> String {
    let re = regex::Regex::new(r#"[\\/:*?"<>|\x00-\x1f\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{feff}]"#).unwrap();
    let s = re.replace_all(name, "_");
    let s = regex::Regex::new(r"\s+").unwrap().replace_all(&s, " ").trim().to_string();
    let bounded: String = (if s.is_empty() { "track".to_string() } else { s }).chars().take(120).collect();
    // A leading dot would hide the file.
    if bounded.starts_with('.') { format!("_{bounded}") } else { bounded }
}

/// A free file name in `dir` ("Name.m4a", "Name (1).m4a", …), created empty so nobody else takes it.
fn claim_name(dir: &Path, stem: &str, ext: &str) -> std::io::Result<PathBuf> {
    for n in 0.. {
        let name = if n == 0 { format!("{stem}{ext}") } else { format!("{stem} ({n}){ext}") };
        let candidate = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

impl Downloads {
    pub fn new(default_dir: PathBuf, export_dir: PathBuf, emit: Emit) -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(VecDeque::new()),
            state: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            active: Mutex::new(0),
            default_dir,
            export_dir,
            emit,
        })
    }

    fn is_downloading(&self, id: &str) -> bool {
        self.queue.lock().unwrap().iter().any(|j| j.track.id == id) || self.state.lock().unwrap().contains_key(id)
    }

    pub fn snapshot(&self) -> Value {
        let mut out: Vec<Value> = self.queue.lock().unwrap().iter().map(|j| json!({ "id": j.track.id, "phase": "queued" })).collect();
        for (id, st) in self.state.lock().unwrap().iter() {
            if out.iter().any(|o| o["id"] == json!(id)) {
                continue;
            }
            match st {
                Phase::Queued => out.push(json!({ "id": id, "phase": "queued" })),
                Phase::Running { downloaded, total } => {
                    out.push(json!({ "id": id, "phase": "running", "downloaded": downloaded, "total": total }))
                }
            }
        }
        Value::Array(out)
    }

    pub fn enqueue(self: &Arc<Self>, music: Arc<Music>, track: Track, dir: Option<String>, max_kbps: Option<u32>, export_compat: bool) -> Result<Value, String> {
        if self.is_downloading(&track.id) {
            return Err("Already downloading this track".into());
        }
        let id = track.id.clone();
        self.queue.lock().unwrap().push_back(Job { track, dir, max_kbps, export_compat });
        self.state.lock().unwrap().insert(id.clone(), Phase::Queued);
        (self.emit)(json!({ "type": "queued", "id": id }));
        self.drain(music);
        Ok(json!("queued"))
    }

    pub fn cancel(&self, id: &str) -> bool {
        let mut q = self.queue.lock().unwrap();
        if let Some(i) = q.iter().position(|j| j.track.id == id) {
            q.remove(i);
            self.state.lock().unwrap().remove(id);
            (self.emit)(json!({ "type": "cancelled", "id": id }));
            return true;
        }
        drop(q);
        if let Some(token) = self.tokens.lock().unwrap().get(id) {
            token.cancel();
            return true;
        }
        false
    }

    pub fn reset(&self) {
        let queued: Vec<Job> = self.queue.lock().unwrap().drain(..).collect();
        for t in self.tokens.lock().unwrap().values() {
            t.cancel();
        }
        for job in queued {
            (self.emit)(json!({ "type": "cancelled", "id": job.track.id }));
        }
        self.state.lock().unwrap().clear();
    }

    fn drain(self: &Arc<Self>, music: Arc<Music>) {
        loop {
            {
                let active = self.active.lock().unwrap();
                if *active >= MAX_CONCURRENT {
                    return;
                }
            }
            let Some(job) = self.queue.lock().unwrap().pop_front() else { return };
            *self.active.lock().unwrap() += 1;
            let this = self.clone();
            let music = music.clone();
            tokio::spawn(async move {
                let id = job.track.id.clone();
                let token = CancellationToken::new();
                this.tokens.lock().unwrap().insert(id.clone(), token.clone());
                let result = this.run(&music, &job, &token).await;
                this.tokens.lock().unwrap().remove(&id);
                this.state.lock().unwrap().remove(&id);
                match result {
                    Ok(path) => (this.emit)(json!({ "type": "done", "id": id, "path": path })),
                    Err(_) if token.is_cancelled() => (this.emit)(json!({ "type": "cancelled", "id": id })),
                    Err(reason) => (this.emit)(json!({ "type": "failed", "id": id, "reason": reason })),
                }
                *this.active.lock().unwrap() -= 1;
                this.drain(music);
            });
        }
    }

    async fn run(&self, music: &Music, job: &Job, token: &CancellationToken) -> Result<String, String> {
        let track = &job.track;
        let dir = if job.export_compat {
            self.export_dir.clone()
        } else {
            job.dir.as_ref().filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| self.default_dir.clone())
        };
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let mut stream = tokio::select! {
            r = music.resolve_stream(&track.id, true, job.max_kbps, true) => r.map_err(|e| e.to_string())?,
            _ = token.cancelled() => return Err("cancelled".into()),
        };
        let part = dir.join(format!(".bytune-{}.part", track.id));
        (self.emit)(json!({ "type": "start", "id": track.id }));
        self.state.lock().unwrap().insert(track.id.clone(), Phase::Running { downloaded: 0, total: 0 });

        let result: Result<(), String> = async {
            let mut attempt = 1;
            loop {
                let from = if attempt == 1 { 0 } else { tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0) };
                match self.transfer(&music.http, &stream.url, stream.ua, &part, from, token, &track.id).await {
                    Ok((size, total)) => {
                        let expected = stream.clen.unwrap_or(total);
                        if expected > 0 && size < expected {
                            if attempt >= ATTEMPTS {
                                return Err("download ended early".into());
                            }
                        } else {
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        if token.is_cancelled() {
                            return Err("cancelled".into());
                        }
                        if attempt >= ATTEMPTS {
                            return Err(e);
                        }
                        log::warn!("download {}: {e}; trying again", track.id);
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(1500 * attempt as u64)) => {}
                    _ = token.cancelled() => return Err("cancelled".into()),
                }
                let next = music.resolve_stream(&track.id, true, job.max_kbps, true).await.map_err(|e| e.to_string())?;
                if next.itag != stream.itag || next.clen != stream.clen {
                    let _ = tokio::fs::write(&part, b"").await;
                }
                stream = next;
                attempt += 1;
            }
        }
        .await;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        if token.is_cancelled() {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("cancelled".into());
        }

        let is_webm = stream.mime.contains("webm") || stream.mime.contains("opus");
        let ext = if is_webm { ".webm" } else { ".m4a" };
        if !is_webm {
            let tagging = dir.join(format!(".bytune-{}.tagging.m4a", track.id));
            if tokio::fs::rename(&part, &tagging).await.is_ok() {
                let cover = cover_for(&music.http, track).await;
                let (t, path) = (track.clone(), tagging.clone());
                let tagged = tokio::task::spawn_blocking(move || write_tags(&path, &t, cover)).await;
                if let Ok(Err(e)) | Err(e) = tagged.map_err(|e| e.to_string()) {
                    log::warn!("download {}: tags not written: {e}", track.id);
                }
                let _ = tokio::fs::rename(&tagging, &part).await;
            }
        }
        let stem = sanitize_filename(&format!("{} - {}", track.artist, track.title));
        let dest = claim_name(&dir, &stem, ext).map_err(|e| e.to_string())?;
        if let Err(e) = tokio::fs::rename(&part, &dest).await {
            let _ = tokio::fs::remove_file(&dest).await;
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e.to_string());
        }
        Ok(dest.to_string_lossy().to_string())
    }

    async fn transfer(
        &self,
        http: &reqwest::Client,
        url: &str,
        ua: &str,
        part: &Path,
        from: u64,
        token: &CancellationToken,
        id: &str,
    ) -> Result<(u64, u64), String> {
        let req = http.get(url).header("User-Agent", ua).header("Range", format!("bytes={from}-"));
        let res = tokio::select! {
            r = tokio::time::timeout(STALL, req.send()) => r.map_err(|_| "download stalled".to_string())?.map_err(|e| e.to_string())?,
            _ = token.cancelled() => return Err("cancelled".into()),
        };
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status()));
        }
        let start = if res.status().as_u16() == 206 { from } else { 0 };
        let total = res.content_length().map(|l| start + l).unwrap_or(0);
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(start > 0)
            .truncate(start == 0)
            .open(part)
            .await
            .map_err(|e| e.to_string())?;
        let mut size = start;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut body = res.bytes_stream();
        loop {
            let next = tokio::select! {
                n = tokio::time::timeout(STALL, body.next()) => n.map_err(|_| "download stalled".to_string())?,
                _ = token.cancelled() => return Err("cancelled".into()),
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            size += chunk.len() as u64;
            if last_emit.elapsed() > Duration::from_millis(250) {
                last_emit = Instant::now();
                self.state.lock().unwrap().insert(id.to_string(), Phase::Running { downloaded: size, total });
                (self.emit)(json!({ "type": "progress", "id": id, "downloaded": size, "total": total }));
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok((size, total))
    }
}

async fn cover_for(http: &reqwest::Client, track: &Track) -> Option<(Vec<u8>, MimeType)> {
    let url = upgrade_thumb(&track.thumb, 1000);
    if !url.starts_with("https://") {
        return None;
    }
    let res = http.get(&url).timeout(Duration::from_secs(15)).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let data = res.bytes().await.ok()?.to_vec();
    if data.len() > 5 * 1024 * 1024 || data.len() < 4 {
        return None;
    }
    if data[0] == 0xff && data[1] == 0xd8 {
        Some((data, MimeType::Jpeg))
    } else if data[0] == 0x89 && data[1] == 0x50 {
        Some((data, MimeType::Png))
    } else {
        None
    }
}

fn write_tags(path: &Path, track: &Track, cover: Option<(Vec<u8>, MimeType)>) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    if tagged.primary_tag().is_none() {
        let tag_type = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged.primary_tag_mut().ok_or("no tag")?;
    tag.set_title(track.title.clone());
    tag.set_artist(track.artist.clone());
    if let Some(album) = track.album.as_ref().filter(|a| !a.is_empty()) {
        tag.set_album(album.clone());
    }
    if let Some((data, mime)) = cover {
        tag.push_picture(Picture::unchecked(data).pic_type(PictureType::CoverFront).mime_type(mime).build());
    }
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use lofty::tag::Accessor;

    #[tokio::test]
    #[ignore]
    async fn live_download() {
        let dir = std::env::temp_dir().join("bytune-dl-test");
        let _ = std::fs::remove_dir_all(&dir);
        let music = Arc::new(Music::new(reqwest::Client::new(), &std::env::temp_dir(), None).unwrap());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let dl = Downloads::new(dir.clone(), dir.clone(), Arc::new(move |e| { let _ = tx.send(e); }));
        let track = Track { id: "9qnqYL0eNNI".into(), title: "Yellow".into(), artist: "Coldplay".into(), album: Some("Parachutes".into()),
            thumb: "https://yt3.googleusercontent.com/7RK5kFu8RjjulsxsPCJ55wmJLchKaaIRAYih0ldj--RGbnOOdA0U2vmLWyVfjPW82nR-Dwm2r8PhEi61=w544-h544-l90-rj".into(), ..Default::default() };
        dl.enqueue(music, track, None, Some(128), false).unwrap();
        while let Some(e) = rx.recv().await {
            if e["type"] != "progress" { println!("{e}"); }
            if e["type"] == "done" || e["type"] == "failed" {
                if let Some(p) = e["path"].as_str() {
                    use lofty::file::{AudioFile, TaggedFileExt};
                    let f = lofty::read_from_path(p).unwrap();
                    let tag = f.primary_tag().unwrap();
                    println!("size={} dur={:?} title={:?} artist={:?} album={:?} pictures={}", std::fs::metadata(p).unwrap().len(), f.properties().duration(),
                        tag.title(), tag.artist(), tag.album(), tag.pictures().len());
                }
                assert_eq!(e["type"], "done");
                break;
            }
        }
    }
}
