//! Spotify playlist import and song matching — a port of the public-link part
//! of `electron/spotify.ts`, `electron/spotify-web.ts` and `electron/track-match.ts`.
//!
//! A public playlist link needs no sign-in: the embed page names the playlist
//! and its first songs and carries an anonymous token, which reads the rest
//! from Spotify's web API. Each song is then matched to a YouTube Music song by
//! title words, version marks ("live", "remix"…), credited artists and length.
//! Connecting a Spotify account (the listener's own library) is not ported.

use crate::music::Music;
use crate::persist::Persist;
use crate::ytm::{SearchRow, Track};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WEB: &str = "https://open.spotify.com";
const PATHFINDER: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const FETCH_PLAYLIST_HASH: &str = "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf";
const MAX_SONGS: usize = 5000;
const MATCHES: &str = "track-matches";
const FOUND_MS: i64 = 30 * 86_400_000;
const MISSED_MS: i64 = 86_400_000;
const MAX_REMEMBERED: usize = 5000;
pub const MATCH_LANGUAGES: &[&str] = &["telugu", "tamil", "hindi", "kannada", "malayalam", "english"];
const LANGUAGE_WORDS: &[&str] = &["telugu", "tamil", "hindi", "kannada", "malayalam", "english", "bengali", "marathi", "punjabi", "gujarati"];

pub struct Spotify {
    matches: Mutex<Option<HashMap<String, Value>>>,
    searching: tokio::sync::Semaphore,
    hash: Mutex<Option<String>>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSong {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub spotify_id: Option<String>,
}

/* ---------------- JSON helpers ---------------- */

fn at<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter().fold(v, |o, k| o.get(*k).unwrap_or(&Value::Null))
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn seconds(ms: &Value) -> f64 {
    match ms.as_f64() {
        Some(n) if n > 0.0 && n < 86_400_000.0 => (n / 1000.0).round(),
        _ => 0.0,
    }
}

fn track_id(uri: &Value) -> Option<String> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^spotify:track:([A-Za-z0-9]{22})$").unwrap());
    RE.captures(uri.as_str()?).map(|c| c[1].to_string())
}

fn largest(sources: &Value) -> Option<String> {
    sources
        .as_array()?
        .iter()
        .filter_map(|s| Some((str_of(&s["url"])?, s["width"].as_f64().unwrap_or(0.0))))
        .filter(|(u, _)| u.starts_with("https://"))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .map(|(u, _)| u)
}

fn sized(sources: &Value, min: f64) -> Option<String> {
    let mut list: Vec<(String, f64)> = sources
        .as_array()?
        .iter()
        .filter_map(|s| Some((str_of(&s["url"])?, s["width"].as_f64().unwrap_or(0.0))))
        .filter(|(u, _)| u.starts_with("https://"))
        .collect();
    list.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    list.iter().find(|s| s.1 >= min).or(list.last()).map(|s| s.0.clone())
}

pub fn playlist_id(input: &str) -> Option<String> {
    static URI: Lazy<Regex> = Lazy::new(|| Regex::new(r"^spotify:(?:user:[^:\s]+:)?playlist:([A-Za-z0-9]{22})$").unwrap());
    static URL: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^https?://([A-Za-z0-9.-]*\.)?spotify\.com/(?:[^?#]*/)?playlist/([A-Za-z0-9]{22})(?:[/?#].*)?$").unwrap());
    let text = input.trim();
    if let Some(c) = URI.captures(text) {
        return Some(c[1].to_string());
    }
    URL.captures(text).map(|c| c[2].to_string())
}

fn is_short_link(input: &str) -> bool {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^https://spotify\.link/[A-Za-z0-9]{6,20}/?$").unwrap());
    RE.is_match(input.trim())
}

