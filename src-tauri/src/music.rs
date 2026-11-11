//! The YouTube Music service — a port of ByTune's `electron/music-service.ts`.
//!
//! Browse/search pages come from raw InnerTube calls (`innertube.rs`) parsed by
//! `ytm.rs`. Stream URLs come from rustypipe, which handles the player request,
//! signature deobfuscation and (with the bundled `rustypipe-botguard` helper)
//! PO tokens. Each resolved URL is probed with a real read before use, cached
//! until shortly before it expires, and served to the UI through the local
//! proxy in `proxy.rs`.

use crate::innertube::{InnerTube, PlayerClient, UA};
use crate::ytm::{self, Credits, SearchRow, Track};
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use rustypipe::client::{ClientType, RustyPipe};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A long playlist/album is paged; this many pages (~100 songs each) at most.
const MAX_SHELF_PAGES: usize = 50;
/// The feed's first page is Quick picks; YouTube's own playlist shelves follow.
const HOME_PAGES: usize = 4;
const PODCAST_EPISODES_MAX: usize = 100;

#[derive(Clone, Debug)]
pub struct ResolvedStream {
    pub url: String,
    pub mime: String,
    /// Integrated loudness in LUFS when YouTube reports it.
    pub lufs: Option<f64>,
    pub itag: Option<u32>,
    pub clen: Option<u64>,
    /// The User-Agent the URL was issued to (googlevideo checks it for some clients).
    pub ua: &'static str,
}

/// One audio rendition, from either kind of client.
struct Cand {
    url: String,
    itag: u32,
    bitrate: u64,
    average_bitrate: u64,
    size: u64,
    mime: String,
    loudness_db: Option<f64>,
    /// not a "stable volume" or dubbed copy
    original: bool,
}

#[derive(Clone, Copy, Debug)]
enum StreamClient {
    /// Direct InnerTube app clients: plain, fully streamable URLs.
    Raw(PlayerClient),
    /// rustypipe's clients (deobfuscation, PO tokens via rustypipe-botguard).
    Rp(&'static [ClientType]),
}

/// A small FIFO-bounded map, like ByTune's `evictOldest` caches.
pub struct BoundedMap<V> {
    map: HashMap<String, V>,
    order: VecDeque<String>,
    max: usize,
}

impl<V: Clone> BoundedMap<V> {
    pub fn new(max: usize) -> Self {
        Self { map: HashMap::new(), order: VecDeque::new(), max }
    }
    pub fn get(&self, k: &str) -> Option<V> {
        self.map.get(k).cloned()
    }
    pub fn contains(&self, k: &str) -> bool {
        self.map.contains_key(k)
    }
    pub fn insert(&mut self, k: String, v: V) {
        if !self.map.contains_key(&k) {
            self.order.push_back(k.clone());
        }
        self.map.insert(k, v);
        while self.map.len() > self.max {
            match self.order.pop_front() {
                Some(old) => {
                    self.map.remove(&old);
                }
                None => break,
            }
        }
    }
    pub fn remove_prefix(&mut self, prefix: &str) {
        self.map.retain(|k, _| !k.starts_with(prefix));
        self.order.retain(|k| !k.starts_with(prefix));
    }
}

pub struct Music {
    pub it: InnerTube,
    rp: RustyPipe,
    pub http: reqwest::Client,
    country: String,
    country_source: String,
    resolve_cache: Mutex<BoundedMap<(ResolvedStream, Instant)>>,
    /// One lock per song key: concurrent requests for the same song share one client rotation,
    /// while different songs (the one clicked, a prefetch, a download) resolve in parallel.
    resolving: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    preferred_client: Mutex<usize>,
    queue_credits: Mutex<BoundedMap<Option<(String, Option<String>, f64)>>>,
    durations: Mutex<BoundedMap<f64>>,
}

/// Clients tried in turn; the first that yields a URL passing the probe wins and leads next time.
const STREAM_CLIENTS: &[StreamClient] = &[
    StreamClient::Raw(PlayerClient::VisionOs),
    StreamClient::Raw(PlayerClient::AndroidVr),
    StreamClient::Rp(&[ClientType::Desktop]),
    StreamClient::Rp(&[ClientType::Ios]),
    StreamClient::Rp(&[ClientType::Tv]),
];

/// The device market (InnerTube `gl`) from the environment: HITUNE_MARKET overrides,
/// then the locale's country (LANG=en_IN.UTF-8 → IN), else YouTube Music's default (US).
pub fn resolve_market() -> (String, String) {
    if let Ok(v) = std::env::var("HITUNE_MARKET") {
        let v = v.trim().to_uppercase();
        if v.len() == 2 && v.chars().all(|c| c.is_ascii_alphabetic()) {
            return (v, "override".into());
        }
    }
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            let base = v.split('.').next().unwrap_or("");
            if let Some((_, cc)) = base.split_once('_') {
                if cc.len() == 2 && cc.chars().all(|c| c.is_ascii_alphabetic()) && cc != "POSIX" {
                    return (cc.to_uppercase(), "locale".into());
                }
            }
        }
    }
    ("US".into(), "default".into())
}

