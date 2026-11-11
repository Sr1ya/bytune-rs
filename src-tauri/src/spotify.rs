//! Spotify — a port of ByTune's `electron/spotify.ts`, `electron/spotify-web.ts` and
//! `electron/track-match.ts`. Two things, both unofficial (Spotify's own pages and web player, not an
//! API), so either may change or stop working:
//!  - a public playlist link, read without signing in: the embed page, then the web player's
//!    playlist query with the anonymous token that page hands out (for songs past its 100);
//!  - Connect Spotify: the listener signs in to Spotify in a locked-down private window, and their
//!    own session reads their playlists and Liked Songs (and Spotify's own Canvas clips).
//! The session cookie is sealed in the OS keychain, one per ByTune owner (an account, or the guest):
//! signing out and back in finds it again, another account never sees it, and a guest who creates an
//! account brings it along. It never reaches the page, sync or backups.
//!
//! Each song is matched to a YouTube Music song by title words, version marks ("live", "remix"…),
//! credited artists and length.

use crate::music::Music;
use crate::persist::Persist;
use crate::state::AppState;
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
/// The sign-in window's own user agent. Only WebKitGTK gets one: its default isn't one Spotify knows.
/// WebView2 (Windows) and WKWebView (macOS) keep theirs — a Linux Chrome agent there contradicts the
/// engine's client hints (Sec-CH-UA-Platform: "Windows"), and Spotify's bot check refuses the sign-in.
#[cfg(target_os = "linux")]
const SIGN_IN_UA: Option<&str> = Some(UA);
#[cfg(not(target_os = "linux"))]
const SIGN_IN_UA: Option<&str> = None;
/// Google's sign-in refuses a Chrome agent that isn't Chrome ("This browser or app may not be
/// secure"); WebKit's own site quirk for accounts.google.com is a Firefox agent, so that's used there.
#[cfg(target_os = "linux")]
const GOOGLE_UA: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const WEB: &str = "https://open.spotify.com";
const PATHFINDER: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
/// The last query hashes known to work (the web player, 2026-11-03); its live script wins.
const KNOWN_HASHES: &[(&str, &str)] = &[
    ("fetchPlaylist", "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf"),
    ("libraryV3", "390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455"),
    ("fetchLibraryTracks", "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240"),
    ("profileAttributes", "08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0"),
    ("searchTracks", "bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428"),
    ("canvas", "575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f"),
];
const STORE: &str = "spotify";
const MAX_PLAYLISTS: usize = 1000;
pub const LIKED_ID: &str = "liked";
const CHANGED: &str = "Spotify changed something, so ByTune couldn't read it. Try again later, or reconnect Spotify.";
const EXPIRED: &str = "Your Spotify session has ended. Connect Spotify again.";
const LOGIN_WINDOW: &str = "spotify-login";
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
    /// The web player's token secret and query hashes, as last read from its script.
    player: Mutex<Option<Player>>,
    /// The current owner's connection this session: its token, and why it last failed.
    live: Mutex<Live>,
    /// A sign-in in progress: its outcome, for anyone else waiting on it.
    connecting: Mutex<Option<tokio::sync::watch::Receiver<Option<Value>>>>,
}

#[derive(Clone, Default, serde::Serialize, Deserialize)]
struct Player {
    secret: Option<PlayerSecret>,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

#[derive(Clone, serde::Serialize, Deserialize)]
struct PlayerSecret {
    version: u32,
    secret: String,
}

#[derive(Default)]
struct Live {
    owner: String,
    access: Option<(String, i64)>,
    problem: Option<String>,
}

/// Why a signed-in read failed: the session itself (connect again), or anything else.
enum Fail {
    Session(String),
    Other(String),
}

impl From<String> for Fail {
    fn from(s: String) -> Self {
        Fail::Other(s)
    }
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

/// A playlist's name, owner and cover, from a fetchPlaylist answer.
fn playlist_meta(body: &Value) -> Value {
    let p = at(body, &["data", "playlistV2"]);
    let mut meta = json!({ "name": str_of(&p["name"]).unwrap_or_else(|| "Spotify playlist".into()) });
    if let Some(owner) = str_of(at(p, &["ownerV2", "data", "name"])) {
        meta["owner"] = json!(owner);
    }
    if let Some(thumb) = largest(at(&at(p, &["images", "items"])[0], &["sources"])) {
        meta["thumb"] = json!(thumb);
    }
    meta
}

/// One page of Liked Songs (fetchLibraryTracks).
fn parse_liked_page(body: &Value) -> Result<(Vec<Value>, usize), String> {
    let tracks = at(body, &["data", "me", "library", "tracks"]);
    if !tracks.is_object() {
        return Err("Spotify's liked songs answer didn't read".into());
    }
    let songs: Vec<Value> = tracks["items"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| song_of(at(item, &["track", "data"]), at(item, &["track", "_uri"]))).collect())
        .unwrap_or_default();
    let total = tracks["totalCount"].as_u64().map(|t| t as usize).unwrap_or(songs.len());
    Ok((songs, total))
}

/// One page of the library's playlists (libraryV3 with the Playlists filter): (playlists, total, read).
fn parse_library_page(body: &Value) -> Result<(Vec<Value>, usize, usize), String> {
    static ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^spotify:playlist:([A-Za-z0-9]{22})$").unwrap());
    let library = at(body, &["data", "me", "libraryV3"]);
    if !library.is_object() {
        return Err("Spotify's library answer didn't read".into());
    }
    let items = library["items"].as_array().cloned().unwrap_or_default();
    let playlists = items
        .iter()
        .filter_map(|entry| {
            let wrapper = &entry["item"];
            let data = &wrapper["data"];
            let id = ID.captures(wrapper["_uri"].as_str()?)?[1].to_string();
            let name = str_of(&data["name"])?;
            if data["__typename"] != "Playlist" {
                return None;
            }
            let mut p = json!({ "id": id, "name": name });
            if let Some(owner) = str_of(at(data, &["ownerV2", "data", "name"])) {
                p["owner"] = json!(owner);
            }
            if let Some(thumb) = largest(at(&at(data, &["images", "items"])[0], &["sources"])) {
                p["thumb"] = json!(thumb);
            }
            Some(p)
        })
        .collect();
    let total = library["totalCount"].as_u64().map(|t| t as usize).unwrap_or(items.len());
    Ok((playlists, total, items.len()))
}

/// The signed-in account's display name (profileAttributes).
fn parse_profile_name(body: &Value) -> Result<String, String> {
    let profile = at(body, &["data", "me", "profile"]);
    if !profile.is_object() {
        return Err("Spotify's profile answer didn't read".into());
    }
    Ok(str_of(&profile["name"]).or_else(|| str_of(&profile["username"])).unwrap_or_else(|| "Spotify".into()))
}

/// A JavaScript string literal's body, unescaped (the script writes its secrets as literals).
fn unescape_js(body: &str) -> String {
    let mut out = String::new();
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(e) = chars.next() else { break };
        match e {
            'u' if chars.peek() == Some(&'{') => {
                chars.next();
                let hex: String = chars.by_ref().take_while(|c| *c != '}').collect();
                out.extend(u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32));
            }
            'u' => {
                let hex: String = chars.by_ref().take(4).collect();
                out.extend(u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32));
            }
            'x' => {
                let hex: String = chars.by_ref().take(2).collect();
                out.extend(u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32));
            }
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'v' => out.push('\u{b}'),
            '0' => out.push('\0'),
            other => out.push(other),
        }
    }
    out
}