fn song_of(data: &Value, uri: &Value) -> Option<Value> {
    let title = str_of(&data["name"])?;
    let spotify_id = track_id(uri).or_else(|| track_id(&data["uri"]))?;
    let artist = at(data, &["artists", "items"])
        .as_array()
        .map(|a| a.iter().filter_map(|x| str_of(at(x, &["profile", "name"]))).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let album = &data["albumOfTrack"];
    let duration = {
        let d = seconds(at(data, &["trackDuration", "totalMilliseconds"]));
        if d > 0.0 { d } else { seconds(at(data, &["duration", "totalMilliseconds"])) }
    };
    let mut song = json!({ "spotifyId": spotify_id, "title": title, "artist": artist, "duration": duration });
    if let Some(name) = str_of(&album["name"]) {
        song["album"] = json!(name);
    }
    if let Some(thumb) = sized(at(album, &["coverArt", "sources"]), 300.0) {
        song["thumb"] = json!(thumb);
    }
    if at(data, &["contentRating", "label"]) == "EXPLICIT" {
        song["explicit"] = json!(true);
    }
    Some(song)
}

fn parse_embed_page(html: &str) -> Result<(Value, Option<String>), String> {
    static DATA: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?s)<script id="__NEXT_DATA__" type="application/json">(.*?)</script>"#).unwrap());
    let data = DATA.captures(html).ok_or("The Spotify page had no playlist data")?;
    let root: Value = serde_json::from_str(&data[1]).map_err(|_| "The Spotify page's playlist data didn't read")?;
    let state = at(&root, &["props", "pageProps", "state"]);
    let entity = at(state, &["data", "entity"]);
    if !entity.is_object() {
        return Err("That playlist is private or no longer exists".into());
    }
    let songs: Vec<Value> = entity["trackList"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|t| {
                    let title = str_of(&t["title"])?;
                    let id = track_id(&t["uri"])?;
                    let mut s = json!({ "spotifyId": id, "title": title, "artist": str_of(&t["subtitle"]).unwrap_or_default(), "duration": seconds(&t["duration"]) });
                    if t["isExplicit"] == json!(true) {
                        s["explicit"] = json!(true);
                    }
                    Some(s)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = json!({
        "name": str_of(&entity["name"]).or_else(|| str_of(&entity["title"])).unwrap_or_else(|| "Spotify playlist".into()),
        "total": songs.len(),
        "songs": songs,
    });
    if let Some(owner) = str_of(&entity["subtitle"]) {
        out["owner"] = json!(owner);
    }
    if let Some(thumb) = largest(at(entity, &["coverArt", "sources"])) {
        out["thumb"] = json!(thumb);
    }
    Ok((out, str_of(at(state, &["settings", "session", "accessToken"]))))
}

fn parse_playlist_page(body: &Value) -> Result<(Vec<Value>, usize), String> {
    let p = at(body, &["data", "playlistV2"]);
    let content = &p["content"];
    if !content.is_object() {
        return Err("Spotify's playlist answer didn't read".into());
    }
    let songs: Vec<Value> = content["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let data = at(item, &["itemV2", "data"]);
                    if data["__typename"] == "Track" { song_of(data, &data["uri"]) } else { None }
                })
                .collect()
        })
        .unwrap_or_default();
    let total = content["totalCount"].as_u64().map(|t| t as usize).unwrap_or(songs.len());
    Ok((songs, total))
}

/* ---------------- matching (track-match.ts) ---------------- */

static VERSION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(remix|live|acoustic|instrumental|unplugged|karaoke|slowed|reverb|sped|nightcore|lo-?fi|cover|reprise|mashup|8d)\b").unwrap());
static VERSION_WORDS: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)remix|cover|live|acoustic|instrumental|unplugged|karaoke|slowed|reverb|sped|lo-?fi|version").unwrap());

/// src/lib/radio-filter.ts normalizeTitle.
fn normalize_title(title: &str) -> String {
    static GROUP: Lazy<Regex> = Lazy::new(|| Regex::new(r"[(\[【「][^)\]】」]*[)\]】」]").unwrap());
    static TAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+-\s+(?:official|lyrics?|audio|video|visuali[sz]er|from)\b.*$").unwrap());
    static FEAT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s(?:feat\.?|ft\.?|featuring)\s.*$").unwrap());
    static NON: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^\p{L}\p{M}\p{N}]+").unwrap());
    let t: String = title.nfkc().collect::<String>().to_lowercase();
    let t = GROUP.replace_all(&t, |c: &regex::Captures| if VERSION_WORDS.is_match(&c[0]) { c[0].to_string() } else { " ".into() });
    let t = TAIL.replace(&t, " ");
    let t = FEAT.replace(&t, " ");
    NON.replace_all(&t, " ").trim().to_string()
}

fn strip_packaging(title: &str) -> String {
    static BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"[(\[{【「『][^)\]}】」』]*[)\]}】」』]").unwrap());
    static DASH: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s[-–—]\s.*$").unwrap());
    let t = BR.replace_all(title, " ");
    DASH.replace(&t, " ").to_string()
}