fn display_language() -> String {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            let base = v.split(['_', '.', '@']).next().unwrap_or("").to_lowercase();
            if (2..=3).contains(&base.len()) && base.chars().all(|c| c.is_ascii_lowercase()) && base != "c" {
                return base;
            }
        }
    }
    "en".into()
}

fn itag_rank(itag: u32) -> u64 {
    match itag {
        141 => 6,
        251 => 5,
        140 => 4,
        250 => 3,
        249 => 2,
        139 => 1,
        _ => 0,
    }
}

/// How long a resolved URL may be reused: until 5 minutes before its own `expire`, at most 6 h.
fn stream_ttl(url: &str) -> Duration {
    let re = regex::Regex::new(r"[?&/]expire[=/](\d{9,11})").unwrap();
    let Some(expire) = re.captures(url).and_then(|c| c[1].parse::<i64>().ok()) else {
        return Duration::from_secs(600);
    };
    let now = chrono::Utc::now().timestamp();
    let secs = (expire - now - 300).clamp(0, 6 * 3600);
    Duration::from_secs(secs as u64)
}

impl Music {
    pub fn new(http: reqwest::Client, data_dir: &Path, botguard_bin: Option<std::path::PathBuf>) -> Result<Self> {
        let (country, country_source) = resolve_market();
        let lang = display_language();
        log::info!("market: {country} ({country_source}), hl={lang}");
        let mut builder = RustyPipe::builder().storage_dir(data_dir).timeout(Duration::from_secs(20));
        if let Ok(c) = country.parse::<rustypipe::param::Country>() {
            builder = builder.country(c);
        }
        builder = match botguard_bin {
            Some(bin) if bin.exists() => builder.botguard_bin(bin.into_os_string()),
            _ => builder,
        };
        let rp = builder.build().map_err(|e| anyhow!("rustypipe: {e}"))?;
        Ok(Self {
            it: InnerTube::new(http.clone(), lang, country.clone()),
            rp,
            http,
            country,
            country_source,
            resolve_cache: Mutex::new(BoundedMap::new(500)),
            resolving: Mutex::new(HashMap::new()),
            preferred_client: Mutex::new(0),
            queue_credits: Mutex::new(BoundedMap::new(600)),
            durations: Mutex::new(BoundedMap::new(2000)),
        })
    }

    pub fn current_market(&self) -> Value {
        json!({ "country": self.country, "source": self.country_source })
    }

    /* ---------------- search ---------------- */

