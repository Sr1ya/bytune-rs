//! Canvas — looping video artwork behind the player, a port of ByTune's `electron/canvas.ts`
//! (BitChord's canvas lookup): four sources, asked in order until one answers.
//!
//!  1. Apple Music's motion artwork: the most clips. Read with the anonymous token Apple's web player
//!     uses, and scored, because its search returns a plausible wrong album for almost anything.
//!  2. Tidal's video covers, square, on a lot of what Apple misses.
//!  3. The community index, the only one that reaches back catalogue.
//!  4. Spotify's own Canvas, only for a listener who connected Spotify (it needs their session).
//!
//! Every answer is checked against what was asked for: all four will confidently answer a search with
//! the wrong record, and a wrong clip is worse than none. Misses are cached, because nothing having a
//! canvas is the common case.

use crate::state::AppState;
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const COMMUNITY_MANIFEST: &str = "https://vivimusicanvas.mkmdevilmi.workers.dev/canvas.json";
const COMMUNITY_TTL: Duration = Duration::from_secs(30 * 60);
const TIDAL_SEARCH: &str = "https://api.tidal.com/v1/search";
const TIDAL_EMBED_TOKEN: &str = "vNVdglQOjFJJGG2U";
const APPLE_CATALOG: &str = "https://amp-api.music.apple.com/v1/catalog";
const APPLE_WEB_PLAYER: &str = "https://music.apple.com/us/browse";
const APPLE_TOKEN_RETRY: Duration = Duration::from_secs(30 * 60);
const CACHE_MAX: usize = 64;