fn title_words(title: &str) -> String {
    let n = normalize_title(&strip_packaging(title));
    if n.is_empty() { normalize_title(title) } else { n }
}

fn version_marks(title: &str) -> String {
    let folded: String = title.nfkc().collect::<String>().to_lowercase();
    let mut found: Vec<String> = VERSION.find_iter(&folded).map(|m| m.as_str().replace('-', "")).collect::<HashSet<_>>().into_iter().collect();
    found.sort();
    found.join(" ")
}

fn artist_names(artist: &str) -> Vec<String> {
    static SPLIT: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)\s*(?:,|&|\+|/|;|、|\sx\s|\sand\s|\s(?:feat|ft)\.?\s|\sfeaturing\s|\swith\s|\svs\.?\s)\s*").unwrap());
    SPLIT.split(artist).map(|n| normalize_title(n).replace(' ', "")).filter(|n| !n.is_empty()).collect()
}

fn similarity(a: &str, b: &str) -> f64 {
    let x: Vec<char> = a.chars().filter(|c| !c.is_whitespace()).collect();
    let y: Vec<char> = b.chars().filter(|c| !c.is_whitespace()).collect();
    if x == y {
        return 1.0;
    }
    if x.len() < 2 || y.len() < 2 {
        return 0.0;
    }
    let mut pairs: HashMap<(char, char), i32> = HashMap::new();
    for w in x.windows(2) {
        *pairs.entry((w[0], w[1])).or_insert(0) += 1;
    }
    let mut shared = 0;
    for w in y.windows(2) {
        if let Some(n) = pairs.get_mut(&(w[0], w[1])) {
            if *n > 0 {
                shared += 1;
                *n -= 1;
            }
        }
    }
    (2.0 * shared as f64) / ((x.len() - 1 + y.len() - 1) as f64)
}

fn language_of(text: &str) -> Option<&'static str> {
    let folded: String = text.nfkc().collect::<String>().to_lowercase();
    LANGUAGE_WORDS.iter().copied().find(|l| Regex::new(&format!(r"\b{l}\b")).unwrap().is_match(&folded))
}

fn match_score(target: &ImportSong, song: &Track, prefer: &str) -> Option<f64> {
    if version_marks(&target.title) != version_marks(&song.title) {
        return None;
    }
    let sim = similarity(&title_words(&target.title), &title_words(&song.title));
    if sim < 0.85 {
        return None;
    }
    let gap = if target.duration > 0.0 && song.duration > 0.0 { Some((target.duration - song.duration).abs()) } else { None };
    if gap.map(|g| g > 15.0).unwrap_or(false) {
        return None;
    }
    let wanted = artist_names(&target.artist);
    let credited = artist_names(&song.artist);
    let shared = wanted.iter().filter(|w| credited.contains(w)).count();
    if !wanted.is_empty() && !credited.is_empty() && shared == 0 {
        return None;
    }
    let mut score = sim * 100.0 + if shared > 0 { 30.0 + 10.0 * (shared as f64 / wanted.len() as f64) } else { 0.0 };
    if let Some(g) = gap {
        score += if g <= 3.0 { 20.0 } else if g <= 8.0 { 10.0 } else { 0.0 };
    }
    if let (Some(a), Some(b)) = (&target.album, &song.album) {
        if title_words(a) == title_words(b) {
            score += 10.0;
        }
    }
    let lang = language_of(&format!("{} {}", target.title, target.album.clone().unwrap_or_default())).or(if prefer.is_empty() { None } else { Some(prefer) });
    if let Some(lang) = lang {
        match language_of(&format!("{} {}", song.title, song.album.clone().unwrap_or_default())) {
            Some(got) if got == lang => score += 15.0,
            Some(_) => score -= 40.0,
            None => {}
        }
    }
    Some(score)
}

fn best_match(target: &ImportSong, candidates: &[Track], prefer: &str) -> Option<Track> {
    candidates
        .iter()
        .filter(|s| !s.id.is_empty())
        .filter_map(|s| match_score(target, s, prefer).map(|sc| (sc, s)))
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
        .map(|(_, s)| s.clone())
}