    pub async fn search_page(&self, query: &str, filter: &str) -> Result<Value> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(json!({ "rows": [], "continuation": null }));
        }
        let res = self.it.search(q, ytm::search_filter_params(filter)).await?;
        Ok(page_json(ytm::parse_search_page(&res, filter == "videos")))
    }

    pub async fn search_more(&self, token: &str, filter: &str) -> Result<Value> {
        let res = self.it.search_continuation(token).await?;
        Ok(page_json(ytm::parse_search_page(&res, filter == "videos")))
    }

    /// Legacy combined search (flat SearchResults), built on the same parse.
    pub async fn search_all(&self, query: &str) -> Result<Value> {
        let empty = json!({ "songs": [], "videos": [], "albums": [], "artists": [], "playlists": [], "top": null, "related": [] });
        let q = query.trim();
        if q.is_empty() {
            return Ok(empty);
        }
        let Ok(res) = self.it.search(q, None).await else { return Ok(empty) };
        let (rows, _) = ytm::parse_search_page(&res, false);
        let top = rows.iter().find_map(|r| if let SearchRow::Top(t) = r { Some(t.clone()) } else { None });
        let mut songs: Vec<Track> = top.iter().cloned().collect();
        songs.extend(rows.iter().filter_map(|r| if let SearchRow::Track(t) = r { Some(t.clone()) } else { None }));
        let browse_of = |kind: &str| -> Vec<&ytm::BrowseItem> {
            rows.iter()
                .filter_map(|r| match r {
                    SearchRow::Browse { item, .. } if item.kind == kind => Some(item),
                    _ => None,
                })
                .collect()
        };
        Ok(json!({
            "songs": songs,
            "videos": [],
            "albums": browse_of("album").iter().map(|i| json!({ "id": i.browse_id, "title": i.title, "artist": i.subtitle, "thumb": i.thumb })).collect::<Vec<_>>(),
            "artists": browse_of("artist").iter().map(|i| json!({ "id": i.browse_id, "name": i.title, "thumb": i.thumb, "subtitle": i.subtitle })).collect::<Vec<_>>(),
            "playlists": browse_of("playlist").iter().map(|i| json!({ "id": i.browse_id, "title": i.title, "thumb": i.thumb })).collect::<Vec<_>>(),
            "top": top.map(|t| json!({ "kind": "track", "track": t })),
            "related": [],
        }))
    }

    pub async fn suggestions(&self, query: &str) -> Value {
        let q = query.trim();
        if q.is_empty() {
            return json!({ "items": [] });
        }
        match self.it.suggestions(q).await {
            Ok(res) => json!({ "items": ytm::parse_search_suggestions(&res, q) }),
            Err(_) => json!({ "items": [] }),
        }
    }

    /* ---------------- pages ---------------- */

    pub async fn artist_page(&self, artist_id: &str) -> Result<Value> {
        let res = self.it.browse(artist_id, None).await?;
        let parsed = ytm::parse_artist_page(&res);
        let name = parsed.name.clone().unwrap_or_else(|| "Unknown artist".into());
        let songs: Vec<Track> = parsed
            .songs
            .into_iter()
            .map(|t| Track {
                artist: if !t.artist.is_empty() && t.artist != "Unknown artist" { t.artist.clone() } else { name.clone() },
                artist_id: t.artist_id.clone().filter(|a| !a.is_empty()).or_else(|| Some(artist_id.to_string())),
                ..t
            })
            .collect();
        Ok(json!({
            "artist": { "id": artist_id, "name": name, "thumb": parsed.thumb },
            "description": parsed.description,
            "subscriberCount": parsed.subscriber_count,
            "monthlyListeners": parsed.monthly_listeners,
            "songs": songs,
            "shelves": parsed.shelves,
        }))
    }

    async fn rest_of_shelf(&self, mut token: Option<String>, credit: &Credits) -> Vec<Track> {
        let mut out = Vec::new();
        for _ in 0..MAX_SHELF_PAGES {
            let Some(t) = token.take() else { break };
            let Ok(res) = self.it.browse_continuation(&t).await else { break };
            let (songs, next) = ytm::parse_playlist_continuation(&res, credit);
            if songs.is_empty() {
                break;
            }
            out.extend(songs);
            token = next;
        }
        out
    }

    pub async fn album(&self, album_id: &str) -> Result<Value> {
        let res = self.it.browse(album_id, None).await?;
        let mut parsed = ytm::parse_release_page(&res, album_id);
        if parsed.continuation.is_some() {
            let more = self.rest_of_shelf(parsed.continuation.clone(), &ytm::page_credit(Some(&res))).await;
            let mut seen: HashSet<String> = parsed.tracks.iter().map(|t| t.id.clone()).collect();
            let thumb = parsed.header.as_ref().map(|h| h.thumb.clone()).unwrap_or_default();
            for t in more {
                if seen.insert(t.id.clone()) {
                    let t = if t.thumb.is_empty() { Track { thumb: thumb.clone(), ..t } } else { t };
                    parsed.tracks.push(t);
                }
            }
        }
        let header = parsed.header.clone().unwrap_or_default();
        let lines: Vec<String> = header.subtitle.split('•').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
        let release_type = lines.iter().find(|l| ["album", "single", "ep"].contains(&l.to_lowercase().as_str())).cloned();
        let year = lines.iter().rev().find(|l| l.len() == 4 && l.chars().all(|c| c.is_ascii_digit())).cloned();
        let first = parsed.tracks.first();
        let artist = lines
            .iter()
            .find(|l| Some(*l) != release_type.as_ref() && Some(*l) != year.as_ref())
            .cloned()
            .or_else(|| first.map(|t| t.artist.clone()))
            .unwrap_or_else(|| "Unknown artist".into());
        let title = if !header.title.is_empty() {
            header.title.clone()
        } else {
            first.and_then(|t| t.album.clone()).unwrap_or_else(|| "Unknown album".into())
        };
        let thumb = if !header.thumb.is_empty() { header.thumb.clone() } else { first.map(|t| t.thumb.clone()).unwrap_or_default() };
        let release_type = release_type.map(|r| {
            let lower = r.to_lowercase();
            let mut c = lower.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => lower,
            }
        });
        Ok(json!({
            "album": {
                "id": album_id, "title": title, "artist": artist, "year": year, "thumb": thumb,
                "releaseType": release_type, "description": parsed.description, "artistId": header.artist_id,
            },
            "tracks": parsed.tracks,
        }))
    }

    pub async fn playlist_page(&self, playlist_id: &str) -> Result<Value> {
        let id = if playlist_id.starts_with("VL") || playlist_id.starts_with("PL") || playlist_id.starts_with("OLAK5uy") {
            playlist_id.to_string()
        } else {
            format!("VL{playlist_id}")
        };
        let res = self.it.browse(&id, None).await?;
        let token = ytm::parse_playlist_shelf(Some(&res)).and_then(|(_, c)| c);
        let more = self.rest_of_shelf(token, &ytm::page_credit(Some(&res))).await;
        Ok(ytm::parse_remote_playlist_page(&res, more))
    }

    /// `{ title, tracks }` for a playlist (imports and Home playlist cards).
    pub async fn playlist(&self, playlist_id: &str) -> Result<Value> {
        let page = self.playlist_page(playlist_id).await?;
        Ok(json!({ "title": page["title"], "tracks": page["tracks"] }))
    }

    pub async fn home(&self) -> Result<Value> {
        let mut shelves = Vec::new();
        let mut res = Some(self.it.browse("FEmusic_home", None).await?);
        for page in 0..HOME_PAGES {
            let Some(current) = res.take() else { break };
            let (sections, next) = ytm::home_sections(&current);
            for section in sections {
                if let Some(shelf) = ytm::parse_home_section(section) {
                    shelves.push(shelf);
                }
            }
            if page + 1 < HOME_PAGES {
                if let Some(token) = next {
                    res = self.it.browse_continuation(&token).await.ok();
                }
            }
        }
        shelves.truncate(8);
        Ok(Value::Array(shelves))
    }

    pub async fn charts(&self) -> Result<Value> {
        let (res, explore) = tokio::join!(self.it.browse("FEmusic_charts", None), self.it.browse("FEmusic_explore", None));
        let mut shelves = ytm::parse_charts_shelves(&res?);
        if let Ok(explore) = explore {
            let fresh = ytm::parse_charts_shelves(&explore).into_iter().find(|s| {
                let items = s["items"].as_array().cloned().unwrap_or_default();
                items.len() >= 3 && items.iter().all(|i| i["kind"] == "album")
            });
            if let Some(mut fresh) = fresh {
                fresh["title"] = json!("New releases");
                shelves.push(fresh);
            }
        }
        Ok(Value::Array(shelves))
    }

    pub async fn moods(&self) -> Result<Value> {
        if let Ok(res) = self.it.browse("FEmusic_moods_and_genres", None).await {
            let grouped = ytm::parse_moods(&res);
            if grouped.len() >= 6 {
                return Ok(Value::Array(grouped));
            }
        }
        let res = self.it.browse("FEmusic_explore", None).await?;
        Ok(Value::Array(ytm::parse_moods(&res)))
    }

    pub async fn mood_page(&self, browse_id: &str, params: &str) -> Result<Value> {
        Ok(ytm::parse_mood_page(&self.it.browse(browse_id, Some(params)).await?))
    }

    pub async fn mood_covers(&self, browse_id: &str, params: &str) -> Result<Value> {
        Ok(json!(ytm::parse_mood_covers(&self.it.browse(browse_id, Some(params)).await?, 2)))
    }

    pub async fn podcast(&self, browse_id: &str) -> Result<Value> {
        let res = self.it.browse(browse_id, None).await?;
        let (mut page, continuation, show) = ytm::parse_podcast_page(&res, browse_id);
        let mut episodes: Vec<Value> = page["episodes"].as_array().cloned().unwrap_or_default();
        let mut seen: HashSet<String> = episodes.iter().filter_map(|e| e["id"].as_str().map(String::from)).collect();
        let mut token = continuation;
        for _ in 0..4 {
            if episodes.len() >= PODCAST_EPISODES_MAX {
                break;
            }
            let Some(t) = token.take() else { break };
            let Ok(more) = self.it.browse_continuation(&t).await else { break };
            let (next, cont) = ytm::parse_podcast_episodes(Some(&more), &show);
            let fresh: Vec<Track> = next.into_iter().filter(|e| seen.insert(e.id.clone())).collect();
            if fresh.is_empty() {
                break;
            }
            episodes.extend(fresh.into_iter().map(|e| json!(e)));
            token = cont;
        }
        episodes.truncate(PODCAST_EPISODES_MAX);
        page["episodes"] = Value::Array(episodes);
        Ok(page)
    }

    pub async fn podcasts(&self) -> Result<Value> {
        Ok(Value::Array(ytm::parse_podcast_shelves(&self.it.browse("FEmusic_non_music_audio", None).await?)))
    }

    /* ---------------- radio / queue credits ---------------- */

    pub async fn radio(&self, video_id: &str, token: Option<&str>) -> Result<Value> {
        let mut body = json!({
            "videoId": video_id,
            "playlistId": format!("RDAMVM{video_id}"),
            "enablePersistentPlaylistPanel": true,
            "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
            "isAudioOnly": true,
            "watchEndpointMusicSupportedConfigs": {
                "watchEndpointMusicConfig": { "hasPersistentPlaylistPanel": true, "musicVideoType": "MUSIC_VIDEO_TYPE_ATV" }
            },
        });
        if let Some(t) = token {
            body["continuation"] = json!(t);
        }
        let res = self.it.next(body).await?;
        Ok(ytm::parse_radio_page(&res, video_id))
    }

    /// A track's real artist/album/length off its own watch-queue row (one `next` call, cached).
    pub async fn queue_credits(&self, video_id: &str) -> Option<(String, Option<String>, f64)> {
        if video_id.is_empty() {
            return None;
        }
        if let Some(hit) = self.queue_credits.lock().unwrap().get(video_id) {
            return hit;
        }
        let body = json!({ "videoId": video_id, "playlistId": format!("RDAMVM{video_id}"), "isAudioOnly": true });
        let res = self.it.next(body).await.ok()?;
        let credits = ytm::parse_queue_credits(&res, video_id).map(|c| (c.artist, c.album, c.duration_sec));
        self.queue_credits.lock().unwrap().insert(video_id.to_string(), credits.clone());
        credits
    }

    /// Plain lyrics from YT Music's own Lyrics tab (the `next` response names the lyrics browse page).
    pub async fn yt_music_plain_lyrics(&self, video_id: &str) -> Option<String> {
        let res = self.it.next(json!({ "videoId": video_id, "isAudioOnly": true })).await.ok()?;
        let tabs = ytm::collect_renderers(Some(&res), "tabRenderer");
        let browse_id = tabs.iter().find_map(|tab| {
            let id = ytm::s(ytm::o(ytm::o(Some(tab), "endpoint"), "browseEndpoint"), "browseId")?;
            if id.starts_with("MPLYt") { Some(id) } else { None }
        })?;
        let lyr = self.it.browse(&browse_id, None).await.ok()?;
        let shelf = ytm::collect_renderers(Some(&lyr), "musicDescriptionShelfRenderer").into_iter().next();
        let text = ytm::text(ytm::o(shelf, "description"));
        let text = text.trim();
        if text.is_empty() { None } else { Some(text.to_string()) }
    }

    /// Durations for rows that came without one (search's "All" tab), off each song's queue row.
    pub async fn enrich_durations(&self, ids: Vec<String>) -> Value {
        let mut result = serde_json::Map::new();
        let pending: Vec<String> = {
            let cache = self.durations.lock().unwrap();
            let mut seen = HashSet::new();
            ids.iter().filter(|id| !id.is_empty() && !cache.contains(id) && seen.insert((*id).clone())).take(60).cloned().collect()
        };
        let found: Vec<(String, f64)> = futures_util::stream::iter(pending)
            .map(|id| async move {
                let secs = self.queue_credits(&id).await.map(|c| c.2).unwrap_or(0.0);
                (id, secs)
            })
            .buffer_unordered(4)
            .collect()
            .await;
        {
            let mut cache = self.durations.lock().unwrap();
            for (id, secs) in found {
                if secs > 0.0 {
                    cache.insert(id, secs);
                }
            }
            for id in &ids {
                if let Some(secs) = cache.get(id) {
                    result.insert(id.clone(), json!(secs.round() as i64));
                }
            }
        }
        Value::Object(result)
    }

    /* ---------------- stream resolution ---------------- */

    /// A fresh load after a playback error: forget this song's renditions and start from the next client.
    pub fn retry_stream(&self, video_id: &str) {
        self.resolve_cache.lock().unwrap().remove_prefix(&format!("{video_id}|"));
        let mut p = self.preferred_client.lock().unwrap();
        *p = (*p + 1) % STREAM_CLIENTS.len();
    }

    pub async fn resolve_stream(&self, video_id: &str, refresh: bool, max_kbps: Option<u32>, mp4_only: bool) -> Result<ResolvedStream> {
        let key = format!("{video_id}|{}|{}", max_kbps.map(|k| k.to_string()).unwrap_or_default(), if mp4_only { "mp4" } else { "" });
        let cached = || -> Option<ResolvedStream> {
            let cache = self.resolve_cache.lock().unwrap();
            cache.get(&key).filter(|(_, exp)| Instant::now() < *exp).map(|(v, _)| v)
        };
        if !refresh {
            if let Some(hit) = cached() {
                return Ok(hit);
            }
        }
        let key_lock = {
            let mut locks = self.resolving.lock().unwrap();
            // Drop locks nobody holds or waits on, so the map stays as small as the work in flight.
            locks.retain(|_, l| Arc::strong_count(l) > 1);
            locks.entry(key.clone()).or_default().clone()
        };
        let _guard = key_lock.lock().await;
        if !refresh {
            if let Some(hit) = cached() {
                return Ok(hit);
            }
        }
        let pin = self.resolve_cache.lock().unwrap().get(&key).map(|(v, _)| v);
        let start = *self.preferred_client.lock().unwrap();
        let mut last_err = anyhow!("no stream clients");
        for round in 0..2 {
            for i in 0..STREAM_CLIENTS.len() {
                let idx = (start + i) % STREAM_CLIENTS.len();
                match self.try_client(video_id, STREAM_CLIENTS[idx], max_kbps, mp4_only, pin.as_ref()).await {
                    Ok(value) => {
                        *self.preferred_client.lock().unwrap() = idx;
                        let exp = Instant::now() + stream_ttl(&value.url);
                        self.resolve_cache.lock().unwrap().insert(key.clone(), (value.clone(), exp));
                        return Ok(value);
                    }
                    Err(e) => {
                        log::warn!("stream {video_id} via {:?}: {e}", STREAM_CLIENTS[idx]);
                        last_err = e;
                    }
                }
            }
            if round == 0 {
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
        }
        Err(last_err)
    }

    /// Every audio rendition one client offers, in a common shape.
    async fn candidates(&self, video_id: &str, client: StreamClient) -> Result<(Vec<Cand>, &'static str)> {
        match client {
            StreamClient::Raw(pc) => {
                let player = self.it.player(video_id, pc).await?;
                let status = player.pointer("/playabilityStatus/status").and_then(|v| v.as_str()).unwrap_or("");
                if status != "OK" {
                    let reason = player.pointer("/playabilityStatus/reason").and_then(|v| v.as_str()).unwrap_or(status);
                    return Err(anyhow!("not playable: {reason}"));
                }
                let formats = player.pointer("/streamingData/adaptiveFormats").and_then(|f| f.as_array()).cloned().unwrap_or_default();
                let num = |v: &Value| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0);
                let cands = formats
                    .iter()
                    .filter(|f| f["mimeType"].as_str().unwrap_or("").starts_with("audio/") && f["url"].is_string())
                    .map(|f| Cand {
                        url: f["url"].as_str().unwrap().to_string(),
                        itag: num(&f["itag"]) as u32,
                        bitrate: num(&f["bitrate"]),
                        average_bitrate: num(&f["averageBitrate"]),
                        size: num(&f["contentLength"]),
                        mime: f["mimeType"].as_str().unwrap_or("audio/mp4").to_string(),
                        loudness_db: f["loudnessDb"].as_f64(),
                        original: f["isDrc"] != Value::Bool(true) && f.pointer("/audioTrack/audioIsDefault") != Some(&Value::Bool(false)),
                    })
                    .collect();
                Ok((cands, pc.user_agent()))
            }
            StreamClient::Rp(clients) => {
                let player = self.rp.query().player_from_clients(video_id, clients).await.map_err(|e| anyhow!("{e}"))?;
                let cands = player
                    .audio_streams
                    .iter()
                    .filter(|f| f.drm_track_type.is_none())
                    .map(|f| Cand {
                        url: f.url.clone(),
                        itag: f.itag,
                        bitrate: f.bitrate as u64,
                        average_bitrate: f.average_bitrate as u64,
                        size: f.size,
                        mime: f.mime.clone(),
                        loudness_db: f.loudness_db.map(|l| l as f64),
                        original: f.track.as_ref().map(|t| t.is_default).unwrap_or(true),
                    })
                    .collect();
                Ok((cands, UA))
            }
        }
    }

    async fn try_client(
        &self,
        video_id: &str,
        client: StreamClient,
        max_kbps: Option<u32>,
        mp4_only: bool,
        pin: Option<&ResolvedStream>,
    ) -> Result<ResolvedStream> {
        let (all, ua) = self.candidates(video_id, client).await?;
        let mut candidates: Vec<&Cand> = all.iter().collect();
        if candidates.is_empty() {
            return Err(anyhow!("no audio formats"));
        }
        // "Stable volume" (DRC) and dubbed copies reuse the plain track's itags; keep the plain one.
        let originals: Vec<&Cand> = candidates.iter().copied().filter(|f| f.original).collect();
        if !originals.is_empty() {
            candidates = originals;
        }
        candidates.sort_by_key(|f| std::cmp::Reverse(itag_rank(f.itag) * 1_000_000_000 + f.bitrate));
        let pinned = pin.and_then(|p| {
            candidates.iter().copied().find(|f| Some(f.itag) == p.itag && (p.clen.is_none() || f.size == 0 || Some(f.size) == p.clen))
        });
        if let Some(p) = pinned {
            candidates = vec![p];
        } else {
            if let Some(cap) = max_kbps.filter(|c| *c > 0) {
                let kbps = |f: &Cand| (if f.average_bitrate > 0 { f.average_bitrate } else { f.bitrate }) as f64 / 1000.0;
                let capped: Vec<&Cand> = candidates.iter().copied().filter(|f| kbps(f) <= cap as f64 * 1.1).collect();
                if !capped.is_empty() {
                    candidates = capped;
                }
            }
            if mp4_only {
                let mp4s: Vec<&Cand> = candidates.iter().copied().filter(|f| f.mime.contains("mp4")).collect();
                if !mp4s.is_empty() {
                    candidates = mp4s;
                }
            }
        }
        let f = candidates[0];
        if !self.probe(&f.url, ua).await {
            return Err(anyhow!("stream rejected (probe failed)"));
        }
        Ok(ResolvedStream {
            url: f.url.clone(),
            mime: f.mime.clone(),
            lufs: f.loudness_db.map(|db| db - 14.0),
            itag: Some(f.itag),
            clen: if f.size > 0 { Some(f.size) } else { None },
            ua,
        })
    }

    /// An open-range request whose first chunk must arrive: catches URLs that answer tiny ranges but refuse streaming.
    async fn probe(&self, url: &str, ua: &str) -> bool {
        let res = self.http.get(url).header("User-Agent", ua).header("Range", "bytes=0-").timeout(Duration::from_secs(10)).send().await;
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                log::debug!("probe: request failed: {e}");
                return false;
            }
        };
        if !(res.status().as_u16() == 206 || res.status().as_u16() == 200) {
            log::debug!("probe: HTTP {}", res.status());
            return false;
        }
        let mut stream = res.bytes_stream();
        let first = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
        let ok = matches!(&first, Ok(Some(Ok(b))) if !b.is_empty());
        if !ok {
            log::debug!("probe: no first chunk ({})", match first { Err(_) => "timed out".to_string(), Ok(None) => "empty body".into(), Ok(Some(Err(e))) => e.to_string(), Ok(Some(Ok(_))) => "zero bytes".into() });
        }
        ok
    }
}