/// The newest token secret the web player's script declares (`{secret:'…',version:61}`). Two plain
/// patterns, one per quote: a back-referencing one (fancy-regex) backtracked for minutes over the 4.5 MB
/// script and hung the sign-in after the session was captured.
fn player_secret(script: &str) -> Option<PlayerSecret> {
    static SINGLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{secret:'((?:\\.|[^'\\])*)',version:(\d+)\}").unwrap());
    static DOUBLE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\{secret:"((?:\\.|[^"\\])*)",version:(\d+)\}"#).unwrap());
    SINGLE
        .captures_iter(script)
        .chain(DOUBLE.captures_iter(script))
        .filter_map(|c| Some(PlayerSecret { version: c.get(2)?.as_str().parse().ok()?, secret: unescape_js(c.get(1)?.as_str()) }))
        .max_by_key(|p| p.version)
}

/// RFC 4226: six digits from an HMAC-SHA1 over the counter.
fn hotp(key: &[u8], counter: u64) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(key).expect("any key length");
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let o = (h[h.len() - 1] & 0x0f) as usize;
    let code = ((h[o] as u32 & 0x7f) << 24) | ((h[o + 1] as u32) << 16) | ((h[o + 2] as u32) << 8) | h[o + 3] as u32;
    format!("{:06}", code % 1_000_000)
}

/// The web player's token code: thirty-second steps, keyed by the secret's character codes XORed with
/// their index, written out as decimal digits.
fn player_totp(secret: &str, epoch_ms: i64) -> String {
    let key: String = secret.encode_utf16().enumerate().map(|(i, c)| (c as u32 ^ ((i as u32 % 33) + 9)).to_string()).collect();
    hotp(key.as_bytes(), (epoch_ms / 30_000) as u64)
}

/// One track of the web player's searchTracks answer.
#[derive(Clone, Debug)]
pub struct TrackHit {
    pub uri: String,
    pub name: String,
    pub artists: Vec<String>,
    /// Kept for a caller that wants to check the release (ByTune's hit carries it).
    #[allow(dead_code)]
    pub album: String,
}

fn parse_track_search(body: &Value) -> Vec<TrackHit> {
    at(body, &["data", "searchV2", "tracksV2", "items"])
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let d = at(item, &["item", "data"]);
            let uri = str_of(&d["uri"]).filter(|u| u.starts_with("spotify:track:"))?;
            let name = str_of(&d["name"])?;
            let artists = at(d, &["artists", "items"]).as_array().into_iter().flatten().filter_map(|a| str_of(at(a, &["profile", "name"]))).collect();
            Some(TrackHit { uri, name, artists, album: str_of(at(d, &["albumOfTrack", "name"])).unwrap_or_default() })
        })
        .collect()
}