fn search_queries(target: &ImportSong) -> Vec<String> {
    static FIRST: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\s*(?:,|&|\sx\s|\s(?:feat|ft)\.?\s)\s*").unwrap());
    let title = strip_packaging(&target.title).split_whitespace().collect::<Vec<_>>().join(" ");
    let base = if title.is_empty() { target.title.trim().to_string() } else { title };
    let marks = version_marks(&target.title);
    let name = [base, marks].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
    let first = FIRST.split(&target.artist).next().unwrap_or("").trim().to_string();
    let mut out = Vec::new();
    for q in [if first.is_empty() { name.clone() } else { format!("{name} {first}") }, name] {
        if !q.is_empty() && !out.contains(&q) {
            out.push(q);
        }
    }
    out
}

impl Spotify {
    pub fn new() -> Self {
        Self { matches: Mutex::new(None), searching: tokio::sync::Semaphore::new(4), hash: Mutex::new(None) }
    }

    async fn get(&self, http: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
        http.get(url).header("User-Agent", UA).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())
    }

    /// The fetchPlaylist query hash, re-read from the web player's script when the known one stops working.
    async fn refresh_hash(&self, http: &reqwest::Client) -> Option<String> {
        static SCRIPT: Lazy<Regex> = Lazy::new(|| Regex::new(r"https://open\.spotifycdn\.com/cdn/build/web-player/web-player\.[0-9a-f]+\.js").unwrap());
        static HASH: Lazy<Regex> = Lazy::new(|| Regex::new(r#"["']fetchPlaylist["']\s*,\s*["']query["']\s*,\s*["']([0-9a-f]{64})["']"#).unwrap());
        let page = self.get(http, &format!("{WEB}/")).await.ok()?.text().await.ok()?;
        let url = SCRIPT.find(&page)?.as_str().to_string();
        let script = self.get(http, &url).await.ok()?.text().await.ok()?;
        let hash = HASH.captures(&script)?[1].to_string();
        *self.hash.lock().unwrap() = Some(hash.clone());
        Some(hash)
    }

    async fn read_playlist(&self, http: &reqwest::Client, id: &str, token: &str) -> Result<(Vec<Value>, usize), String> {
        let mut songs = Vec::new();
        let mut total = usize::MAX;
        let mut offset = 0;
        let mut retried = false;
        while offset < total.min(MAX_SONGS) {
            let hash = self.hash.lock().unwrap().clone().unwrap_or_else(|| FETCH_PLAYLIST_HASH.to_string());
            let body = json!({
                "variables": { "uri": format!("spotify:playlist:{id}"), "offset": offset, "limit": 100, "enableWatchFeedEntrypoint": false },
                "operationName": "fetchPlaylist",
                "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } },
            });
            let res = http
                .post(PATHFINDER)
                .header("User-Agent", UA)
                .header("Authorization", format!("Bearer {token}"))
                .header("App-Platform", "WebPlayer")
                .header("Content-Type", "application/json;charset=UTF-8")
                .timeout(Duration::from_secs(15))
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = res.status();
            let json: Value = res.json().await.unwrap_or(Value::Null);
            let not_found = json["errors"].as_array().map(|e| e.iter().any(|x| x["message"].as_str().unwrap_or("").contains("PersistedQueryNotFound"))).unwrap_or(false);
            if not_found && !retried {
                retried = true;
                self.refresh_hash(http).await;
                continue;
            }
            if !status.is_success() || json["data"].is_null() {
                return Err(format!("Spotify's fetchPlaylist answered {status}"));
            }
            let (page, t) = parse_playlist_page(&json)?;
            total = t;
            if page.is_empty() {
                break;
            }
            songs.extend(page);
            offset += 100;
        }
        songs.truncate(MAX_SONGS);
        let total = if total == usize::MAX { songs.len() } else { total };
        Ok((songs, total))
    }

    pub async fn public_playlist(&self, http: &reqwest::Client, link: &str) -> Result<Value, String> {
        let mut id = playlist_id(link);
        if id.is_none() && is_short_link(link) {
            let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
            if let Ok(res) = client.get(link.trim()).header("User-Agent", UA).send().await {
                let location = res.headers().get("location").and_then(|l| l.to_str().ok()).map(String::from);
                let target = match location {
                    Some(l) => l,
                    None => {
                        let body = res.text().await.unwrap_or_default();
                        Regex::new(r#"https://open\.spotify\.com/[^"'\s<>]+"#).unwrap().find(&body).map(|m| m.as_str().to_string()).unwrap_or_default()
                    }
                };
                id = playlist_id(&target);
            }
        }
        let id = id.ok_or("That isn't a link to a Spotify playlist.")?;
        let res = self.get(http, &format!("{WEB}/embed/playlist/{id}")).await?;
        if res.status().as_u16() == 404 {
            return Err("That playlist is private or no longer exists.".into());
        }
        if !res.status().is_success() {
            return Err(format!("Spotify didn't answer (HTTP {}). Try again in a moment.", res.status()));
        }
        let (mut embed, token) = parse_embed_page(&res.text().await.map_err(|e| e.to_string())?)?;
        if let Some(token) = token {
            match self.read_playlist(http, &id, &token).await {
                Ok((songs, total)) if !songs.is_empty() => {
                    embed["songs"] = json!(songs);
                    embed["total"] = json!(total);
                }
                Ok(_) => {}
                Err(e) => log::warn!("spotify: reading the whole playlist failed, keeping the embed's songs: {e}"),
            }
        }
        Ok(embed)
    }

    /// The YouTube Music song a song from elsewhere is; remembered for a month (a miss for a day).
    pub async fn match_song(&self, music: &Music, persist: &Persist, song: ImportSong, prefer: &str) -> Result<Value, String> {
        let lang = if MATCH_LANGUAGES.contains(&prefer) { prefer } else { "" };
        let key = match &song.spotify_id {
            Some(id) => format!("sp:{id}|{lang}"),
            None => format!("t:{}|{}|{}", song.title, song.artist, song.duration).to_lowercase() + "|" + lang,
        };
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut guard = self.matches.lock().unwrap();
            let all = guard.get_or_insert_with(|| serde_json::from_value(persist.read(MATCHES)).unwrap_or_default());
            if let Some(hit) = all.get(&key) {
                let found = !hit["t"].is_null();
                let age = now - hit["at"].as_i64().unwrap_or(0);
                if age < if found { FOUND_MS } else { MISSED_MS } {
                    return Ok(hit["t"].clone());
                }
            }
        }
        let _permit = self.searching.acquire().await.map_err(|e| e.to_string())?;
        let mut found: Option<Track> = None;
        for q in search_queries(&song) {
            let Ok(res) = music.it.search(&q, crate::ytm::search_filter_params("songs")).await else { continue };
            let (rows, _) = crate::ytm::parse_search_page(&res, false);
            let candidates: Vec<Track> = rows
                .into_iter()
                .filter_map(|r| match r {
                    SearchRow::Track(t) | SearchRow::Top(t) => Some(t),
                    _ => None,
                })
                .collect();
            found = best_match(&song, &candidates, lang);
            if found.is_some() {
                break;
            }
        }
        let value = found.map(|t| json!(Track { is_video: None, ..t })).unwrap_or(Value::Null);
        let snapshot = {
            let mut guard = self.matches.lock().unwrap();
            let all = guard.get_or_insert_with(HashMap::new);
            all.insert(key, json!({ "t": value, "at": now }));
            if all.len() > MAX_REMEMBERED {
                let mut keys: Vec<(String, i64)> = all.iter().map(|(k, v)| (k.clone(), v["at"].as_i64().unwrap_or(0))).collect();
                keys.sort_by_key(|k| k.1);
                for (k, _) in keys.into_iter().take(all.len() - MAX_REMEMBERED) {
                    all.remove(&k);
                }
            }
            json!(all)
        };
        let _ = persist.write(MATCHES, &snapshot).await;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(playlist_id("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x").as_deref(), Some("37i9dQZF1DXcBWIGoYBM5M"));
        assert_eq!(playlist_id("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M").as_deref(), Some("37i9dQZF1DXcBWIGoYBM5M"));
        assert!(playlist_id("https://example.com/playlist/37i9dQZF1DXcBWIGoYBM5M").is_none());
    }

    #[test]
    fn matching() {
        let target = ImportSong { title: "Yellow".into(), artist: "Coldplay".into(), duration: 266.0, ..Default::default() };
        let live = Track { id: "a".into(), title: "Yellow (Live)".into(), artist: "Coldplay".into(), duration: 280.0, ..Default::default() };
        let studio = Track { id: "b".into(), title: "Yellow".into(), artist: "Coldplay".into(), duration: 267.0, ..Default::default() };
        assert_eq!(best_match(&target, &[live, studio], "").map(|t| t.id).as_deref(), Some("b"));
        assert_eq!(search_queries(&target), vec!["Yellow Coldplay".to_string(), "Yellow".to_string()]);
    }
}