#[derive(Clone)]
struct Hit {
    url: String,
    source: &'static str,
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

/* ------------------------------ matching ------------------------------ */

fn normalize_for_match(s: &str) -> String {
    static BRACKETS: Lazy<Regex> = Lazy::new(|| re(r"\(.*?\)|\[.*?]"));
    static CREDIT: Lazy<Regex> = Lazy::new(|| re(r"\b(feat|ft|featuring|with)\b.*$"));
    static NON: Lazy<Regex> = Lazy::new(|| re(r"[^a-z0-9 ]+"));
    let s: String = s.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect::<String>().to_lowercase();
    let s = BRACKETS.replace_all(&s, " ");
    let s = CREDIT.replace(&s, "");
    let s = NON.replace_all(&s, " ");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_artists(artist: &str) -> Vec<String> {
    static SPLIT: Lazy<Regex> = Lazy::new(|| re(r"(?i),|;| & | x | and "));
    SPLIT.split(artist).map(normalize_for_match).filter(|a| a.len() > 1).collect()
}

/// Exact normalized title, every wanted artist credited.
fn is_match(got_name: &str, got_artists: &[String], want_name: &str, want_artist: &str) -> bool {
    if normalize_for_match(got_name) != normalize_for_match(want_name) {
        return false;
    }
    let wanted = split_artists(want_artist);
    let credited: Vec<String> = got_artists.iter().map(|a| normalize_for_match(a)).filter(|a| !a.is_empty()).collect();
    !wanted.is_empty() && !credited.is_empty() && wanted.iter().all(|w| credited.contains(w))
}

/// YouTube's packaging ("(Official Video)", "[4K]", "| Lyrical") that no catalogue has, off before searching.
fn cleaned(s: &str) -> String {
    static NOISE: Lazy<Regex> =
        Lazy::new(|| re(r"(?i)\((?:from|official|lyrical|video|audio)[^)]*\)|\[[^\]]*]|\b(?:official (?:video|audio|music video)|lyrical|full song|4k video)\b"));
    let t = NOISE.replace_all(s, " ");
    let t = t.split(" | ").next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        s.to_string()
    } else {
        t
    }
}

/// Only https video URLs: the index is third-party content handed to a media element.
fn canvas_url_ok(url: &str) -> bool {
    url::Url::parse(url).map(|u| u.scheme() == "https").unwrap_or(false)
}

async fn fetch_text(http: &reqwest::Client, url: &str, headers: &[(&str, &str)], timeout: Duration) -> Option<String> {
    let mut req = http.get(url).header("User-Agent", UA).timeout(timeout);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.text().await.ok()
}

/* ------------------------------ community ------------------------------ */

#[derive(Clone)]
struct CommunityEntry {
    song: String,
    artist: String,
    album: String,
    url: String,
}

#[derive(Default)]
struct Community {
    entries: Vec<CommunityEntry>,
    fetched: Option<Instant>,
}
static COMMUNITY: Lazy<Mutex<Community>> = Lazy::new(|| Mutex::new(Community::default()));

async fn community_manifest(http: &reqwest::Client) -> Vec<CommunityEntry> {
    {
        let c = COMMUNITY.lock().unwrap();
        if c.fetched.map(|at| at.elapsed() < COMMUNITY_TTL).unwrap_or(false) {
            return c.entries.clone();
        }
    }
    let fresh: Option<Vec<CommunityEntry>> = async {
        let body = fetch_text(http, COMMUNITY_MANIFEST, &[], Duration::from_secs(8)).await?;
        let arr: Vec<Value> = serde_json::from_str(&body).ok()?;
        Some(
            arr.iter()
                .map(|o| CommunityEntry {
                    song: o["song"].as_str().unwrap_or("").to_string(),
                    artist: o["artist"].as_str().unwrap_or("").to_string(),
                    album: o["album"].as_str().unwrap_or("").to_string(),
                    url: o["url"].as_str().unwrap_or("").to_string(),
                })
                .filter(|e| !e.song.is_empty() && !e.artist.is_empty() && canvas_url_ok(&e.url))
                .collect(),
        )
    }
    .await;
    let mut c = COMMUNITY.lock().unwrap();
    // Serve what we have rather than dropping canvas when the index can't be reached.
    if let Some(entries) = fresh {
        c.entries = entries;
    }
    c.fetched = Some(Instant::now());
    c.entries.clone()
}

async fn community_canvas(http: &reqwest::Client, title: &str, artist: &str, album: Option<&str>) -> Option<Hit> {
    let index = community_manifest(http).await;
    let (want_title, want_artist) = (normalize_for_match(title), normalize_for_match(artist));
    let want_album = album.map(normalize_for_match);
    index
        .iter()
        .find(|e| {
            let (song, credited, listed) = (normalize_for_match(&e.song), normalize_for_match(&e.artist), normalize_for_match(&e.album));
            let title_ok = !song.is_empty() && (want_title.contains(&song) || song.contains(&want_title));
            let artist_ok = !credited.is_empty() && (want_artist.contains(&credited) || credited.contains(&want_artist));
            let album_ok = listed.is_empty() || want_album.as_ref().map(|a| *a == listed).unwrap_or(true);
            title_ok && artist_ok && album_ok
        })
        .map(|e| Hit { url: e.url.clone(), source: "community" })
}

/* -------------------------------- tidal -------------------------------- */

fn tidal_cover_url(id: &str) -> Option<String> {
    let parts: Vec<&str> = id.split('-').collect();
    (parts.len() == 5).then(|| format!("https://resources.tidal.com/videos/{}/1280x1280.mp4", parts.join("/")))
}

async fn tidal_get(http: &reqwest::Client, query: &str, types: &str) -> Option<Vec<Value>> {
    let qs = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("query", query)
        .append_pair("limit", "10")
        .append_pair("types", types)
        .append_pair("countryCode", "US")
        .finish();
    let body = fetch_text(http, &format!("{TIDAL_SEARCH}?{qs}"), &[("X-Tidal-Token", TIDAL_EMBED_TOKEN)], Duration::from_secs(8)).await?;
    let json: Value = serde_json::from_str(&body).ok()?;
    let section = if types == "TRACKS" { &json["tracks"]["items"] } else { &json["albums"]["items"] };
    section.as_array().cloned()
}

fn names_of(artists: &Value) -> Vec<String> {
    artists.as_array().into_iter().flatten().map(|a| a["name"].as_str().unwrap_or("").to_string()).collect()
}

async fn tidal_canvas(http: &reqwest::Client, title: &str, artist: &str, album: Option<&str>) -> Option<Hit> {
    // Album-level first when the release is known: the cover belongs to the album in Tidal's model.
    if let Some(album) = album {
        for rec in tidal_get(http, &format!("{album} {artist}"), "ALBUMS").await.unwrap_or_default() {
            if !is_match(rec["title"].as_str().unwrap_or(""), &names_of(&rec["artists"]), album, artist) {
                continue;
            }
            if let Some(url) = rec["videoCover"].as_str().filter(|v| !v.is_empty()).and_then(tidal_cover_url) {
                return Some(Hit { url, source: "tidal" });
            }
        }
    }
    for item in tidal_get(http, &format!("{artist} {title}"), "TRACKS").await.unwrap_or_default() {
        if !is_match(item["title"].as_str().unwrap_or(""), &names_of(&item["artists"]), title, artist) {
            continue;
        }
        if let Some(url) = item["album"]["videoCover"].as_str().filter(|v| !v.is_empty()).and_then(tidal_cover_url) {
            return Some(Hit { url, source: "tidal" });
        }
    }
    None
}

/* -------------------------------- apple -------------------------------- */

/// The floor a hit must clear: exact artist and title alone make 25.
const APPLE_MIN_SCORE: i32 = 12;
/// On one side only, these mark a different master of the track, often with a different clip.
const EDITION_WORDS: &[&str] = &["deluxe", "expanded", "remastered", "remix", "version", "edit", "mix", "bonus"];
/// Playlists and radio mixes carry motion artwork of their own, which never belongs behind a track.
const COMPILATION_MARKERS: &[&str] = &["playlist", "set list", "essentials", "dj mix", "mixed", "apple music", "today's hits", "session"];

fn is_compilation(name: &str) -> bool {
    let n = name.to_lowercase();
    COMPILATION_MARKERS.iter().any(|m| n.contains(m))
}

/// Apple names a single "Daylight - Single" where YouTube Music says "Daylight".
fn album_key(album: &str) -> String {
    static SUFFIX: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s+-\s+(?:single|ep)$"));
    normalize_for_match(&SUFFIX.replace(album, ""))
}

/// How well an Apple search hit lines up with the track, or None to reject it outright. The artist is
/// a gate, not a score.
fn apple_score(name: &str, artist_name: &str, album_name: &str, title: &str, artist: &str, album: Option<&str>) -> Option<i32> {
    if is_compilation(name) || is_compilation(album_name) {
        return None;
    }
    let wanted = split_artists(artist);
    let credited = split_artists(artist_name);
    if wanted.is_empty() || credited.is_empty() || !wanted.iter().all(|w| credited.contains(w)) {
        return None;
    }
    let (want, got) = (normalize_for_match(title), normalize_for_match(name));
    let mut score = 10 + if got == want { 15 } else if got.contains(&want) || want.contains(&got) { 7 } else { -10 };
    if let Some(album) = album.filter(|_| !album_name.is_empty()) {
        let (wa, ga) = (album_key(album), album_key(album_name));
        score += if ga == wa { 20 } else if ga.contains(&wa) || wa.contains(&ga) { 10 } else { 0 };
    }
    let (tl, nl) = (title.to_lowercase(), name.to_lowercase());
    for word in EDITION_WORDS {
        let (in_wanted, in_hit) = (tl.contains(word), nl.contains(word));
        if in_wanted && in_hit {
            score += 5;
        } else if in_hit {
            score -= 3;
        }
    }
    Some(score)
}

#[derive(Default)]
struct AppleState {
    token: Option<(String, i64)>,
    retry_at: Option<Instant>,
    /// Tokens the catalog turned down: the bundle ships several JWTs, and only the web player's works.
    rejected: HashSet<String>,
}
static APPLE: Lazy<Mutex<AppleState>> = Lazy::new(|| Mutex::new(AppleState::default()));
static APPLE_READING: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// A JWT's expiry (ms), and whether it names itself the web player's (header kid, payload issuer).
fn read_jwt(jwt: &str) -> Option<(i64, bool)> {
    static EXP: Lazy<Regex> = Lazy::new(|| re(r#""exp"\s*:\s*(\d+)"#));
    let mut parts = jwt.split('.').map(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok().map(|b| String::from_utf8_lossy(&b).into_owned()));
    let header = parts.next()??;
    let payload = parts.next()??;
    let exp: i64 = EXP.captures(&payload)?[1].parse().ok()?;
    Some((exp * 1000, header.contains("WebPlayKid") || payload.contains("AMPWebPlay")))
}

/// The read-only token Apple Music's web player mints for anonymous visitors: its page, its script
/// bundle, the token inside. Held until shortly before it expires; a failed read waits half an hour.
async fn apple_bearer(http: &reqwest::Client) -> Option<String> {
    static SCRIPT: Lazy<Regex> = Lazy::new(|| re(r"/assets/index(?:-legacy)?[~-][A-Za-z0-9_-]+\.js"));
    static JWT: Lazy<Regex> = Lazy::new(|| re(r"ey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"));
    let now_ms = chrono::Utc::now().timestamp_millis();
    let fresh = |s: &AppleState| -> Option<String> { s.token.as_ref().filter(|(_, exp)| now_ms < exp - 60_000).map(|(t, _)| t.clone()) };
    {
        let s = APPLE.lock().unwrap();
        if let Some(t) = fresh(&s) {
            return Some(t);
        }
        if s.retry_at.map(|at| Instant::now() < at).unwrap_or(false) {
            return None;
        }
    }
    let _reading = APPLE_READING.lock().await;
    if let Some(t) = fresh(&APPLE.lock().unwrap()) {
        return Some(t);
    }
    let page = fetch_text(http, APPLE_WEB_PLAYER, &[], Duration::from_secs(8)).await.unwrap_or_default();
    let mut paths: Vec<String> = Vec::new();
    for m in SCRIPT.find_iter(&page) {
        if !paths.iter().any(|p| p == m.as_str()) {
            paths.push(m.as_str().to_string());
        }
    }
    for path in paths {
        let Some(script) = fetch_text(http, &format!("https://music.apple.com{path}"), &[], Duration::from_secs(20)).await else { continue };
        let rejected = APPLE.lock().unwrap().rejected.clone();
        let mut seen = HashSet::new();
        let usable: Vec<(String, i64, bool)> = JWT
            .find_iter(&script)
            .map(|m| m.as_str().to_string())
            .filter(|j| seen.insert(j.clone()) && !rejected.contains(j))
            .filter_map(|j| read_jwt(&j).filter(|(exp, _)| *exp > chrono::Utc::now().timestamp_millis()).map(|(exp, web)| (j, exp, web)))
            .collect();
        if let Some((jwt, exp, _)) = usable.iter().find(|t| t.2).or(usable.first()).cloned() {
            APPLE.lock().unwrap().token = Some((jwt.clone(), exp));
            return Some(jwt);
        }
    }
    APPLE.lock().unwrap().retry_at = Some(Instant::now() + APPLE_TOKEN_RETRY);
    None
}

/// A catalog read. A 401 means this isn't the token the catalog honours: it's struck off.
async fn apple_get(http: &reqwest::Client, url: &str, bearer: &str) -> Option<Value> {
    let res = http
        .get(url)
        .header("Authorization", format!("Bearer {bearer}"))
        .header("Origin", "https://music.apple.com")
        .header("Referer", "https://music.apple.com/")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if res.status().as_u16() == 401 {
        let mut s = APPLE.lock().unwrap();
        s.rejected.insert(bearer.to_string());
        if s.token.as_ref().map(|(t, _)| t == bearer).unwrap_or(false) {
            s.token = None;
        }
    }
    if !res.status().is_success() {
        return None;
    }
    res.json().await.ok()
}

/// The renditions to try: square first (it fills a square sleeve uncropped), then the raw one, then 3:4.
fn motion_urls(video: &Value) -> Vec<String> {
    let link = |key: &str| -> Option<String> {
        let asset = &video[key];
        ["video", "videoUrl", "hlsUrl", "url"].iter().find_map(|k| asset[*k].as_str().filter(|u| !u.is_empty()).map(String::from))
    };
    let mut out: Vec<String> = Vec::new();
    for url in [link("motionDetailSquare").or_else(|| link("motionSquareVideo1x1")), link("motionDetailRaw"), link("motionDetailTall").or_else(|| link("motionTallVideo3x4"))]
        .into_iter()
        .flatten()
    {
        if canvas_url_ok(&url) && !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

fn join_url(base: &str, uri: &str) -> Option<String> {
    url::Url::parse(base).ok()?.join(uri).ok().map(|u| u.to_string())
}

/// The H.264 rendition in an HLS master playlist with the most pixels, at its lowest rate.
fn hls_variant(master: &str, base: &str) -> Option<String> {
    static AVC: Lazy<Regex> = Lazy::new(|| re(r#"CODECS="[^"]*\bavc1\."#));
    static RES: Lazy<Regex> = Lazy::new(|| re(r"RESOLUTION=(\d+)x(\d+)"));
    static BW: Lazy<Regex> = Lazy::new(|| re(r"[:,]BANDWIDTH=(\d+)"));
    let lines: Vec<&str> = master.lines().collect();
    let mut best: Option<(String, u64, u64)> = None;
    for i in 0..lines.len() {
        if !lines[i].starts_with("#EXT-X-STREAM-INF:") || !AVC.is_match(lines[i]) {
            continue;
        }
        let (Some(size), Some(uri)) = (RES.captures(lines[i]), lines.get(i + 1).map(|l| l.trim())) else { continue };
        if uri.is_empty() || uri.starts_with('#') {
            continue;
        }
        let px = size[1].parse::<u64>().unwrap_or(0) * size[2].parse::<u64>().unwrap_or(0);
        let bw = BW.captures(lines[i]).and_then(|c| c[1].parse::<u64>().ok()).unwrap_or(u64::MAX);
        let better = match &best {
            None => true,
            Some((_, bpx, bbw)) => px > *bpx || (px == *bpx && bw < *bbw),
        };
        if better {
            if let Some(url) = join_url(base, uri) {
                best = Some((url, px, bw));
            }
        }
    }
    best.map(|b| b.0)
}

/// The one file behind an HLS media playlist, when every segment is a byte range of the file its init
/// segment opens: a whole fragmented MP4, which the player's <video> plays.
fn hls_single_file(media: &str, base: &str) -> Option<String> {
    static MAP: Lazy<Regex> = Lazy::new(|| re(r#"#EXT-X-MAP:URI="([^"]+)""#));
    let init = MAP.captures(media)?[1].to_string();
    let segments: Vec<&str> = media.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect();
    if segments.is_empty() || segments.iter().any(|s| *s != init) {
        return None;
    }
    join_url(base, &init).filter(|u| canvas_url_ok(u))
}

async fn apple_mp4(http: &reqwest::Client, master_url: &str) -> Option<String> {
    let master = fetch_text(http, master_url, &[], Duration::from_secs(8)).await?;
    let variant = hls_variant(&master, master_url)?;
    let media = fetch_text(http, &variant, &[], Duration::from_secs(8)).await?;
    hls_single_file(&media, &variant)
}

async fn apple_canvas(http: &reqwest::Client, store: &str, title: &str, artist: &str, album: Option<&str>) -> Option<Hit> {
    static ALBUM_ID: Lazy<Regex> = Lazy::new(|| re(r"/album/[^/?]+/(\d+)"));
    let bearer = apple_bearer(http).await?;
    // Everything known goes into the term: an artist alone pulls in their whole discography.
    let lower = title.to_lowercase();
    let term = [
        if lower.contains(&artist.to_lowercase()) { "" } else { artist },
        title,
        match album {
            Some(a) if !lower.contains(&a.to_lowercase()) => a,
            _ => "",
        },
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let qs = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("term", &term)
        .append_pair("types", "songs")
        .append_pair("limit", "10")
        .append_pair("extend", "editorialVideo")
        .append_pair("include", "albums")
        .finish();
    let found = apple_get(http, &format!("{APPLE_CATALOG}/{store}/search?{qs}"), &bearer).await?;
    let songs = found["results"]["songs"]["data"].as_array()?.clone();
    let mut ranked: Vec<(i32, &Value)> = songs
        .iter()
        .filter_map(|song| {
            let a = &song["attributes"];
            let score = apple_score(a["name"].as_str().unwrap_or(""), a["artistName"].as_str().unwrap_or(""), a["albumName"].as_str().unwrap_or(""), title, artist, album)?;
            (score >= APPLE_MIN_SCORE).then_some((score, song))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let mut tried = HashSet::new();
    for (_, song) in ranked {
        let a = &song["attributes"];
        let (name, album_name) = (a["name"].as_str().unwrap_or(""), a["albumName"].as_str().unwrap_or(""));
        // The last word, as on every source: the same title, and the same album when both sides know it.
        if normalize_for_match(name) != normalize_for_match(title) {
            continue;
        }
        if let Some(al) = album {
            if !album_name.is_empty() && album_key(album_name) != album_key(al) {
                continue;
            }
        }
        let mut video = a["editorialVideo"].clone();
        if video.is_null() {
            // Not every hit expands its album, but the song's web address always ends in the album's id.
            let id = song["relationships"]["albums"]["data"][0]["id"]
                .as_str()
                .map(String::from)
                .or_else(|| ALBUM_ID.captures(a["url"].as_str().unwrap_or("")).map(|c| c[1].to_string()));
            let Some(id) = id.filter(|i| i.chars().all(|c| c.is_ascii_digit()) && !i.is_empty()) else { continue };
            if !tried.insert(id.clone()) {
                continue;
            }
            let rec = apple_get(http, &format!("{APPLE_CATALOG}/{store}/albums/{id}?extend=editorialVideo"), &bearer).await;
            let Some(attrs) = rec.as_ref().map(|r| r["data"][0]["attributes"].clone()).filter(|a| a.is_object()) else { continue };
            if is_compilation(attrs["name"].as_str().unwrap_or("")) {
                continue;
            }
            video = attrs["editorialVideo"].clone();
        }
        for master in motion_urls(&video) {
            if let Some(url) = apple_mp4(http, &master).await {
                return Some(Hit { url, source: "apple" });
            }
        }
    }
    None
}

/* -------------------------------- cache -------------------------------- */

static CACHE: Lazy<Mutex<(HashMap<String, Option<Hit>>, VecDeque<String>)>> = Lazy::new(|| Mutex::new((HashMap::new(), VecDeque::new())));
/// One lookup per track at a time: a second ask for the same track waits for the first.
static IN_FLIGHT: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// The canvas for a track, or null. Never fails; a local file has no catalogue identity worth searching on.
pub async fn canvas_for(st: &AppState, raw_title: &str, raw_artist: &str, raw_album: Option<&str>) -> Value {
    let title = cleaned(raw_title);
    let artist = cleaned(raw_artist);
    let album = raw_album.filter(|a| !a.trim().is_empty()).map(cleaned);
    if normalize_for_match(&title).is_empty() || normalize_for_match(&artist).is_empty() {
        return Value::Null;
    }
    let key = format!("{}|{}|{}", normalize_for_match(&title), normalize_for_match(&artist), album.as_deref().map(normalize_for_match).unwrap_or_default());
    let as_json = |hit: Option<Hit>| hit.map(|h| json!({ "url": h.url, "source": h.source })).unwrap_or(Value::Null);
    if let Some(hit) = CACHE.lock().unwrap().0.get(&key) {
        return as_json(hit.clone());
    }
    let _one = IN_FLIGHT.lock().await;
    if let Some(hit) = CACHE.lock().unwrap().0.get(&key) {
        return as_json(hit.clone());
    }
    let http = &st.music.http;
    // Motion artwork is per storefront: the listener's own country's.
    let country = st.music.current_market()["country"].as_str().unwrap_or("us").to_lowercase();
    let store = if country.len() == 2 && country.chars().all(|c| c.is_ascii_alphabetic()) { country } else { "us".into() };
    let album_ref = album.as_deref();
    let mut hit = apple_canvas(http, &store, &title, &artist, album_ref).await;
    if hit.is_none() {
        hit = tidal_canvas(http, &title, &artist, album_ref).await;
    }
    if hit.is_none() {
        hit = community_canvas(http, &title, &artist, album_ref).await;
    }
    if hit.is_none() {
        let term = [title.as_str(), artist.as_str(), album_ref.unwrap_or("")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
        hit = st
            .spotify
            .canvas(http, st, &term, |h| is_match(&h.name, &h.artists, &title, &artist))
            .await
            .filter(|(url, _)| canvas_url_ok(url))
            .map(|(url, _)| Hit { url, source: "spotify" });
    }
    let mut cache = CACHE.lock().unwrap();
    if cache.0.insert(key.clone(), hit.clone()).is_none() {
        cache.1.push_back(key);
    }
    while cache.1.len() > CACHE_MAX {
        if let Some(old) = cache.1.pop_front() {
            cache.0.remove(&old);
        }
    }
    as_json(hit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_and_scores() {
        assert!(is_match("Blinding Lights", &["The Weeknd".into()], "Blinding Lights (Official Video)", "The Weeknd"));
        assert!(!is_match("Blinding Lights", &["Someone".into()], "Blinding Lights", "The Weeknd"));
        assert_eq!(apple_score("Daylight", "David Kushner", "Daylight - Single", "Daylight", "David Kushner", Some("Daylight")), Some(45));
        assert_eq!(apple_score("Daylight", "Other", "Daylight", "Daylight", "David Kushner", None), None);
        assert_eq!(apple_score("Today's Hits", "David Kushner", "Today's Hits", "Daylight", "David Kushner", None), None);
    }

    #[test]
    fn hls() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=720x720,CODECS=\"avc1.640020\"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1080x1080,CODECS=\"avc1.640028\"\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=2160x2160,CODECS=\"hvc1.2\"\nhevc.m3u8\n";
        assert_eq!(hls_variant(master, "https://a.example/v/master.m3u8").as_deref(), Some("https://a.example/v/high.m3u8"));
        let media = "#EXTM3U\n#EXT-X-MAP:URI=\"clip.mp4\",BYTERANGE=\"800@0\"\n#EXTINF:5,\n#EXT-X-BYTERANGE:1000@800\nclip.mp4\n#EXTINF:5,\nclip.mp4\n";
        assert_eq!(hls_single_file(media, "https://a.example/v/high.m3u8").as_deref(), Some("https://a.example/v/clip.mp4"));
    }
}