/// A Canvas that is a video at an https URL; some are still images, which the player doesn't show.
fn canvas_video(url: Option<String>) -> Option<String> {
    static MP4: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\.mp4(?:[?#]|$)").unwrap());
    url.filter(|u| u.starts_with("https://") && MP4.is_match(u))
}

fn varint(mut n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while n > 0x7f {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
    out
}

fn field1(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![0x0a];
    out.extend(varint(bytes.len()));
    out.extend_from_slice(bytes);
    out
}

/// A protobuf message's fields: varints as numbers, length-delimited ones as bytes.
fn proto_fields(bytes: &[u8]) -> Vec<(u64, Result<u64, &[u8]>)> {
    let mut out = Vec::new();
    let mut i = 0;
    let read = |i: &mut usize| -> Option<u64> {
        let mut n: u64 = 0;
        for shift in (0..=49).step_by(7) {
            let b = *bytes.get(*i)?;
            *i += 1;
            n |= ((b & 0x7f) as u64) << shift;
            if b < 0x80 {
                return Some(n);
            }
        }
        None
    };
    while i < bytes.len() {
        let Some(tag) = read(&mut i) else { break };
        match tag % 8 {
            0 => match read(&mut i) {
                Some(v) => out.push((tag / 8, Ok(v))),
                None => break,
            },
            2 => {
                let Some(len) = read(&mut i) else { break };
                let end = i + len as usize;
                if end > bytes.len() {
                    break;
                }
                out.push((tag / 8, Err(&bytes[i..end])));
                i = end;
            }
            1 => i += 8,
            5 => i += 4,
            _ => break,
        }
    }
    out
}

/// The clip in canvaz-cache's answer: this track's own first, else the first; when the fields don't
/// read, any .cnvs.mp4 URL in the bytes.
fn canvaz_clip(bytes: &[u8], track_uri: &str) -> Option<String> {
    let mut hits: Vec<(String, Option<String>)> = Vec::new();
    for (n, canvas) in proto_fields(bytes) {
        let (1, Err(canvas)) = (n, canvas) else { continue };
        let (mut url, mut track) = (None, None);
        for (f, v) in proto_fields(canvas) {
            if let Err(b) = v {
                match f {
                    2 => url = Some(String::from_utf8_lossy(b).into_owned()),
                    5 => track = Some(String::from_utf8_lossy(b).into_owned()),
                    _ => {}
                }
            }
        }
        if let Some(u) = url {
            hits.push((u, track));
        }
    }
    let from_fields = hits.iter().find(|h| h.1.as_deref() == Some(track_uri)).or(hits.first()).map(|h| h.0.clone());
    let url = from_fields.or_else(|| {
        static CNVS: Lazy<Regex> = Lazy::new(|| Regex::new(r#"https://[^"'\s\x00-\x1F]+\.cnvs\.mp4"#).unwrap());
        let latin: String = bytes.iter().map(|b| *b as char).collect();
        CNVS.find(&latin).map(|m| m.as_str().to_string())
    });
    canvas_video(url)
}

/// A cookie value as RFC 6265 allows one: safe in a header.
fn cookie_ok(value: &str) -> bool {
    (20..=4096).contains(&value.len()) && value.bytes().all(|b| matches!(b, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e))
}

/// Pages the sign-in window may show: Spotify's, and its sign-in partners'. The webview asks this for
/// the frames inside a page too (WebKitGTK does), so Spotify's reCAPTCHA frame — Google's
/// /recaptcha/ pages, nothing else of Google's — is allowed; without it every sign-in fails.
fn sign_in_url(url: &url::Url) -> bool {
    static HOST: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)^(?:[a-z0-9-]+\.)*spotify\.com$|^appleid\.apple\.com$|^(?:www|m)\.facebook\.com$|^(?:gds|consent)\.google\.com$|^consent\.youtube\.com$")
            .unwrap()
    });
    static CAPTCHA: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(?:www\.google\.com|www\.recaptcha\.net)$").unwrap());
    if url.scheme() == "about" {
        return true; // about:blank frames the sign-in pages create
    }
    let Some(host) = url.host_str() else { return false };
    // Google sign-in checks the browser's Google session through YouTube's accounts pages, and once
    // signed in hands the session on through them and the country's accounts.google.<tld> (SetSID).
    let youtube_accounts = host.eq_ignore_ascii_case("accounts.youtube.com") && url.path().starts_with("/accounts/");
    url.scheme() == "https"
        && (HOST.is_match(host) || google_accounts(host) || youtube_accounts || (CAPTCHA.is_match(host) && url.path().starts_with("/recaptcha/")))
}

/// Google's accounts pages: accounts.google.com and its country twins (accounts.google.co.in, .de…).
fn google_accounts(host: &str) -> bool {
    static GOOGLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^accounts\.google\.(?:com|(?:co|com)\.[a-z]{2}|[a-z]{2})$").unwrap());
    GOOGLE.is_match(host)
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

/// The best candidate that is the target. On a tie the earlier one wins — the search's own order, as
/// in ByTune (`max_by` would take the last, and put "Song (Original Piano Demo)" over "Song").
fn best_match(target: &ImportSong, candidates: &[Track], prefer: &str) -> Option<Track> {
    let mut best: Option<(f64, &Track)> = None;
    for song in candidates.iter().filter(|s| !s.id.is_empty()) {
        if let Some(score) = match_score(target, song, prefer) {
            if best.map(|(b, _)| score > b).unwrap_or(true) {
                best = Some((score, song));
            }
        }
    }
    best.map(|(_, s)| s.clone())
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
        Self {
            matches: Mutex::new(None),
            searching: tokio::sync::Semaphore::new(4),
            player: Mutex::new(None),
            live: Mutex::new(Live::default()),
            connecting: Mutex::new(None),
        }
    }

    async fn get(&self, http: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
        http.get(url).header("User-Agent", UA).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())
    }

    /* ---------------- the web player's script ---------------- */

    fn known_player(&self, persist: &Persist) -> Option<Player> {
        let mut guard = self.player.lock().unwrap();
        if guard.is_none() {
            *guard = serde_json::from_value(persist.read(STORE)["player"].clone()).ok();
        }
        guard.clone()
    }

    fn hash_of(&self, persist: &Persist, op: &str) -> String {
        self.known_player(persist)
            .and_then(|p| p.hashes.get(op).cloned())
            .or_else(|| KNOWN_HASHES.iter().find(|(k, _)| *k == op).map(|(_, h)| h.to_string()))
            .unwrap_or_default()
    }

    /// Its token secret and query hashes, read from its 4 MB script (once, then when they stop working).
    async fn read_player(&self, http: &reqwest::Client, persist: &Persist) -> Result<Player, String> {
        static SCRIPT: Lazy<Regex> = Lazy::new(|| Regex::new(r"https://open\.spotifycdn\.com/cdn/build/web-player/web-player\.[0-9a-f]+\.js").unwrap());
        let page = self.get(http, &format!("{WEB}/")).await?.text().await.map_err(|e| e.to_string())?;
        let url = SCRIPT.find(&page).ok_or("No web player script on Spotify's page")?.as_str().to_string();
        let script = self.get(http, &url).await?.text().await.map_err(|e| e.to_string())?;
        let mut hashes = HashMap::new();
        for (op, _) in KNOWN_HASHES {
            let re = Regex::new(&format!(r#"["']{op}["']\s*,\s*["']query["']\s*,\s*["']([0-9a-f]{{64}})["']"#)).unwrap();
            if let Some(c) = re.captures(&script) {
                hashes.insert(op.to_string(), c[1].to_string());
            }
        }
        let player = Player { secret: player_secret(&script), hashes };
        *self.player.lock().unwrap() = Some(player.clone());
        let mut saved = persist.read(STORE);
        if !saved.is_object() {
            saved = json!({});
        }
        saved["player"] = json!(player);
        let _ = persist.write(STORE, &saved).await;
        Ok(player)
    }

    /// One web player query. A retired hash rereads the script once; 401 is the session's to handle.
    async fn query(&self, http: &reqwest::Client, persist: &Persist, op: &str, variables: Value, token: &str) -> Result<Value, Fail> {
        let mut retried = false;
        loop {
            let body = json!({ "variables": variables, "operationName": op, "extensions": { "persistedQuery": { "version": 1, "sha256Hash": self.hash_of(persist, op) } } });
            let res = http
                .post(PATHFINDER)
                .header("User-Agent", UA)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/json")
                .header("App-Platform", "WebPlayer")
                .header("Content-Type", "application/json;charset=UTF-8")
                .timeout(Duration::from_secs(15))
                .json(&body)
                .send()
                .await
                .map_err(|e| Fail::Other(e.to_string()))?;
            let status = res.status();
            if status.as_u16() == 401 {
                return Err(Fail::Session(EXPIRED.into()));
            }
            let json: Value = res.json().await.unwrap_or(Value::Null);
            let not_found = json["errors"].as_array().map(|e| e.iter().any(|x| x["message"].as_str().unwrap_or("").contains("PersistedQueryNotFound"))).unwrap_or(false);
            if not_found && !retried {
                retried = true;
                self.read_player(http, persist).await.map_err(Fail::Other)?;
                continue;
            }
            if !status.is_success() || json["data"].is_null() {
                return Err(Fail::Other(format!("Spotify's {op} answered {status}")));
            }
            return Ok(json);
        }
    }

    async fn read_playlist(&self, http: &reqwest::Client, persist: &Persist, id: &str, token: &str) -> Result<(Vec<Value>, usize), Fail> {
        let mut songs = Vec::new();
        let mut total = usize::MAX;
        let mut offset = 0;
        while offset < total.min(MAX_SONGS) {
            let vars = json!({ "uri": format!("spotify:playlist:{id}"), "offset": offset, "limit": 100, "enableWatchFeedEntrypoint": false });
            let json = self.query(http, persist, "fetchPlaylist", vars, token).await?;
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

    pub async fn public_playlist(&self, http: &reqwest::Client, persist: &Persist, link: &str) -> Result<Value, String> {
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
            match self.read_playlist(http, persist, &id, &token).await {
                Ok((songs, total)) if !songs.is_empty() => {
                    embed["songs"] = json!(songs);
                    embed["total"] = json!(total);
                }
                Ok(_) => {}
                Err(Fail::Session(e) | Fail::Other(e)) => log::warn!("spotify: reading the whole playlist failed, keeping the embed's songs: {e}"),
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

    /* ---------------- Connect Spotify ---------------- */

    fn saved(st: &AppState) -> Value {
        let v = st.persist.read(STORE);
        if v.is_object() {
            v
        } else {
            json!({})
        }
    }

    fn account(st: &AppState, owner: &str) -> Value {
        Self::saved(st)["owners"][owner].clone()
    }

    /// Updates one owner's record (None removes it, its sealed cookie included).
    async fn save_account(st: &AppState, owner: &str, patch: Option<Value>) {
        let mut saved = Self::saved(st);
        if !saved["owners"].is_object() {
            saved["owners"] = json!({});
        }
        match patch {
            Some(Value::Object(fields)) => {
                let rec = &mut saved["owners"][owner];
                if !rec.is_object() {
                    *rec = json!({});
                }
                for (k, v) in fields {
                    rec[k] = v;
                }
            }
            _ => {
                if let Some(sealed) = saved["owners"][owner]["cookie"].as_str() {
                    crate::cloud::forget_secret(sealed);
                }
                saved["owners"].as_object_mut().map(|o| o.remove(owner));
            }
        }
        let _ = st.persist.write(STORE, &saved).await;
    }

    fn secret_name(owner: &str) -> String {
        use sha2::Digest;
        format!("spotify-{}", &hex::encode(sha2::Sha256::digest(owner.as_bytes()))[..16])
    }

    /// This session's state for the current owner: nothing minted for another one carries over.
    fn here<'a>(&'a self, owner: &str) -> std::sync::MutexGuard<'a, Live> {
        let mut live = self.live.lock().unwrap();
        if live.owner != owner {
            *live = Live { owner: owner.to_string(), ..Default::default() };
        }
        live
    }

    /// A web player token for the signed-in listener. A retired secret rereads the script once.
    async fn mint(&self, http: &reqwest::Client, persist: &Persist, cookie: &str) -> Result<(String, i64), Fail> {
        let mut fresh = false;
        loop {
            let player = match self.known_player(persist).filter(|p| p.secret.is_some() && !fresh) {
                Some(p) => p,
                None => self.read_player(http, persist).await.map_err(Fail::Other)?,
            };
            let secret = player.secret.ok_or_else(|| Fail::Other("No token secret in the web player's script".into()))?;
            let code = player_totp(&secret.secret, chrono::Utc::now().timestamp_millis());
            let version = secret.version.to_string();
            let qs = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("reason", "init")
                .append_pair("productType", "web-player")
                .append_pair("totp", &code)
                .append_pair("totpServer", &code)
                .append_pair("totpVer", &version)
                .finish();
            let res = http
                .get(format!("{WEB}/api/token?{qs}"))
                .header("User-Agent", UA)
                .header("Cookie", format!("sp_dc={cookie}"))
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| Fail::Other(e.to_string()))?;
            let status = res.status().as_u16();
            let body: Value = res.json().await.unwrap_or(json!({}));
            if status == 401 || body["isAnonymous"] == json!(true) {
                return Err(Fail::Session(EXPIRED.into()));
            }
            if !fresh && (status == 400 || body["totpVerExpired"].as_bool().unwrap_or(false)) {
                fresh = true;
                continue;
            }
            let token = body["accessToken"].as_str().ok_or_else(|| Fail::Other(format!("Spotify's token answered {status}")))?;
            let expires = body["accessTokenExpirationTimestampMs"].as_i64().unwrap_or_else(|| chrono::Utc::now().timestamp_millis() + 3_600_000);
            return Ok((token.to_string(), expires));
        }
    }

    async fn user_token(&self, http: &reqwest::Client, st: &AppState, owner: &str) -> Result<String, Fail> {
        if let Some((token, expires)) = self.here(owner).access.clone() {
            if chrono::Utc::now().timestamp_millis() < expires - 30_000 {
                return Ok(token);
            }
        }
        let sealed = Self::account(st, owner)["cookie"].as_str().unwrap_or("").to_string();
        let cookie = crate::cloud::open_secret(&sealed);
        if cookie.is_empty() {
            return Err(Fail::Session("Connect Spotify first.".into()));
        }
        let access = self.mint(http, &st.persist, &cookie).await?;
        self.here(owner).access = Some(access.clone());
        Ok(access.0)
    }

    /// Runs a signed-in read; an expired token is renewed once, and a failure is remembered for Settings.
    async fn signed_in<T, F, Fut>(&self, http: &reqwest::Client, st: &AppState, read: F) -> Result<T, String>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<T, Fail>>,
    {
        let owner = crate::cloud::current_owner(st);
        let attempt = async {
            let first = read(self.user_token(http, st, &owner).await?).await;
            match first {
                Err(Fail::Session(e)) if self.here(&owner).access.is_some() => {
                    self.here(&owner).access = None;
                    let _ = e;
                    read(self.user_token(http, st, &owner).await?).await
                }
                other => other,
            }
        };
        match attempt.await {
            Ok(v) => {
                self.here(&owner).problem = None;
                Ok(v)
            }
            Err(f) => {
                let problem = match f {
                    Fail::Session(m) => m,
                    Fail::Other(m) => {
                        log::warn!("spotify: {m}");
                        CHANGED.to_string()
                    }
                };
                self.here(&owner).problem = Some(problem.clone());
                Err(problem)
            }
        }
    }

    pub fn status(&self, st: &AppState) -> Value {
        let owner = crate::cloud::current_owner(st);
        let account = Self::account(st, &owner);
        if account["cookie"].as_str().map(|c| c.is_empty()).unwrap_or(true) {
            return json!({ "connected": false });
        }
        let mut out = json!({ "connected": true });
        if let Some(name) = account["name"].as_str() {
            out["name"] = json!(name);
        }
        if let Some(problem) = self.here(&owner).problem.clone() {
            out["problem"] = json!(problem);
        }
        out
    }

    /// Liked Songs and the library's playlists; kept per owner, so they show at once and while Spotify
    /// can't be reached.
    pub async fn playlists(&self, http: &reqwest::Client, st: &AppState) -> Result<Value, String> {
        let owner = crate::cloud::current_owner(st);
        let read = self
            .signed_in(http, st, |token| async move {
                let mut out = vec![json!({ "id": LIKED_ID, "name": "Liked Songs" })];
                let mut offset = 0;
                while offset < MAX_PLAYLISTS {
                    let vars = json!({
                        "filters": ["Playlists"], "order": null, "textFilter": "", "features": ["LIKED_SONGS", "YOUR_EPISODES_V2", "PRERELEASES", "EVENTS"],
                        "limit": 50, "offset": offset, "flatten": true, "expandedFolders": [], "folderUri": null, "includeFoldersWhenFlattening": false,
                    });
                    let (lists, total, read) = parse_library_page(&self.query(http, &st.persist, "libraryV3", vars, &token).await?)?;
                    out.extend(lists);
                    offset += read;
                    if read == 0 || offset >= total {
                        break;
                    }
                }
                Ok(out)
            })
            .await;
        match read {
            Ok(lists) => {
                // Unless that owner disconnected (or signed out) meanwhile.
                if Self::account(st, &owner)["cookie"].is_string() {
                    Self::save_account(st, &owner, Some(json!({ "playlists": lists }))).await;
                }
                Ok(json!(lists))
            }
            Err(e) => match Self::account(st, &owner)["playlists"].clone() {
                Value::Array(kept) => Ok(json!(kept)),
                _ => Err(e),
            },
        }
    }

    /// One of the listener's playlists, or Liked Songs, with every song.
    pub async fn playlist(&self, http: &reqwest::Client, st: &AppState, id: &str) -> Result<Value, String> {
        self.signed_in(http, st, |token| async move {
            if id == LIKED_ID {
                let mut songs = Vec::new();
                let mut total = usize::MAX;
                let mut offset = 0;
                while offset < total.min(MAX_SONGS) {
                    let page = self.query(http, &st.persist, "fetchLibraryTracks", json!({ "offset": offset, "limit": 100 }), &token).await?;
                    let (list, t) = parse_liked_page(&page)?;
                    total = t;
                    if list.is_empty() {
                        break;
                    }
                    songs.extend(list);
                    offset += 100;
                }
                songs.truncate(MAX_SONGS);
                return Ok(json!({ "name": "Liked Songs", "total": if total == usize::MAX { songs.len() } else { total }, "songs": songs }));
            }
            let first = self
                .query(http, &st.persist, "fetchPlaylist", json!({ "uri": format!("spotify:playlist:{id}"), "offset": 0, "limit": 100, "enableWatchFeedEntrypoint": false }), &token)
                .await?;
            let mut out = playlist_meta(&first);
            let (songs, total) = self.read_playlist(http, &st.persist, id, &token).await?;
            out["songs"] = json!(songs);
            out["total"] = json!(total);
            Ok(out)
        })
        .await
    }

    /// Keeps a captured session for this owner: checks it's a signed-in one, and learns the account's name.
    async fn adopt(&self, http: &reqwest::Client, st: &AppState, cookie: &str) -> Result<(), Fail> {
        let owner = crate::cloud::current_owner(st);
        let access = self.mint(http, &st.persist, cookie).await?;
        self.here(&owner).access = Some(access.clone());
        // A new Spotify account here starts afresh: no name or playlists of the one before.
        Self::save_account(st, &owner, None).await;
        let sealed = crate::cloud::seal_secret(&Self::secret_name(&owner), cookie);
        Self::save_account(st, &owner, Some(json!({ "cookie": sealed }))).await;
        match self.query(http, &st.persist, "profileAttributes", json!({}), &access.0).await {
            Ok(body) => {
                if let Ok(name) = parse_profile_name(&body) {
                    Self::save_account(st, &owner, Some(json!({ "name": name }))).await;
                }
            }
            Err(Fail::Session(e) | Fail::Other(e)) => log::warn!("spotify: profile: {e}"),
        }
        self.here(&owner).problem = None;
        Ok(())
    }

    /// Opens Spotify's sign-in in a private window; answers once the session is kept, or the window is
    /// closed. A second call while one is open focuses it and waits on the same sign-in.
    pub async fn connect(&self, app: &tauri::AppHandle, http: &reqwest::Client, st: &AppState) -> Value {
        use tauri::Manager;
        let waiting = self.connecting.lock().unwrap().clone();
        if let Some(mut rx) = waiting {
            if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
                let _ = w.set_focus();
            }
            loop {
                if let Some(v) = rx.borrow().clone() {
                    return v;
                }
                if rx.changed().await.is_err() {
                    return self.status(st);
                }
            }
        }
        let (tx, rx) = tokio::sync::watch::channel(None);
        *self.connecting.lock().unwrap() = Some(rx);
        if let Some(cookie) = sign_in(app).await {
            if let Err(f) = self.adopt(http, st, &cookie).await {
                let owner = crate::cloud::current_owner(st);
                self.here(&owner).problem = Some(match f {
                    Fail::Session(m) => m,
                    Fail::Other(m) => {
                        log::warn!("spotify: connect: {m}");
                        CHANGED.into()
                    }
                });
            }
        }
        let status = self.status(st);
        let _ = tx.send(Some(status.clone()));
        *self.connecting.lock().unwrap() = None;
        status
    }

    /// Disconnect: this owner's session and playlists, the tokens and the remembered matches go.
    pub async fn disconnect(&self, app: &tauri::AppHandle, st: &AppState) {
        let owner = crate::cloud::current_owner(st);
        Self::save_account(st, &owner, None).await;
        self.forget_sessions(app, st).await;
    }

    /// A data reset: every owner's Spotify goes.
    pub async fn forget_everyone(&self, app: &tauri::AppHandle, st: &AppState) {
        if let Some(owners) = Self::saved(st)["owners"].as_object() {
            for rec in owners.values() {
                if let Some(sealed) = rec["cookie"].as_str() {
                    crate::cloud::forget_secret(sealed);
                }
            }
        }
        let _ = st.persist.write(STORE, &json!({})).await;
        self.forget_sessions(app, st).await;
    }

    async fn forget_sessions(&self, app: &tauri::AppHandle, st: &AppState) {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
            let _ = w.destroy();
        }
        *self.live.lock().unwrap() = Live::default();
        *self.matches.lock().unwrap() = Some(HashMap::new());
        let _ = st.persist.write(MATCHES, &json!({})).await;
    }

    /// A guest who creates an account brings their Spotify along, as they bring their library.
    pub async fn move_guest(&self, st: &AppState, owner: &str) {
        let guest = Self::account(st, "guest");
        if !guest["cookie"].is_string() || Self::account(st, owner)["cookie"].is_string() || owner == "guest" {
            return;
        }
        let cookie = crate::cloud::open_secret(guest["cookie"].as_str().unwrap_or(""));
        let mut moved = guest.clone();
        moved["cookie"] = json!(crate::cloud::seal_secret(&Self::secret_name(owner), &cookie));
        Self::save_account(st, owner, Some(moved)).await;
        Self::save_account(st, "guest", None).await;
    }

    /* ---------------- Canvas, for canvas.rs ---------------- */

    /// Spotify's own Canvas: the web player's track search, the first hit `pick` accepts, then its clip
    /// from the canvas query, or canvaz-cache when that has none. Needs the listener's session, so it
    /// answers None at once for an owner who hasn't connected Spotify. Never fails loudly.
    pub async fn canvas(&self, http: &reqwest::Client, st: &AppState, term: &str, pick: impl Fn(&TrackHit) -> bool) -> Option<(String, TrackHit)> {
        const CANVAZ: &str = "https://spclient.wg.spotify.com/canvaz-cache/v0/canvases";
        const SPOTIFY_APP_UA: &str = "Spotify/9.0.34.593 iOS/18.4 (iPhone15,3)";
        let owner = crate::cloud::current_owner(st);
        if !Self::account(st, &owner)["cookie"].is_string() {
            return None;
        }
        let result: Result<Option<(String, TrackHit)>, Fail> = async {
            let token = self.user_token(http, st, &owner).await?;
            let vars = json!({ "searchTerm": term, "offset": 0, "limit": 10, "numberOfTopResults": 5, "includeAudiobooks": false, "includePreReleases": false });
            let search = self.query(http, &st.persist, "searchTracks", vars, &token).await?;
            let Some(hit) = parse_track_search(&search).into_iter().find(|h| pick(h)) else { return Ok(None) };
            let mut url = match self.query(http, &st.persist, "canvas", json!({ "trackUri": hit.uri }), &token).await {
                Ok(body) => canvas_video(str_of(at(&body, &["data", "trackUnion", "canvas", "url"]))),
                Err(Fail::Session(e)) => return Err(Fail::Session(e)),
                Err(Fail::Other(_)) => None,
            };
            if url.is_none() {
                let res = http
                    .post(CANVAZ)
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Accept", "application/protobuf")
                    .header("Content-Type", "application/protobuf")
                    .header("Accept-Language", "en")
                    .header("User-Agent", SPOTIFY_APP_UA)
                    .timeout(Duration::from_secs(15))
                    .body(field1(&field1(hit.uri.as_bytes())))
                    .send()
                    .await
                    .map_err(|e| Fail::Other(e.to_string()))?;
                if res.status().is_success() {
                    url = canvaz_clip(&res.bytes().await.map_err(|e| Fail::Other(e.to_string()))?, &hit.uri);
                }
            }
            Ok(url.map(|u| (u, hit)))
        }
        .await;
        match result {
            Ok(found) => found,
            Err(Fail::Session(_)) => {
                self.here(&owner).access = None; // minted afresh on the next track
                None
            }
            Err(Fail::Other(_)) => None,
        }
    }
}

/// Spotify's sign-in in a private, locked-down window: no page leaves Spotify's (and its sign-in
/// partners') pages, nothing is stored on disk, and the `sp_dc` session cookie is taken the moment it
/// appears. None when the window is closed first.
async fn sign_in(app: &tauri::AppHandle) -> Option<String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    let url: url::Url = format!("https://accounts.spotify.com/login?continue={}", urlencoding::encode(&format!("{WEB}/"))).parse().ok()?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Option<String>>();
    let mut builder = WebviewWindowBuilder::new(app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Connect Spotify")
        .inner_size(480.0, 760.0)
        .incognito(true);
    if let Some(ua) = SIGN_IN_UA {
        builder = builder.user_agent(ua);
    }
    let win = builder
        .background_color(tauri::window::Color(18, 18, 18, 255))
        .on_navigation(|u| {
            let ok = sign_in_url(u);
            if !ok {
                log::info!("spotify sign-in: blocked {}://{}{}", u.scheme(), u.host_str().unwrap_or(""), u.path());
            }
            ok
        })
        .on_new_window(|u, _| if sign_in_url(&u) { tauri::webview::NewWindowResponse::Allow } else { tauri::webview::NewWindowResponse::Deny })
        .build()
        .map_err(|e| log::warn!("spotify: sign-in window: {e}"))
        .ok()?;
    log::info!("spotify sign-in: window open");
    google_agent(&win);
    let closed = tx.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            log::info!("spotify sign-in: window closed");
            let _ = closed.send(None);
        }
    });
    let watcher = win.clone();
    let poll = tauri::async_runtime::spawn(async move {
        let home: url::Url = "https://open.spotify.com/".parse().unwrap();
        loop {
            tokio::time::sleep(Duration::from_millis(700)).await;
            let cookies = match watcher.cookies_for_url(home.clone()) {
                Ok(c) => c,
                Err(e) => {
                    log::info!("spotify sign-in: cookies unreadable: {e}");
                    break;
                }
            };
            log::debug!("spotify sign-in: {} cookies: {:?}", cookies.len(), cookies.iter().map(|c| c.name().to_string()).collect::<Vec<_>>());
            let found = cookies.iter().find(|c| {
                let domain = c.domain().unwrap_or("").trim_start_matches('.');
                c.name() == "sp_dc" && (domain == "spotify.com" || domain.ends_with(".spotify.com")) && cookie_ok(c.value())
            });
            if let Some(c) = found {
                log::info!("spotify sign-in: session cookie found");
                let _ = tx.send(Some(c.value().to_string()));
                break;
            }
        }
    });
    let cookie = rx.recv().await.flatten();
    poll.abort();
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = w.destroy();
    }
    cookie
}