fn page_json((rows, continuation): (Vec<SearchRow>, Option<String>)) -> Value {
    json!({ "rows": rows.iter().map(|r| r.to_json()).collect::<Vec<_>>(), "continuation": continuation })
}

/// A Music service for live tests elsewhere (lyrics' live_sources).
#[cfg(test)]
pub fn live_music() -> Music {
    let dir = std::env::temp_dir().join("bytune-live-test");
    std::fs::create_dir_all(&dir).unwrap();
    Music::new(reqwest::Client::builder().gzip(true).brotli(true).build().unwrap(), &dir, None).unwrap()
}

#[cfg(test)]
mod live_tests {
    //! Network tests against the real services: `cargo test --lib live -- --ignored --nocapture`.
    use super::*;

    fn music() -> Music {
        let dir = std::env::temp_dir().join("bytune-live-test");
        std::fs::create_dir_all(&dir).unwrap();
        Music::new(reqwest::Client::builder().gzip(true).build().unwrap(), &dir, None).unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn live_catalog() {
        let m = music();
        let page = m.search_page("coldplay yellow", "all").await.unwrap();
        let rows = page["rows"].as_array().unwrap();
        println!("search all: {} rows, first kinds {:?}", rows.len(), rows.iter().take(4).map(|r| r["kind"].as_str().unwrap_or("")).collect::<Vec<_>>());
        assert!(rows.len() > 3);
        let songs = m.search_page("coldplay yellow", "songs").await.unwrap();
        let first = songs["rows"][0]["song"].clone();
        println!("first song: {} — {} ({}s) album={:?} thumb={}", first["title"], first["artist"], first["duration"], first["album"], first["thumb"]);
        assert!(first["id"].as_str().unwrap().len() == 11);
        let more = m.search_more(songs["continuation"].as_str().unwrap(), "songs").await.unwrap();
        println!("search more: {} rows", more["rows"].as_array().unwrap().len());

        let sugg = m.suggestions("cold").await;
        println!("suggestions: {}", sugg["items"].as_array().unwrap().len());

        let album_id = first["albumId"].as_str().unwrap().to_string();
        let album = m.album(&album_id).await.unwrap();
        println!("album: {} by {} ({}) tracks={} type={:?}", album["album"]["title"], album["album"]["artist"], album["album"]["year"], album["tracks"].as_array().unwrap().len(), album["album"]["releaseType"]);
        assert!(album["tracks"].as_array().unwrap().len() > 3);

        let artist_id = first["artistId"].as_str().unwrap().to_string();
        let artist = m.artist_page(&artist_id).await.unwrap();
        println!("artist: {} songs={} shelves={} listeners={:?}", artist["artist"]["name"], artist["songs"].as_array().unwrap().len(), artist["shelves"].as_array().unwrap().len(), artist["monthlyListeners"]);
        assert!(!artist["songs"].as_array().unwrap().is_empty());

        let home = m.home().await.unwrap();
        println!("home shelves: {:?}", home.as_array().unwrap().iter().map(|s| format!("{} ({})", s["title"], s["items"].as_array().unwrap().len())).collect::<Vec<_>>());
        assert!(!home.as_array().unwrap().is_empty());

        let charts = m.charts().await.unwrap();
        println!("charts shelves: {}", charts.as_array().unwrap().len());
        let moods = m.moods().await.unwrap();
        println!("moods: {}", moods.as_array().unwrap().len());
        let mood = &moods[0];
        if let (Some(b), Some(p)) = (mood["browseId"].as_str(), mood["params"].as_str()) {
            let page = m.mood_page(b, p).await.unwrap();
            println!("mood page {}: {} shelves", page["title"], page["shelves"].as_array().unwrap().len());
        }
        let radio = m.radio(first["id"].as_str().unwrap(), None).await.unwrap();
        println!("radio: {} tracks next={}", radio["tracks"].as_array().unwrap().len(), radio["next"].is_string());
        assert!(radio["tracks"].as_array().unwrap().len() > 5);
        let radio2 = m.radio(first["id"].as_str().unwrap(), radio["next"].as_str()).await.unwrap();
        println!("radio page 2: {} tracks", radio2["tracks"].as_array().unwrap().len());

        let pl = m.playlist_page("RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs").await;
        match pl {
            Ok(p) => println!("playlist: {} — {} — {} tracks", p["title"], p["meta"], p["tracks"].as_array().unwrap().len()),
            Err(e) => println!("playlist error: {e}"),
        }
        let podcasts = m.podcasts().await.map(|p| p.as_array().unwrap().len());
        println!("podcast shelves: {podcasts:?}");
        let durs = m.enrich_durations(vec![first["id"].as_str().unwrap().to_string()]).await;
        println!("enrich: {durs}");
        let plain = m.yt_music_plain_lyrics(first["id"].as_str().unwrap()).await;
        println!("ytm lyrics: {:?}", plain.map(|p| p.chars().take(40).collect::<String>()));
    }

    #[tokio::test]
    #[ignore]
    async fn live_stream() {
        let _ = env_logger::builder().is_test(true).filter_level(log::LevelFilter::Info).try_init();
        let m = music();
        let s = m.resolve_stream("9qnqYL0eNNI", false, None, false).await.unwrap();
        println!("stream: itag={:?} mime={} lufs={:?} clen={:?}", s.itag, s.mime, s.lufs, s.clen);
        let low = m.resolve_stream("9qnqYL0eNNI", false, Some(64), false).await.unwrap();
        println!("low: itag={:?}", low.itag);
        let mp4 = m.resolve_stream("9qnqYL0eNNI", true, Some(128), true).await.unwrap();
        println!("download pick: itag={:?} mime={}", mp4.itag, mp4.mime);
        assert!(mp4.mime.contains("mp4"));
    }

    #[tokio::test]
    #[ignore]
    async fn live_lyrics_and_spotify() {
        let m = music();
        let lyr = crate::lyrics::Lyrics::new();
        let meta = crate::lyrics::LyricsMeta { id: "9qnqYL0eNNI".into(), title: "Yellow".into(), artist: "Coldplay".into(), album: Some("Parachutes".into()), duration: Some(267.0) };
        let start = std::time::Instant::now();
        let r = lyr.get(&m, meta, None).await;
        println!("lyrics: source={} word={} lines={} in {:?}", r["source"], r["wordSynced"], r["synced"].as_array().map(|a| a.len()).unwrap_or(0), start.elapsed());
        assert!(!r.is_null());
        let sp = crate::spotify::Spotify::new();
        let pl = sp.public_playlist(&m.http, "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").await;
        match pl {
            Ok(p) => {
                println!("spotify: {} songs={} total={}", p["name"], p["songs"].as_array().unwrap().len(), p["total"]);
                let s0: crate::spotify::ImportSong = serde_json::from_value(p["songs"][0].clone()).unwrap();
                let dir = std::env::temp_dir().join("bytune-live-test");
                let persist = crate::persist::Persist::new(&dir);
                let hit = sp.match_song(&m, &persist, s0.clone(), "").await.unwrap();
                println!("match {} — {} → {} — {}", s0.title, s0.artist, hit["title"], hit["artist"]);
            }
            Err(e) => println!("spotify error: {e}"),
        }
    }
}