/// On WebKitGTK: when the window's page heads to Google's sign-in, it switches to Google's agent
/// (GOOGLE_UA) and loads that page afresh, so Google sees the new agent from its first request. It
/// stays switched for the rest of the sign-in: Spotify takes a Firefox agent as well, and reloading
/// the page Google sends back to would spend its one-time code. Main-frame loads only, so the
/// reCAPTCHA frame on Spotify's own page never switches it.
#[cfg(target_os = "linux")]
fn google_agent(win: &tauri::WebviewWindow) {
    let applied = win.with_webview(|wv| {
        use webkit2gtk::{LoadEvent, SettingsExt, WebViewExt};
        wv.inner().connect_load_changed(|view, event| {
            if !matches!(event, LoadEvent::Started | LoadEvent::Redirected) {
                return;
            }
            let Some(uri) = view.uri() else { return };
            let Ok(url) = url::Url::parse(&uri) else { return };
            if !url.host_str().map(google_accounts).unwrap_or(false) {
                return;
            }
            let Some(settings) = WebViewExt::settings(view) else { return };
            if settings.user_agent().as_deref() == Some(GOOGLE_UA) {
                return;
            }
            log::info!("spotify sign-in: Google's sign-in, with a Firefox agent");
            settings.set_user_agent(Some(GOOGLE_UA));
            view.load_uri(&uri);
        });
    });
    if let Err(e) = applied {
        log::warn!("spotify sign-in: Google agent not set: {e}");
    }
}

#[cfg(not(target_os = "linux"))]
fn google_agent(_win: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The web player's script, saved to $BYTUNE_WEBPLAYER_JS: how long reading its values takes.
    #[test]
    #[ignore]
    fn player_script_timing() {
        let path = std::env::var("BYTUNE_WEBPLAYER_JS").unwrap();
        let script = std::fs::read_to_string(path).unwrap();
        let t = std::time::Instant::now();
        let secret = player_secret(&script);
        println!("secret: version={:?} in {:?}", secret.map(|s| s.version), t.elapsed());
    }

    #[test]
    fn secrets_in_script() {
        let script = r#"x={secret:'a\'b',version:60},y={secret:"c\x41d",version:61};"#;
        let found = player_secret(script).unwrap();
        assert_eq!((found.version, found.secret.as_str()), (61, "cAd"));
    }

    #[test]
    fn sign_in_pages() {
        let ok = |u: &str| sign_in_url(&url::Url::parse(u).unwrap());
        assert!(ok("https://accounts.spotify.com/en/login"));
        assert!(ok("https://www.google.com/recaptcha/enterprise/anchor?k=x"));
        assert!(ok("https://accounts.youtube.com/accounts/CheckConnection?x=1"));
        assert!(ok("https://accounts.youtube.com/accounts/SetSID?ssdc=1"));
        assert!(ok("https://accounts.google.co.in/accounts/SetSID?ssdc=1"));
        assert!(ok("https://accounts.google.de/accounts/SetSID"));
        assert!(ok("https://accounts.google.com.br/accounts/SetSID"));
        assert!(ok("https://gds.google.com/web/recoveryoptions"));
        assert!(!ok("https://accounts.youtube.com/other"));
        assert!(!ok("https://accounts.google.evil.com/"));
        assert!(!ok("https://mail.google.com/"));
        assert!(!ok("https://www.google.com/search?q=x"));
        assert!(!ok("https://evil.example/recaptcha/"));
        assert!(!ok("http://accounts.spotify.com/"));
    }

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
        // A tie keeps the search's order: the song itself over a same-length demo listed after it.
        let wedding = ImportSong { title: "Stop The Wedding!".into(), artist: "Ashe".into(), duration: 199.0, ..Default::default() };
        let song = Track { id: "s".into(), title: "Stop The Wedding!".into(), artist: "Ashe".into(), duration: 199.0, ..Default::default() };
        let demo = Track { id: "d".into(), title: "Stop The Wedding! (Original Piano Demo)".into(), artist: "Ashe".into(), duration: 199.0, ..Default::default() };
        assert_eq!(best_match(&wedding, &[song, demo], "").map(|t| t.id).as_deref(), Some("s"));
        assert_eq!(search_queries(&target), vec!["Yellow Coldplay".to_string(), "Yellow".to_string()]);
    }
}
