//! The lyric sources — ByTune's lyrics.ts providers, one by one, asked the way it asks them.

use super::naming::{
    artist_names, clean_title, credit_forms, names_recording, names_release_recording, plain_words, query_title, recording_name,
    release_name, same_name, search_artist, search_title, within_tolerance, Playing, LENGTH_TOLERANCE_SEC,
};
use super::parse::{
    opening_name_fits, parse_enhanced_lrc, parse_lrc, parse_provider_any, parse_ttml, plain_found, to_result,
    without_opening, Parsed,
};
use super::{Found, Line, Query, Word};
use base64::Engine;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use futures_util::stream::{FuturesUnordered, StreamExt};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const LYRICS_AGENT: &str = "ByTune (https://github.com/Sr1ya/bytune-rs)";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

/// `URLSearchParams` as the browser writes it (form encoding: a space is "+").
fn params(pairs: &[(&str, &str)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/* ---------------------------------- HTTP ---------------------------------- */

pub enum Got {
    Text(String),
    /// The host answered with an HTTP error.
    Status(u16),
    /// The host never answered at all — DNS, refused, timed out.
    Unreachable,
}

pub async fn fetch(http: &reqwest::Client, url: &str, timeout_ms: u64, headers: &[(&str, &str)]) -> Got {
    let mut req = http.get(url).timeout(Duration::from_millis(timeout_ms)).header("User-Agent", LYRICS_AGENT).header("Accept", "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    // reqwest appends repeated headers; the override must replace the default.
    let req = match req.build() {
        Ok(mut built) => {
            for (k, v) in headers {
                if let (Ok(name), Ok(value)) = (reqwest::header::HeaderName::from_bytes(k.as_bytes()), reqwest::header::HeaderValue::from_str(v)) {
                    built.headers_mut().insert(name, value);
                }
            }
            built
        }
        Err(_) => return Got::Unreachable,
    };
    match http.execute(req).await {
        Ok(res) if res.status().is_success() => match res.text().await {
            Ok(t) => Got::Text(t),
            Err(_) => Got::Unreachable,
        },
        Ok(res) => {
            log::debug!("lyrics HTTP {} {}", res.status(), &url[..url.len().min(90)]);
            Got::Status(res.status().as_u16())
        }
        Err(e) => {
            log::debug!("lyrics FAIL {} :: {e}", &url[..url.len().min(90)]);
            Got::Unreachable
        }
    }
}

pub async fn get_text(http: &reqwest::Client, url: &str, timeout_ms: u64, headers: &[(&str, &str)]) -> Option<String> {
    match fetch(http, url, timeout_ms, headers).await {
        Got::Text(t) => Some(t),
        _ => None,
    }
}

async fn get_json(http: &reqwest::Client, url: &str, timeout_ms: u64, headers: &[(&str, &str)]) -> Option<Value> {
    serde_json::from_str(&get_text(http, url, timeout_ms, headers).await?).ok()
}

pub struct Ctx<'a> {
    pub http: &'a reqwest::Client,
    pub q: &'a Query,
}

impl<'a> Ctx<'a> {
    fn playing(&self) -> Playing<'a> {
        Playing { title: &self.q.title, artist: &self.q.artist, duration: self.q.duration }
    }
    fn names(&self, name: &str, artist: &str, length: Option<f64>) -> bool {
        names_recording(name, artist, self.playing(), length, false)
    }
    fn album(&self) -> Option<&'a str> {
        self.q.album.as_deref().filter(|a| !a.is_empty())
    }
    fn seconds(&self) -> f64 {
        self.q.duration.round()
    }
    fn is_youtube(&self) -> bool {
        !self.q.id.is_empty() && !self.q.id.contains(':')
    }
}

/* ---------------------- documents shared by one lookup ---------------------- */

/// lrc.red and BiniLyrics want the very same file: one lookup fetches it once.
pub struct Docs<'a> {
    http: &'a reqwest::Client,
    in_flight: Mutex<HashMap<String, Shared<BoxFuture<'a, Option<String>>>>>,
}

impl<'a> Docs<'a> {
    pub fn new(http: &'a reqwest::Client) -> Self {
        Self { http, in_flight: Mutex::new(HashMap::new()) }
    }
    fn get(&self, url: &str) -> Shared<BoxFuture<'a, Option<String>>> {
        let mut map = self.in_flight.lock().unwrap();
        if let Some(doc) = map.get(url) {
            return doc.clone();
        }
        let (http, owned) = (self.http, url.to_string());
        let doc = async move { get_text(http, &owned, 7000, &[("Accept", "*/*")]).await }.boxed().shared();
        map.insert(url.to_string(), doc.clone());
        doc
    }
}

async fn ttml_answer(source: &str, url: Option<String>, docs: &Docs<'_>) -> Option<Found> {
    let ttml = docs.get(&url?).await?;
    to_result(source, parse_ttml(&ttml))
}

/* ------------------------- which recording is this ------------------------- */

#[derive(Clone, Debug)]
pub struct RecordingHit {
    pub isrc: Option<String>,
    pub lyrics_url: Option<String>,
}

pub type Recording<'a> = Shared<BoxFuture<'a, Option<RecordingHit>>>;

const LRCRED: &str = "https://lrc.red";
const BINI: &str = "https://lyrics-api.binimum.org/";
const IDENTIFY_TIMEOUT: Duration = Duration::from_millis(2500);
const ISRC_CACHE_MAX: usize = 500;

/// Recordings named before, by video id: a track asked about twice pays for the identify step once.
static ISRC_CACHE: Lazy<Mutex<(HashMap<String, String>, VecDeque<String>)>> = Lazy::new(|| Mutex::new((HashMap::new(), VecDeque::new())));

pub fn cached_isrc(id: &str) -> Option<String> {
    ISRC_CACHE.lock().unwrap().0.get(id).cloned()
}

fn remember_isrc(id: &str, isrc: &str) {
    if id.is_empty() || isrc.is_empty() {
        return;
    }
    let mut c = ISRC_CACHE.lock().unwrap();
    if c.0.insert(id.to_string(), isrc.to_string()).is_none() {
        c.1.push_back(id.to_string());
    }
    while c.1.len() > ISRC_CACHE_MAX {
        if let Some(old) = c.1.pop_front() {
            c.0.remove(&old);
        }
    }
}

/// The document a recording's lyrics live at, for a well-formed ISRC only.
fn lrc_red_document(isrc: Option<&str>) -> Option<String> {
    static ISRC: Lazy<Regex> = Lazy::new(|| re(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$"));
    let code = isrc?.trim().to_uppercase();
    ISRC.is_match(&code).then(|| format!("{LRCRED}/s/{code}.ttml"))
}

async fn bini_search(http: &reqwest::Client, pairs: &[(&str, &str)]) -> Vec<Value> {
    get_json(http, &format!("{BINI}?{}", params(pairs)), 6000, &[]).await.and_then(|j| j["results"].as_array().cloned()).unwrap_or_default()
}

/// The Bini row that IS the playing recording: timed words, the playing recording's name, a length
/// within tolerance (a music video may run past the catalogue cut it was filmed to). Of those: one
/// within tolerance, then the playing album's, then word timing, then the closest length.
fn pick_lrc_red_row(rows: &[Value], ctx: &Ctx) -> Option<Value> {
    let q = ctx.q;
    let timed = q.duration > 0.0;
    if !timed && artist_names(&q.artist).is_empty() {
        return None;
    }
    let dur = |r: &Value| num_of(&r["duration"]).unwrap_or(f64::NAN);
    let gap = |r: &Value| if timed { (dur(r) - q.duration).abs() } else { 0.0 };
    let close = |r: &Value| !timed || gap(r) <= LENGTH_TOLERANCE_SEC;
    let video = ctx.album().is_none() && recording_name(&q.title, false).versions.is_empty() && !artist_names(&q.artist).is_empty();
    let album = plain_words(&release_name(ctx.album().unwrap_or("")));
    let from_album = |r: &Value| if !album.is_empty() && plain_words(&release_name(&str_of(&r["album_name"]))) == album { 0 } else { 1 };
    let mut fits: Vec<&Value> = rows
        .iter()
        .filter(|r| {
            let timing = r["timing_type"].as_str().unwrap_or("");
            lrc_red_document(r["isrc"].as_str()).is_some()
                && r["lyricsUrl"].as_str().map(|u| !u.is_empty()).unwrap_or(false)
                && (timing == "word" || timing == "line")
                && (ctx.names(&str_of(&r["track_name"]), &str_of(&r["artist_name"]), num_of(&r["duration"]))
                    || names_release_recording(&str_of(&r["track_name"]), &str_of(&r["artist_name"]), r["album_name"].as_str(), ctx.playing(), ctx.album()))
                && (close(r) || (video && !artist_names(&str_of(&r["artist_name"])).is_empty() && dur(r) < q.duration))
        })
        .collect();
    fits.sort_by(|a, b| {
        (close(b) as u8)
            .cmp(&(close(a) as u8))
            .then(from_album(a).cmp(&from_album(b)))
            .then(((b["timing_type"] == "word") as u8).cmp(&((a["timing_type"] == "word") as u8)))
            .then(gap(a).partial_cmp(&gap(b)).unwrap_or(std::cmp::Ordering::Equal))
    });
    fits.first().map(|v| (*v).clone())
}

/// Which recording this is, before anybody is asked for words. `hit` is capped at IDENTIFY_TIMEOUT —
/// knowing the recording makes every match better, but a lyrics view held up by one slow host is a
/// worse failure than a fuzzy match; `full` is the same search uncapped, for BiniLyrics' own answer.
pub fn identify_recording<'a>(ctx: &'a Ctx<'a>) -> (Recording<'a>, Recording<'a>) {
    if let Some(isrc) = cached_isrc(&ctx.q.id) {
        let known = async move { Some(RecordingHit { isrc: Some(isrc), lyrics_url: None }) }.boxed().shared();
        return (known.clone(), known);
    }
    let full = async move {
        let title = search_title(&ctx.q.title);
        let artist = search_artist(&ctx.q.artist);
        let album = ctx.album().map(clean_title);
        let seconds = (ctx.q.duration > 0.0).then(|| (ctx.seconds() as i64).to_string());
        let mut pairs: Vec<(&str, &str)> = vec![("track", &title)];
        if !artist.is_empty() {
            pairs.push(("artist", &artist));
        }
        if let Some(a) = &album {
            pairs.push(("album", a));
        }
        if let Some(s) = &seconds {
            pairs.push(("duration", s));
        }
        let rows = bini_search(ctx.http, &pairs).await;
        let row = pick_lrc_red_row(&rows, ctx)?;
        let isrc = row["isrc"].as_str()?.to_string();
        // A pick made on title and length alone is a guess: used for this play, never remembered.
        if !artist_names(&ctx.q.artist).is_empty() {
            remember_isrc(&ctx.q.id, &isrc);
        }
        Some(RecordingHit { isrc: Some(isrc), lyrics_url: row["lyricsUrl"].as_str().map(String::from) })
    }
    .boxed()
    .shared();
    let capped = full.clone();
    let hit = async move { tokio::time::timeout(IDENTIFY_TIMEOUT, capped).await.ok().flatten() }.boxed().shared();
    (hit, full)
}

/* --------------------------------- lrc.red --------------------------------- */

/// The lrc.red search hit that is surely the playing recording: a well-formed ISRC, its name, a length
/// within tolerance. Of those: the playing album's, then the closest in length, then the search's order.
fn pick_lrc_red_hit(hits: &[Value], ctx: &Ctx) -> Option<Value> {
    let q = ctx.q;
    let timed = q.duration > 0.0;
    if !timed && artist_names(&q.artist).is_empty() {
        return None;
    }
    let gap = |h: &Value| match (timed, num_of(&h["duration"])) {
        (true, Some(d)) => (d - q.duration).abs(),
        _ => 0.0,
    };
    let album = plain_words(&release_name(ctx.album().unwrap_or("")));
    let from_album = |h: &Value| if !album.is_empty() && plain_words(&release_name(&str_of(&h["album"]))) == album { 0 } else { 1 };
    let mut fits: Vec<&Value> = hits
        .iter()
        .filter(|h| {
            lrc_red_document(h["isrc"].as_str()).is_some()
                && (ctx.names(&str_of(&h["title"]), &str_of(&h["artist"]), num_of(&h["duration"]))
                    || names_release_recording(&str_of(&h["title"]), &str_of(&h["artist"]), h["album"].as_str(), ctx.playing(), ctx.album()))
                && gap(h) <= LENGTH_TOLERANCE_SEC
        })
        .collect();
    // A stable sort keeps the search's own order among ties.
    fits.sort_by(|a, b| from_album(a).cmp(&from_album(b)).then(gap(a).partial_cmp(&gap(b)).unwrap_or(std::cmp::Ordering::Equal)));
    fits.first().map(|v| (*v).clone())
}

async fn lrc_red_search_doc(ctx: &Ctx<'_>) -> Option<String> {
    let term = [search_title(&ctx.q.title), search_artist(&ctx.q.artist)].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let json = get_json(ctx.http, &format!("{LRCRED}/search.json?{}", params(&[("q", &term)])), 6000, &[]).await?;
    let hits = json["hits"].as_array()?;
    lrc_red_document(pick_lrc_red_hit(hits, ctx)?["isrc"].as_str())
}

/// lrc.red: Apple TTML filed by ISRC. The recording identify named comes first; lrc.red's own search
/// only when it named none (it starts alongside, so a miss costs no extra round trip). A recording with
/// no document is often filed under a sibling release's code, so the other naming gets its turn.
pub async fn fetch_lrc_red(ctx: &Ctx<'_>, recording: Recording<'_>, docs: &Docs<'_>) -> Option<Found> {
    let identified = async { lrc_red_document(recording.await.and_then(|h| h.isrc).as_deref()) }.boxed().shared();
    let remembered = cached_isrc(&ctx.q.id).is_some();
    let searched = (!remembered).then(|| lrc_red_search_doc(ctx).boxed().shared());
    let doc = match identified.clone().await {
        Some(d) => Some(d),
        None => match &searched {
            Some(s) => s.clone().await,
            None => None,
        },
    };
    if let Some(answer) = ttml_answer("lrc.red", doc.clone(), docs).await {
        return Some(answer);
    }
    let other_search = match &searched {
        Some(s) => s.clone().await,
        None => lrc_red_search_doc(ctx).await,
    };
    let other = [identified.await, other_search].into_iter().flatten().find(|d| Some(d) != doc.as_ref());
    ttml_answer("lrc.red", other, docs).await
}

/* -------------------------------- BiniLyrics -------------------------------- */

/// Apple TTML through the Bini backend — the search that answers to a recording, run first as the
/// identify step; its document is lrc.red's file, fetched once between the two.
pub async fn fetch_bini(ctx: &Ctx<'_>, recording: Recording<'_>, docs: &Docs<'_>) -> Option<Found> {
    let hit = recording.await;
    let mut url = hit.as_ref().and_then(|h| h.lyrics_url.clone());
    // A remembered recording carries no document address: ask for it by ISRC.
    if url.is_none() {
        if let Some(isrc) = hit.and_then(|h| h.isrc) {
            url = bini_search(ctx.http, &[("isrc", &isrc)]).await.iter().find(|r| r["isrc"].as_str() == Some(isrc.as_str())).and_then(|r| r["lyricsUrl"].as_str().map(String::from));
        }
    }
    ttml_answer("BiniLyrics", url, docs).await
}

/* ------------------------------- BetterLyrics ------------------------------- */

/// Apple TTML from lyrics-api.boidu.dev, asked under each form of the credit at the upload's length.
pub async fn fetch_better_lyrics(ctx: &Ctx<'_>) -> Option<Found> {
    let title = search_title(&ctx.q.title);
    let seconds = (ctx.q.duration > 0.0).then(|| (ctx.seconds() as i64).to_string());
    let album = ctx.album().map(clean_title);
    for a in credit_forms(&ctx.q.artist) {
        let mut pairs: Vec<(&str, &str)> = vec![("s", &title), ("a", &a)];
        if let Some(s) = &seconds {
            pairs.push(("d", s));
        }
        if let Some(al) = &album {
            pairs.push(("al", al));
        }
        let Some(json) = get_json(ctx.http, &format!("https://lyrics-api.boidu.dev/getLyrics?{}", params(&pairs)), 6000, &[]).await else { continue };
        if let Some(found) = json["ttml"].as_str().filter(|t| !t.is_empty()).and_then(|t| to_result("BetterLyrics", parse_ttml(t))) {
            return Some(found);
        }
    }
    None
}

/* --------------------------------- Portato --------------------------------- */

/// The Portato endpoint demands an API key for queries its cache has never seen: parked for the session.
static PORTATO_KEY_GATED: AtomicBool = AtomicBool::new(false);

/// QQ Music's karaoke timings through BetterLyrics' Portato endpoint.
pub async fn fetch_portato(ctx: &Ctx<'_>) -> Option<Found> {
    let title = search_title(&ctx.q.title);
    let seconds = (ctx.q.duration > 0.0).then(|| (ctx.seconds() as i64).to_string());
    let album = ctx.album().map(clean_title);
    for a in credit_forms(&ctx.q.artist) {
        if PORTATO_KEY_GATED.load(Ordering::Relaxed) {
            return None;
        }
        let mut pairs: Vec<(&str, &str)> = vec![("s", &title), ("a", &a)];
        if let Some(s) = &seconds {
            pairs.push(("d", s));
        }
        if let Some(al) = &album {
            pairs.push(("al", al));
        }
        let Some(body) = get_text(ctx.http, &format!("https://lyrics-api.boidu.dev/qq/getLyrics?{}", params(&pairs)), 6000, &[]).await else { continue };
        if body.to_lowercase().contains("api key required") {
            PORTATO_KEY_GATED.store(true, Ordering::Relaxed);
            return None;
        }
        let lines = match parse_provider_any(&body) {
            None => continue,
            Some(Parsed::Plain(p)) => return plain_found("Portato", &p),
            Some(Parsed::Lines(l)) => l,
        };
        // QQ's file names its own recording in its opening line.
        if opening_name_fits(&lines, ctx.playing(), None) == Some(false) {
            continue;
        }
        // Still sung after the track has ended: another song's file.
        if ctx.q.duration > 0.0 && lines.iter().any(|l| !l.text.trim().is_empty() && l.time > ctx.q.duration + LENGTH_TOLERANCE_SEC) {
            continue;
        }
        if let Some(found) = to_result("Portato", without_opening(lines)) {
            return Some(found);
        }
    }
    None
}

/* --------------------------------- PaxSenix --------------------------------- */

const PAXSENIX_PROXY: &str = "https://lyrics.paxsenix.org";
const APPLE_SEARCH: &str = "https://amp-api.music.apple.com/v1/catalog/us/search";
static APPLE_TOKEN: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

fn apple_clean(s: &str) -> String {
    static NOISE: Lazy<Regex> =
        Lazy::new(|| re(r"(?i)\s*[(\[](official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster\w*|live|version|feat\.?|ft\.?)[^)\]]*[)\]]"));
    NOISE.replace_all(s, "").trim().to_string()
}

/// The bearer token Apple's web player carries inside one of its JS bundles.
async fn scrape_apple_token(http: &reqwest::Client) -> Option<String> {
    static SCRIPT: Lazy<Regex> = Lazy::new(|| re(r#"/assets/index~[^"]+\.js"#));
    static JWT: Lazy<Regex> = Lazy::new(|| re(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"));
    let home = get_text(http, "https://music.apple.com/us/new", 8000, &[("User-Agent", UA), ("Accept", "text/html")]).await?;
    let path = SCRIPT.find(&home)?.as_str().to_string();
    let script = get_text(http, &format!("https://music.apple.com{path}"), 8000, &[("User-Agent", UA), ("Accept", "*/*")]).await?;
    JWT.find(&script).map(|m| m.as_str().to_string())
}

async fn apple_token(http: &reqwest::Client, fresh: bool) -> Option<String> {
    if !fresh {
        if let Some(t) = APPLE_TOKEN.lock().unwrap().clone() {
            return Some(t);
        }
    }
    let token = scrape_apple_token(http).await;
    *APPLE_TOKEN.lock().unwrap() = token.clone();
    token
}

struct AppleCandidate {
    id: String,
    name: String,
    artist: String,
    duration: Option<f64>,
}

async fn apple_search(http: &reqwest::Client, query: &str, token: &str) -> Option<Vec<AppleCandidate>> {
    let url = format!("{APPLE_SEARCH}?term={}&types=songs&limit=10&l=en-US", enc(query));
    let auth = format!("Bearer {token}");
    let json = get_json(http, &url, 7000, &[("Authorization", &auth), ("Origin", "https://music.apple.com"), ("Referer", "https://music.apple.com/"), ("User-Agent", UA)]).await?;
    let data = json.pointer("/results/songs/data")?.as_array()?;
    Some(
        data.iter()
            .map(|t| AppleCandidate {
                id: str_of(&t["id"]),
                name: str_of(&t["attributes"]["name"]),
                artist: str_of(&t["attributes"]["artistName"]),
                duration: t["attributes"]["durationInMillis"].as_f64().filter(|d| *d > 0.0).map(|d| (d / 1000.0).round()),
            })
            .collect(),
    )
}

/// PaxSenix's structured Apple payload: rows with a millisecond `timestamp` and per-word `text` rows.
fn parse_pax_structured(root: &Value) -> Vec<Line> {
    fn find_content(node: &Value) -> Option<&Vec<Value>> {
        match node {
            Value::Array(items) => items.iter().find_map(find_content),
            Value::Object(obj) => {
                if let Some(rows) = obj.get("content").and_then(|c| c.as_array()) {
                    if rows.iter().any(|r| r.is_object() && !r["timestamp"].is_null()) {
                        return Some(rows);
                    }
                }
                obj.values().find_map(find_content)
            }
            _ => None,
        }
    }
    let Some(rows) = find_content(root) else { return vec![] };
    let mut out = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let (Some(start), Some(word_rows)) = (row["timestamp"].as_f64().map(|t| t / 1000.0), row["text"].as_array()) else { continue };
        let next_start = rows.get(i + 1).and_then(|r| r["timestamp"].as_f64()).map(|t| t / 1000.0);
        let mut words = Vec::new();
        for (w, word) in word_rows.iter().enumerate() {
            let text = word["text"].as_str().unwrap_or("").trim().to_string();
            let Some(ws) = word["timestamp"].as_f64().map(|t| t / 1000.0) else { continue };
            if text.is_empty() {
                continue;
            }
            let we = word_rows.get(w + 1).and_then(|n| n["timestamp"].as_f64()).map(|t| t / 1000.0).or(next_start).unwrap_or(ws + 0.8);
            words.push(Word { start: ws, end: we.max(ws), text });
        }
        if words.is_empty() {
            continue;
        }
        out.push(Line {
            time: start.min(words[0].start),
            text: words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
            end: Some(next_start.unwrap_or(words.last().unwrap().end)),
            words: Some(words),
            ..Default::default()
        });
    }
    out.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// The proxy's lyrics for one Apple id: None when the host never answered, Some(None) when it answered
/// without lyrics.
async fn pax_senix_lyrics(http: &reqwest::Client, id: &str) -> Option<Option<Found>> {
    let body = match fetch(http, &format!("{PAXSENIX_PROXY}/apple-music/lyrics?id={}&ttml=true", enc(id)), 8000, &[]).await {
        Got::Text(t) => t,
        Got::Status(_) => return Some(None),
        Got::Unreachable => return None,
    };
    let Ok(json) = serde_json::from_str::<Value>(&body) else { return Some(None) };
    let structured = parse_pax_structured(&json);
    if !structured.is_empty() {
        return Some(to_result("PaxSenix", structured));
    }
    static TT: Lazy<Regex> = Lazy::new(|| re(r"(?i)<tt[\s>]"));
    for key in ["ttmlContent", "content"] {
        if let Some(ttml) = json[key].as_str().filter(|t| !t.trim().is_empty() && TT.is_match(t)) {
            let lines = parse_ttml(ttml);
            if !lines.is_empty() {
                return Some(to_result("PaxSenix", lines));
            }
        }
    }
    for key in ["elrcMultiPerson", "elrc"] {
        if let Some(elrc) = json[key].as_str().filter(|t| !t.trim().is_empty()) {
            let lines = parse_enhanced_lrc(elrc);
            if !lines.is_empty() {
                return Some(to_result("PaxSenix", lines));
            }
        }
    }
    Some(None)
}

/// Word-timed lyrics via lyrics.paxsenix.org, a public proxy in front of Apple Music's catalogue.
pub async fn fetch_pax_senix(ctx: &Ctx<'_>) -> Option<Found> {
    let stripped = query_title(&ctx.q.title);
    let artist = apple_clean(&search_artist(&ctx.q.artist));
    if stripped.is_empty() {
        return None;
    }
    // Apple indexes the actual edits: the rendition the upload names is queried before the stripped title.
    let full = search_title(&ctx.q.title);
    let titles = if !full.is_empty() && full.to_lowercase() != stripped.to_lowercase() { vec![full, stripped] } else { vec![stripped] };
    let mut token = apple_token(ctx.http, false).await?;
    let delta = |t: &AppleCandidate| match t.duration {
        Some(d) if ctx.q.duration > 0.0 => (d - ctx.q.duration).abs(),
        _ => 99999.0,
    };
    let mut pool: Vec<AppleCandidate> = Vec::new();
    for title in &titles {
        let query = [title.as_str(), artist.as_str()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
        let mut results = apple_search(ctx.http, &query, &token).await;
        if results.is_none() {
            // Apple said no — the token went stale. Mint a fresh one, once.
            token = match apple_token(ctx.http, true).await {
                Some(t) => t,
                None => return None,
            };
            results = apple_search(ctx.http, &query, &token).await;
        }
        let mut named: Vec<AppleCandidate> = results.unwrap_or_default().into_iter().filter(|t| !t.id.is_empty() && ctx.names(&t.name, &t.artist, t.duration)).collect();
        named.sort_by(|a, b| delta(a).partial_cmp(&delta(b)).unwrap_or(std::cmp::Ordering::Equal));
        pool = named;
        if !pool.is_empty() {
            break;
        }
    }
    let first_len = pool.first()?.duration;
    // The same recording listed under several releases: those of the first's length get a turn.
    let same: Vec<&AppleCandidate> = pool
        .iter()
        .enumerate()
        .filter(|(i, t)| *i == 0 || matches!((t.duration, first_len), (Some(a), Some(b)) if (a - b).abs() <= LENGTH_TOLERANCE_SEC))
        .map(|(_, t)| t)
        .take(3)
        .collect();
    for candidate in same {
        match pax_senix_lyrics(ctx.http, &candidate.id).await {
            None => continue,
            Some(answer) => return answer,
        }
    }
    None
}

/* -------------------------------- LyricsPlus -------------------------------- */

const LYRICSPLUS_MIRRORS: &[&str] = &[
    "https://lyricsplus.prjktla.my.id",
    "https://lyricsplus.atomix.one",
    "https://lyricsplus.binimum.org",
    "https://lyricsplus.prjktla.workers.dev",
    "https://lyricsplus-seven.vercel.app",
    "https://lyrics-plus-backend.vercel.app",
];
const LYRICSPLUS_BENCH: Duration = Duration::from_secs(10 * 60);
static LYRICSPLUS_LAST_GOOD: Lazy<Mutex<Option<&'static str>>> = Lazy::new(|| Mutex::new(None));
/// Mirrors that didn't answer at all last time sit out for a while.
static LYRICSPLUS_BENCHED: Lazy<Mutex<HashMap<&'static str, Instant>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Glue syllables back into words — a trailing space marks the boundary; with none at all, each
/// syllable is a word.
fn merge_plus_syllables(syllables: &[Value]) -> Vec<Word> {
    let mut words = Vec::new();
    let (mut text, mut start, mut end, mut boundary) = (String::new(), 0.0, 0.0, false);
    for syl in syllables {
        let raw = syl["text"].as_str().unwrap_or("");
        let Some(t) = syl["time"].as_f64() else { continue };
        if raw.trim().is_empty() {
            continue;
        }
        if text.is_empty() {
            start = t / 1000.0;
        }
        text.push_str(raw.trim());
        end = t / 1000.0 + syl["duration"].as_f64().unwrap_or(0.0) / 1000.0;
        if raw.ends_with(char::is_whitespace) {
            words.push(Word { start, end: end.max(start), text: std::mem::take(&mut text) });
            boundary = true;
        }
    }
    if !text.is_empty() {
        if boundary {
            words.push(Word { start, end: end.max(start), text });
        } else {
            for syl in syllables {
                let raw = syl["text"].as_str().unwrap_or("");
                let Some(t) = syl["time"].as_f64() else { continue };
                if raw.trim().is_empty() {
                    continue;
                }
                let st = t / 1000.0;
                words.push(Word { start: st, end: (st + syl["duration"].as_f64().unwrap_or(0.0) / 1000.0).max(st), text: raw.trim().to_string() });
            }
        }
    }
    words
}

fn parse_plus_response(json: &Value) -> Vec<Line> {
    let mut out = Vec::new();
    for line in json["lyrics"].as_array().into_iter().flatten() {
        let Some(start) = line["time"].as_f64().map(|t| t / 1000.0) else { continue };
        let words = merge_plus_syllables(line["syllabus"].as_array().map(|a| a.as_slice()).unwrap_or(&[]));
        if !words.is_empty() {
            out.push(Line {
                time: start.min(words[0].start),
                text: words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
                end: Some(words.last().unwrap().end),
                words: Some(words),
                ..Default::default()
            });
        } else if let Some(text) = line["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
            let dur = line["duration"].as_f64().filter(|d| *d > 0.0);
            out.push(Line { time: start, text: text.to_string(), end: dur.map(|d| start + d / 1000.0), ..Default::default() });
        }
    }
    out.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    out
}

async fn fetch_lyrics_plus_one(ctx: &Ctx<'_>, host: &'static str, isrc: Option<&str>) -> Option<Vec<Line>> {
    let title = search_title(&ctx.q.title);
    let artist = search_artist(&ctx.q.artist);
    let seconds = (ctx.q.duration > 0.0).then(|| (ctx.seconds() as i64).to_string());
    let album = ctx.album().map(clean_title);
    let mut pairs: Vec<(&str, &str)> = vec![("title", &title), ("artist", &artist)];
    if let Some(s) = &seconds {
        pairs.push(("duration", s));
    }
    if let Some(a) = &album {
        pairs.push(("album", a));
    }
    if let Some(i) = isrc {
        pairs.push(("isrc", i));
    }
    let body = match fetch(ctx.http, &format!("{host}/v2/lyrics/get?{}", params(&pairs)), 6000, &[]).await {
        Got::Text(t) => t,
        Got::Unreachable => {
            LYRICSPLUS_BENCHED.lock().unwrap().insert(host, Instant::now() + LYRICSPLUS_BENCH);
            return None;
        }
        Got::Status(_) => return None,
    };
    let json: Value = serde_json::from_str(&body).ok()?;
    // The backend breaks ties on length, which can land on a remix: its own metadata says what it sent.
    if let Some(t) = json["metadata"]["title"].as_str().filter(|t| !t.is_empty()) {
        if !ctx.names(t, &str_of(&json["metadata"]["artist"]), None) {
            return None;
        }
    }
    let lines = parse_plus_response(&json);
    (!lines.is_empty()).then_some(lines)
}

/// Syllable-level lyrics from the YouLy+ backend on community mirrors: all asked at once, the first
/// usable answer wins, the winner is remembered for the next track.
pub async fn fetch_lyrics_plus(ctx: &Ctx<'_>, isrc: Option<String>) -> Option<Found> {
    let now = Instant::now();
    let awake: Vec<&'static str> = {
        let benched = LYRICSPLUS_BENCHED.lock().unwrap();
        LYRICSPLUS_MIRRORS.iter().copied().filter(|m| benched.get(m).map(|until| *until <= now).unwrap_or(true)).collect()
    };
    let pool = if awake.is_empty() { LYRICSPLUS_MIRRORS.to_vec() } else { awake };
    let last = *LYRICSPLUS_LAST_GOOD.lock().unwrap();
    let mut hosts: Vec<&'static str> = Vec::new();
    if let Some(l) = last.filter(|l| pool.contains(l)) {
        hosts.push(l);
    }
    hosts.extend(pool.into_iter().filter(|m| Some(*m) != last));
    let mut racing: FuturesUnordered<_> = hosts.into_iter().map(|h| fetch_lyrics_plus_one(ctx, h, isrc.as_deref()).map(move |r| (h, r))).collect();
    while let Some((host, lines)) = racing.next().await {
        if let Some(lines) = lines {
            *LYRICSPLUS_LAST_GOOD.lock().unwrap() = Some(host);
            return to_result("LyricsPlus", lines);
        }
    }
    None
}

/* ---------------------------------- Unison ---------------------------------- */

/// Community-submitted lyrics: Apple-style TTML, stamped LRC, or plain text.
pub async fn fetch_unison(ctx: &Ctx<'_>) -> Option<Found> {
    let artist = search_artist(&ctx.q.artist);
    if artist.is_empty() {
        return None; // the endpoint 400s on an empty artist
    }
    let song = search_title(&ctx.q.title);
    let album = ctx.album().map(clean_title);
    let seconds = (ctx.q.duration > 0.0).then(|| (ctx.seconds() as i64).to_string());
    let mut pairs: Vec<(&str, &str)> = vec![("song", &song), ("artist", &artist)];
    if let Some(a) = &album {
        pairs.push(("album", a));
    }
    if let Some(s) = &seconds {
        pairs.push(("duration", s));
    }
    let json = get_json(ctx.http, &format!("https://unison.boidu.dev/lyrics?{}", params(&pairs)), 6000, &[]).await?;
    if json["success"] != Value::Bool(true) {
        return None;
    }
    let entry = &json["data"];
    // Contributed for a song by name: it must name the playing recording — unless made for this video.
    if entry["videoId"].as_str() != Some(ctx.q.id.as_str()) {
        if let Some(song) = entry["song"].as_str().filter(|s| !s.is_empty()) {
            if !ctx.names(song, &str_of(&entry["artist"]), None) {
                return None;
            }
        }
    }
    let text = entry["lyrics"].as_str().unwrap_or("");
    if text.trim().is_empty() {
        return None;
    }
    let plain = || plain_found("Unison", &text.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"));
    if str_of(&entry["format"]).to_lowercase() == "ttml" {
        return to_result("Unison", parse_ttml(text));
    }
    if str_of(&entry["syncType"]).to_lowercase() == "plain" {
        return plain();
    }
    let enhanced = parse_enhanced_lrc(text);
    if !enhanced.is_empty() {
        return to_result("Unison", enhanced);
    }
    let lrc = parse_lrc(text);
    if !lrc.is_empty() {
        return to_result("Unison", lrc);
    }
    plain()
}

/* ----------------------------------- KuGou ----------------------------------- */

const KUGOU_TOLERANCE: f64 = 8.0;

fn kugou_strip_credits(lrc: &str) -> String {
    static STAMPED: Lazy<Regex> = Lazy::new(|| re(r"^\[[0-9]{2}:[0-9]{2}\.[0-9]{2,3}].*"));
    static CREDIT: Lazy<Regex> = Lazy::new(|| re(r".+][^\[]+[:：].+"));
    let lines: Vec<&str> = lrc.lines().filter(|l| STAMPED.is_match(l)).collect();
    if lines.is_empty() {
        return String::new();
    }
    let head_limit = 30.min(lines.len() - 1);
    let head_cut = (0..=head_limit).rev().find(|&i| CREDIT.is_match(lines[i])).map(|i| i + 1).unwrap_or(0);
    let body = &lines[head_cut..];
    let tail_cut = if body.is_empty() { 0 } else { (0..=30.min(body.len() - 1)).find(|&i| CREDIT.is_match(body[body.len() - 1 - i])).map(|i| i + 1).unwrap_or(0) };
    body[..body.len() - tail_cut].join("\n")
}

/// A downloaded KuGou file as lyrics. None for its "pure music" notice and when the file names another
/// recording (its opening "Title - Artist" line, else its [ti:]/[ar:] tags). `must_name`: a file that
/// names nothing is refused.
fn kugou_lines(lrc: &str, ctx: &Ctx, must_name: bool, length: Option<f64>) -> Option<Vec<Line>> {
    static PURE: Lazy<Regex> = Lazy::new(|| re(r"纯音乐|純音樂"));
    let lines = parse_lrc(&kugou_strip_credits(lrc));
    if lines.is_empty() || lines.iter().all(|l| l.text.trim().is_empty() || PURE.is_match(&l.text)) {
        return None;
    }
    let mut fits = opening_name_fits(&parse_lrc(lrc), ctx.playing(), length);
    if fits.is_none() {
        let tag = |key: &str| -> String {
            Regex::new(&format!(r"(?im)^\[{key}:(.*)\]\s*$")).ok().and_then(|r| r.captures(lrc).map(|c| c[1].trim().to_string())).unwrap_or_default()
        };
        let ti = tag("ti");
        if !ti.is_empty() {
            fits = Some(ctx.names(&ti, &tag("ar"), length));
        }
    }
    if fits == Some(false) || (must_name && fits != Some(true)) {
        return None;
    }
    let sung = without_opening(lines);
    (!sung.is_empty()).then_some(sung)
}

struct KuGouCandidate {
    id: String,
    accesskey: String,
    song: String,
    duration: f64,
}

async fn kugou_download(http: &reqwest::Client, id: &str, key: &str) -> Option<String> {
    let url = format!("https://lyrics.kugou.com/download?{}", params(&[("fmt", "lrc"), ("charset", "utf8"), ("client", "pc"), ("ver", "1"), ("id", id), ("accesskey", key)]));
    let json = get_json(http, &url, 6000, &[]).await?;
    let content = json["content"].as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(content).or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(content)).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

async fn kugou_search_lyrics(http: &reqwest::Client, hash: Option<&str>, keyword: &str, seconds: f64) -> Vec<KuGouCandidate> {
    let ms = ((seconds * 1000.0) as i64).to_string();
    let mut pairs: Vec<(&str, &str)> = vec![("ver", "1"), ("man", "yes"), ("client", "pc")];
    match hash {
        Some(h) => pairs.push(("hash", h)),
        None => {
            if keyword.is_empty() {
                return vec![];
            }
            pairs.push(("keyword", keyword));
            if seconds > 0.0 {
                pairs.push(("duration", &ms));
            }
        }
    }
    let Some(json) = get_json(http, &format!("https://lyrics.kugou.com/search?{}", params(&pairs)), 6000, &[]).await else { return vec![] };
    json["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let d = num_of(&c["duration"]).unwrap_or(0.0);
            KuGouCandidate { id: str_of(&c["id"]), accesskey: str_of(&c["accesskey"]), song: str_of(&c["song"]), duration: if d > 10000.0 { d / 1000.0 } else { d } }
        })
        .filter(|c| !c.id.is_empty() && !c.accesskey.is_empty())
        .collect()
}

/// Line-synced lyrics from KuGou: the song's fingerprint hash, the lyric candidates filed under it, the
/// winner downloaded; a keyword search is the fallback, where the file must name the recording.
pub async fn fetch_kugou(ctx: &Ctx<'_>) -> Option<Found> {
    static PAREN: Lazy<Regex> = Lazy::new(|| re(r"[(（].*?[)）]"));
    let strip = |s: String| {
        let t = PAREN.replace_all(&s, "").trim().to_string();
        if t.is_empty() {
            s
        } else {
            t
        }
    };
    let name = [strip(search_title(&ctx.q.title)), strip(search_artist(&ctx.q.artist))].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" - ");
    let keyword = [name, ctx.album().map(clean_title).unwrap_or_default()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let seconds = ctx.seconds();

    if seconds > 0.0 {
        let url = format!("https://mobileservice.kugou.com/api/v3/search/song?{}", params(&[("version", "9108"), ("plat", "0"), ("pagesize", "8"), ("showtype", "0"), ("keyword", &keyword)]));
        if let Some(json) = get_json(ctx.http, &url, 6000, &[]).await {
            let mut rows: Vec<&Value> = json["data"]["info"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|i| {
                    let d = num_of(&i["duration"]).unwrap_or(-1.0);
                    i["hash"].as_str().map(|h| !h.is_empty()).unwrap_or(false)
                        && (d - seconds).abs() <= KUGOU_TOLERANCE
                        && ctx.names(&str_of(&i["songname"]), &str_of(&i["singername"]), Some(d))
                })
                .collect();
            rows.sort_by(|a, b| {
                let da = (num_of(&a["duration"]).unwrap_or(0.0) - seconds).abs();
                let db = (num_of(&b["duration"]).unwrap_or(0.0) - seconds).abs();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            });
            for row in rows {
                // The lyric files filed under a song's hash can be for its other cuts too.
                let song = recording_name(&str_of(&row["songname"]), false);
                let candidates = kugou_search_lyrics(ctx.http, row["hash"].as_str(), "", 0.0).await;
                let Some(c) = candidates.iter().find(|c| c.song.is_empty() || same_name(&recording_name(&c.song, false), &song)) else { continue };
                let Some(lrc) = kugou_download(ctx.http, &c.id, &c.accesskey).await else { continue };
                let length = if c.duration > 0.0 { Some(c.duration) } else { num_of(&row["duration"]) };
                if let Some(lines) = kugou_lines(&lrc, ctx, false, length) {
                    return to_result("KuGou", lines);
                }
            }
        }
    }
    let candidates = kugou_search_lyrics(ctx.http, None, &keyword, seconds).await;
    if candidates.is_empty() {
        return None;
    }
    let mut pool: Vec<&KuGouCandidate> = candidates.iter().collect();
    if seconds > 0.0 {
        let near: Vec<&KuGouCandidate> = pool.iter().copied().filter(|c| within_tolerance(Some(c.duration), seconds)).collect();
        if !near.is_empty() {
            pool = near;
        }
    }
    let off = |c: &KuGouCandidate| ((if c.duration > 0.0 { c.duration } else { 1e9 }) - seconds).abs();
    pool.sort_by(|a, b| off(a).partial_cmp(&off(b)).unwrap_or(std::cmp::Ordering::Equal));
    for c in pool.into_iter().take(3) {
        let Some(lrc) = kugou_download(ctx.http, &c.id, &c.accesskey).await else { continue };
        if let Some(lines) = kugou_lines(&lrc, ctx, true, Some(c.duration).filter(|d| *d > 0.0)) {
            return to_result("KuGou", lines);
        }
    }
    None
}

/* ----------------------------------- LRCLIB ----------------------------------- */

fn lrclib_record(rec: &Value) -> Option<Found> {
    let synced = rec["syncedLyrics"].as_str().filter(|s| !s.trim().is_empty()).map(parse_lrc);
    if let Some(s) = synced.as_ref().filter(|s| s.len() >= 3) {
        return to_result("LRCLIB", s.clone());
    }
    if let Some(plain) = rec["plainLyrics"].as_str().filter(|s| !s.trim().is_empty()) {
        return Some(Found { source: "LRCLIB".into(), word_synced: false, lines: vec![], plain: Some(plain.to_string()) });
    }
    synced.filter(|s| !s.is_empty()).and_then(|s| to_result("LRCLIB", s))
}

/// Of the search records carrying synced lyrics that name the playing recording, the one closest in
/// length; with no credit to check, only a record within tolerance.
fn pick_lrclib_hit(results: Option<Value>, ctx: &Ctx) -> Option<Found> {
    let results = results?;
    let synced: Vec<&Value> = results
        .as_array()?
        .iter()
        .filter(|rec| {
            rec["syncedLyrics"].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)
                && ctx.names(&str_of(&rec["trackName"]), &str_of(&rec["artistName"]), rec["duration"].as_f64())
        })
        .collect();
    if synced.is_empty() {
        return None;
    }
    let credited = !artist_names(&ctx.q.artist).is_empty();
    let seconds = ctx.seconds();
    if seconds <= 0.0 {
        return if credited { lrclib_record(synced[0]) } else { None };
    }
    let dur = |r: &Value| r["duration"].as_f64();
    let near: Vec<&Value> = synced.iter().copied().filter(|r| within_tolerance(dur(r), seconds)).collect();
    if !credited && near.is_empty() {
        return None;
    }
    let pool = if near.is_empty() { synced } else { near };
    let off = |r: &Value| (dur(r).unwrap_or(1e9) - seconds).abs();
    // The first of the closest, as the search ordered them.
    let best = pool.iter().copied().fold(None::<&Value>, |best, r| match best {
        Some(b) if off(r) >= off(b) => Some(b),
        _ => Some(r),
    })?;
    lrclib_record(best)
}

pub async fn fetch_lrclib(ctx: &Ctx<'_>) -> Option<Found> {
    let get = |path: String| async move { get_json(ctx.http, &format!("https://lrclib.net/api{path}"), 7000, &[]).await };
    let artist = search_artist(&ctx.q.artist);
    let stripped = query_title(&ctx.q.title);
    if stripped.is_empty() {
        return None;
    }
    let full = clean_title(&ctx.q.title);
    let titles = if !full.is_empty() && full.to_lowercase() != stripped.to_lowercase() { vec![full, stripped.clone()] } else { vec![stripped.clone()] };
    let mut plain_only: Option<Found> = None;
    for title in &titles {
        if !artist.is_empty() && ctx.q.duration > 0.0 {
            let album = ctx.album().map(|a| format!("&album_name={}", enc(&clean_title(a)))).unwrap_or_default();
            let rec = get(format!("/get?artist_name={}&track_name={}{album}&duration={}", enc(&artist), enc(title), ctx.seconds() as i64)).await;
            let exact = rec
                .filter(|rec| ctx.names(&str_of(&rec["trackName"]), &str_of(&rec["artistName"]), rec["duration"].as_f64()))
                .and_then(|rec| lrclib_record(&rec));
            // A plain-only record can have a synced sibling the searches find.
            if let Some(e) = exact {
                if !e.lines.is_empty() {
                    return Some(e);
                }
                plain_only = plain_only.or(Some(e));
            }
        }
        if !artist.is_empty() {
            if let Some(hit) = pick_lrclib_hit(get(format!("/search?track_name={}&artist_name={}", enc(title), enc(&artist))).await, ctx) {
                return Some(hit);
            }
        }
    }
    let term = format!("{artist} {stripped}");
    pick_lrclib_hit(get(format!("/search?q={}", enc(term.trim()))).await, ctx).or(plain_only)
}

/* --------------------------------- Musixmatch --------------------------------- */

const MUSIXMATCH_BASE: &str = "https://apic.musixmatch.com/ws/1.1";
const MUSIXMATCH_APP_ID: &str = "mobile-app-v1.0";
const MUSIXMATCH_FALLBACK_SECRET: &str = "f09016176ba43a1cfd1031fbd6b3d26c";

#[derive(Default)]
struct Mx {
    secret: Option<String>,
    token: Option<String>,
    /// token.get answers some networks with a 403 for every client: parked until restart.
    blocked: bool,
}
static MX: Lazy<Mutex<Mx>> = Lazy::new(|| Mutex::new(Mx::default()));
static MX_GUID: Lazy<String> = Lazy::new(|| {
    let h = format!("{:032x}", rand::random::<u128>());
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
});

/// Signs `<url><UTC yyyyMMdd>` with HMAC-SHA256, matching Musixmatch's web client.
fn mx_sign(url: &str, secret: &str) -> String {
    use hmac::{Hmac, Mac};
    let normalized = url.replace("%20", "+").replace(' ', "+");
    let date = chrono::Utc::now().format("%Y%m%d");
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(format!("{normalized}{date}").as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    format!("{normalized}&signature={}&signature_protocol=sha256", enc(&signature))
}

/// The rotating signing key, read from the JavaScript the web client links (a baked-in copy otherwise).
async fn mx_secret(http: &reqwest::Client) -> String {
    if let Some(s) = MX.lock().unwrap().secret.clone() {
        return s;
    }
    static SCRIPT: Lazy<Regex> = Lazy::new(|| re(r#"(?i)src=["']([^"']*/_next/static/chunks/pages/_app-[^"']+\.js)["']"#));
    static ENCODED: Lazy<Regex> = Lazy::new(|| re(r#"from\(\s*["']([^"']+)["']\s*\.split"#));
    let browser = [("User-Agent", UA), ("Accept-Language", "en-US,en;q=0.9"), ("Cookie", "mxm_bab=AB")];
    let mut secret = None;
    let page_headers = [browser[0], browser[1], browser[2], ("Accept", "text/html,application/xhtml+xml")];
    if let Some(page) = get_text(http, "https://www.musixmatch.com/search", 8000, &page_headers).await {
        if let Some(script) = SCRIPT.captures(&page).map(|c| c[1].to_string()) {
            let script_url = url::Url::parse("https://www.musixmatch.com").and_then(|b| b.join(&script)).map(|u| u.to_string()).unwrap_or(script);
            let js_headers = [browser[0], browser[1], browser[2], ("Accept", "*/*")];
            if let Some(js) = get_text(http, &script_url, 8000, &js_headers).await {
                if let Some(encoded) = ENCODED.captures(&js).map(|c| c[1].chars().rev().collect::<String>()) {
                    secret = base64::engine::general_purpose::STANDARD.decode(encoded).ok().map(|b| String::from_utf8_lossy(&b).into_owned()).filter(|s| !s.trim().is_empty());
                }
            }
        }
    }
    let secret = secret.unwrap_or_else(|| MUSIXMATCH_FALLBACK_SECRET.to_string());
    MX.lock().unwrap().secret = Some(secret.clone());
    secret
}

async fn mx_token(http: &reqwest::Client, secret: &str) -> Option<String> {
    {
        let mx = MX.lock().unwrap();
        if let Some(t) = &mx.token {
            return Some(t.clone());
        }
        if mx.blocked {
            return None;
        }
    }
    let url = format!("{MUSIXMATCH_BASE}/token.get?{}", params(&[("app_id", MUSIXMATCH_APP_ID), ("guid", &MX_GUID), ("format", "json")]));
    let body = match fetch(http, &mx_sign(&url, secret), 8000, &[("User-Agent", UA), ("Accept-Language", "en-US,en;q=0.9")]).await {
        Got::Text(t) => t,
        Got::Status(403) => {
            MX.lock().unwrap().blocked = true;
            return None;
        }
        _ => return None,
    };
    let json: Value = serde_json::from_str(&body).ok()?;
    let token = json.pointer("/message/body/user_token")?.as_str().filter(|t| !t.is_empty())?.to_string();
    if json.pointer("/message/header/status_code").and_then(|s| s.as_i64()) != Some(200) {
        return None;
    }
    MX.lock().unwrap().token = Some(token.clone());
    Some(token)
}

/// Musixmatch reports an expired token inside a successful HTTP response.
fn mx_unauthorized(body: &str) -> bool {
    serde_json::from_str::<Value>(body).ok().and_then(|j| j.pointer("/message/header/status_code").and_then(|s| s.as_i64())).map(|s| s == 401 || s == 402).unwrap_or(false)
}

async fn mx_signed_get(http: &reqwest::Client, build: impl Fn(&str) -> String) -> Option<String> {
    let headers = [("User-Agent", UA), ("Accept-Language", "en-US,en;q=0.9")];
    let secret = mx_secret(http).await;
    let token = mx_token(http, &secret).await?;
    if let Some(first) = get_text(http, &mx_sign(&build(&token), &secret), 8000, &headers).await {
        if !mx_unauthorized(&first) {
            return Some(first);
        }
    }
    {
        let mut mx = MX.lock().unwrap();
        mx.token = None;
        mx.secret = None;
    }
    let secret = mx_secret(http).await;
    let token = mx_token(http, &secret).await?;
    get_text(http, &mx_sign(&build(&token), &secret), 8000, &headers).await.filter(|b| !mx_unauthorized(b))
}

fn mx_score(name: &str, artist_name: &str, length: Option<f64>, title: &str, artist: &str, seconds: f64) -> i32 {
    let mut score = 0;
    let (n, want) = (name.trim().to_lowercase(), title.trim().to_lowercase());
    if n == want {
        score += 80;
    } else if n.contains(&want) || want.contains(&n) {
        score += 40;
    }
    let want_artist = artist.trim().to_lowercase();
    if !want_artist.is_empty() && artist_name.trim().to_lowercase().contains(&want_artist) {
        score += 40;
    }
    if let Some(len) = length.filter(|l| *l > 0.0) {
        if seconds > 0.0 {
            let diff = (len - seconds).abs();
            score += if diff <= 2.0 { 30 } else if diff <= 5.0 { 15 } else if diff <= 10.0 { 5 } else { -20 };
        }
    }
    score
}

/// Musixmatch's rich-sync JSON, fragment order kept (punctuation and syllables may share a stamp).
fn parse_musixmatch_richsync(body: &str) -> Vec<Line> {
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(body) else { return vec![] };
    let mut out = Vec::new();
    for entry in &entries {
        let line_start = entry["ts"].as_f64().unwrap_or(0.0);
        let line_end = line_start.max(entry["te"].as_f64().unwrap_or(line_start));
        let fragments = entry["l"].as_array().cloned().unwrap_or_default();
        let mut words: Vec<Word> = Vec::new();
        let mut cur: Option<Word> = None;
        let mut prev_start = line_start;
        let flush = |cur: &mut Option<Word>, words: &mut Vec<Word>| {
            if let Some(c) = cur.take() {
                let text = c.text.trim().to_string();
                if !text.is_empty() {
                    words.push(Word { start: c.start, end: c.start.max(c.end), text });
                }
            }
        };
        for (index, fragment) in fragments.iter().enumerate() {
            let raw = fragment["c"].as_str().unwrap_or("");
            if raw.is_empty() {
                continue;
            }
            let start = line_start.max(prev_start).max(line_start + fragment["o"].as_f64().unwrap_or(0.0));
            let next = fragments.get(index + 1).map(|f| line_start + f["o"].as_f64().unwrap_or(0.0)).unwrap_or(line_end);
            let end = start.max(line_end.min(next));
            prev_start = start;
            if raw.starts_with(char::is_whitespace) {
                flush(&mut cur, &mut words);
            }
            let content = raw.trim();
            if !content.is_empty() {
                match cur.as_mut() {
                    None => cur = Some(Word { start, end, text: content.to_string() }),
                    Some(c) => {
                        c.text.push_str(content);
                        c.end = end;
                    }
                }
            }
            if raw.ends_with(char::is_whitespace) {
                flush(&mut cur, &mut words);
            }
        }
        flush(&mut cur, &mut words);
        let x = str_of(&entry["x"]);
        let text = if x.trim().is_empty() { words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ") } else { x.trim().to_string() };
        if text.is_empty() {
            continue;
        }
        out.push(Line {
            time: line_start.min(words.first().map(|w| w.start).unwrap_or(line_start)),
            text,
            end: (line_end > line_start).then_some(line_end),
            words: Some(words),
            ..Default::default()
        });
    }
    out.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Musixmatch's `mxm` subtitle JSON, as LRC lines for the line-sync fallback.
fn mx_subtitle_lines(body: &str) -> Vec<Line> {
    let Ok(Value::Array(lines)) = serde_json::from_str::<Value>(body) else { return vec![] };
    let mut lrc = Vec::new();
    for line in &lines {
        let text = str_of(&line["text"]);
        if text.trim().is_empty() {
            continue;
        }
        let total_ms = (line["time"]["total"].as_f64().unwrap_or(0.0) * 1000.0).round() as i64;
        lrc.push(format!("[{:02}:{:02}.{:03}]{text}", total_ms / 60000, (total_ms % 60000) / 1000, total_ms % 1000));
    }
    parse_lrc(&lrc.join("\n"))
}

/// Rich word timing, with a line-synced fallback, from Musixmatch's web API, signed the way its web
/// client signs (no user key).
pub async fn fetch_musixmatch(ctx: &Ctx<'_>) -> Option<Found> {
    let artist = search_artist(&ctx.q.artist);
    let seconds = ctx.seconds();
    let stripped = query_title(&ctx.q.title);
    let full = clean_title(&ctx.q.title);
    let titles = if !full.is_empty() && full.to_lowercase() != stripped.to_lowercase() { vec![full, stripped] } else { vec![stripped] };
    struct Best {
        id: i64,
        score: i32,
        richsync: bool,
        subtitles: bool,
    }
    let mut best: Option<Best> = None;
    for title in &titles {
        let body = mx_signed_get(ctx.http, |token| {
            format!(
                "{MUSIXMATCH_BASE}/track.search?{}",
                params(&[
                    ("app_id", MUSIXMATCH_APP_ID),
                    ("format", "json"),
                    ("q_track", title),
                    ("q_artist", &artist),
                    ("f_has_lyrics", "1"),
                    ("s_track_rating", "desc"),
                    ("quorum_factor", "1"),
                    ("page_size", "10"),
                    ("page", "1"),
                    ("usertoken", token),
                ])
            )
        })
        .await;
        let Some(json) = body.and_then(|b| serde_json::from_str::<Value>(&b).ok()) else { continue };
        for wrapper in json.pointer("/message/body/track_list").and_then(|l| l.as_array()).into_iter().flatten() {
            let t = &wrapper["track"];
            let Some(id) = t["track_id"].as_i64() else { continue };
            let (name, artist_name, length) = (str_of(&t["track_name"]), str_of(&t["artist_name"]), t["track_length"].as_f64());
            // The score only ranks real matches; it never makes one.
            if !ctx.names(&name, &artist_name, length) {
                continue;
            }
            let score = mx_score(&name, &artist_name, length, title, &artist, seconds);
            if best.as_ref().map(|b| score > b.score).unwrap_or(true) {
                best = Some(Best { id, score, richsync: t["has_richsync"].as_i64().unwrap_or(0) != 0, subtitles: t["has_subtitles"].as_i64().unwrap_or(0) != 0 });
            }
        }
        if best.is_some() {
            break;
        }
    }
    let best = best?;
    let id = best.id.to_string();
    if best.richsync {
        let body = mx_signed_get(ctx.http, |token| {
            format!("{MUSIXMATCH_BASE}/track.richsync.get?{}", params(&[("app_id", MUSIXMATCH_APP_ID), ("format", "json"), ("track_id", &id), ("usertoken", token)]))
        })
        .await;
        if let Some(rich) = body.and_then(|b| serde_json::from_str::<Value>(&b).ok()).and_then(|j| j.pointer("/message/body/richsync/richsync_body").and_then(|v| v.as_str()).map(String::from)) {
            let lines = parse_musixmatch_richsync(&rich);
            if lines.iter().any(|l| l.words.as_ref().map(|w| !w.is_empty()).unwrap_or(false)) {
                return to_result("Musixmatch", lines);
            }
        }
    }
    if best.subtitles {
        let body = mx_signed_get(ctx.http, |token| {
            format!(
                "{MUSIXMATCH_BASE}/track.subtitle.get?{}",
                params(&[("app_id", MUSIXMATCH_APP_ID), ("format", "json"), ("track_id", &id), ("subtitle_format", "mxm"), ("usertoken", token)])
            )
        })
        .await;
        if let Some(sub) = body.and_then(|b| serde_json::from_str::<Value>(&b).ok()).and_then(|j| j.pointer("/message/body/subtitle/subtitle_body").and_then(|v| v.as_str()).map(String::from)) {
            let lines = mx_subtitle_lines(&sub);
            if !lines.is_empty() {
                return to_result("Musixmatch", lines);
            }
        }
    }
    None
}

/* ----------------------------------- Genius ----------------------------------- */

/// The User-Agent claims nothing: Cloudflare challenges a browser-claiming agent whose TLS doesn't back it.
const GENIUS_AGENT: &str = "ByTune";

fn genius_clean_query(text: &str) -> String {
    static SYMBOLS: Lazy<Regex> = Lazy::new(|| re(r"[♪♫★☆【】《》「」~_]"));
    static BRACKETS: Lazy<Regex> = Lazy::new(|| {
        re(r"(?i)\s*[(\[]\s*(?:from|feat\.?|ft\.?|featuring|with|prod\.?|produced by|official|lyrical|video|audio|remix|music video|visualizer|mv|hd|4k|hq|full song)[^)\]]*[)\]]")
    });
    static LABELS: Lazy<Regex> =
        Lazy::new(|| re(r"(?i)\s*\b(?:official\s+(?:music\s+)?(?:video|audio)|lyrical(?:\s+video)?|full\s+song|4k\s+video|hd\s+video|music\s+video)\b"));
    static PROD: Lazy<Regex> = Lazy::new(|| re(r"(?i)\b(?:prod(?:uced)?\.?(?:\s+by)?)\s+.*$"));
    let t = SYMBOLS.replace_all(text, " ");
    let t = BRACKETS.replace_all(&t, " ");
    let t = LABELS.replace_all(&t, " ");
    let t = PROD.replace(&t, "");
    let t = t.split(" | ").next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        text.trim().to_string()
    } else {
        t
    }
}

fn genius_best_match(candidates: &[Value], title: &str, artist: &str, ctx: &Ctx) -> Option<String> {
    let (nt, na) = (title.to_lowercase(), artist.to_lowercase());
    let mut best: Option<String> = None;
    let mut best_score = 0;
    for item in candidates {
        let (t_raw, a_raw) = (str_of(&item["title"]), str_of(&item["artist_names"]));
        // Plain text: a sped-up or slowed upload still reads the song's own page.
        if !names_recording(&t_raw, &a_raw, ctx.playing(), None, true) {
            continue;
        }
        let (t, a) = (t_raw.to_lowercase(), a_raw.to_lowercase());
        let title_matches = !nt.is_empty() && (t == nt || t.contains(&nt) || nt.contains(&t));
        let artist_matches = !na.is_empty() && (a == na || a.contains(&na) || na.contains(&a));
        let mut score = 0;
        if t == nt {
            score += 50;
        } else if title_matches {
            score += 25;
        }
        if artist_matches {
            score += if a == na { 40 } else { 20 };
        }
        let path = str_of(&item["path"]).to_lowercase();
        if path.contains("translation") && !nt.contains("translation") {
            score -= 30;
        }
        if path.contains("türkçe") || path.contains("polskie-tlumaczenie") {
            score -= 40;
        }
        if path.contains("tracklist") || path.contains("album-art") {
            score -= 50;
        }
        if score > best_score {
            best_score = score;
            best = item["url"].as_str().map(String::from);
        }
    }
    if best_score > 0 {
        best
    } else {
        None
    }
}

fn genius_extract(html: &str) -> Option<String> {
    use scraper::{ElementRef, Html, Node, Selector};
    const SKIP_CLASSES: &[&str] = &["LyricsHeader__Container", "SongBioPreview__Container", "InreadAd__Container"];
    fn walk(el: ElementRef, out: &mut String) {
        for child in el.children() {
            match child.value() {
                Node::Text(t) => out.push_str(t),
                Node::Element(e) => {
                    if e.attr("data-exclude-from-selection") == Some("true")
                        || e.classes().any(|c| SKIP_CLASSES.contains(&c))
                        || matches!(e.name(), "button" | "script" | "style")
                    {
                        continue;
                    }
                    if e.name() == "br" {
                        out.push('\n');
                        continue;
                    }
                    if e.name() == "p" {
                        out.push('\n');
                    }
                    if let Some(inner) = ElementRef::wrap(child) {
                        walk(inner, out);
                    }
                }
                _ => {}
            }
        }
    }
    let doc = Html::parse_document(html);
    let primary = Selector::parse(r#"div[data-lyrics-container="true"]"#).ok()?;
    let mut containers: Vec<ElementRef> = doc.select(&primary).collect();
    if containers.is_empty() {
        let older = Selector::parse("div.lyrics").ok()?;
        containers = doc.select(&older).collect();
    }
    let mut parts = Vec::new();
    for c in containers {
        let mut text = String::new();
        walk(c, &mut text);
        if !text.trim().is_empty() {
            parts.push(text);
        }
    }
    static MIGHT_LIKE: Lazy<Regex> = Lazy::new(|| re(r"(?i)[0-9]*You might also like"));
    static EMBED: Lazy<Regex> = Lazy::new(|| re(r"(?i)[0-9]*Embed\s*$"));
    let joined = parts.join("\n").replace(['\u{a0}', '\u{200b}', '\u{feff}'], " ");
    let cleaned = MIGHT_LIKE.replace_all(&joined, "");
    let cleaned = EMBED.replace(cleaned.trim(), "").trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Plain-text lyrics scraped from Genius — the last resort that almost always answers.
pub async fn fetch_genius(ctx: &Ctx<'_>) -> Option<Found> {
    let artist = search_artist(&ctx.q.artist);
    let title = query_title(&ctx.q.title);
    if title.is_empty() {
        return None;
    }
    let clean = genius_clean_query(&title);
    let mut attempts: Vec<(String, String, String)> = Vec::new();
    let mut push = |query: String, t: String, a: String| {
        let query = query.trim().to_string();
        if !query.is_empty() && !attempts.iter().any(|x| x.0 == query) {
            attempts.push((query, t, a));
        }
    };
    if !artist.is_empty() {
        push(format!("{artist} {title}"), title.clone(), artist.clone());
        if clean.to_lowercase() != title.to_lowercase() {
            push(format!("{artist} {clean}"), clean.clone(), artist.clone());
        }
    }
    let fallback = if clean.is_empty() { title.clone() } else { clean.clone() };
    push(fallback.clone(), fallback, artist.clone());
    let headers = [
        ("User-Agent", GENIUS_AGENT),
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8"),
        ("Accept-Language", "en-US,en;q=0.9"),
    ];
    let mut song_url = None;
    for (query, t, a) in &attempts {
        let Some(json) = get_json(ctx.http, &format!("https://genius.com/api/search/multi?q={}", enc(query)), 8000, &headers).await else { continue };
        let Some(sections) = json.pointer("/response/sections").and_then(|s| s.as_array()) else { continue };
        let hits: Vec<Value> = sections.iter().find(|s| s["type"] == "song").and_then(|s| s["hits"].as_array()).into_iter().flatten().map(|h| h["result"].clone()).filter(|r| r.is_object()).collect();
        if let Some(best) = genius_best_match(&hits, t, a, ctx) {
            song_url = Some(best);
            break;
        }
    }
    let html = get_text(ctx.http, &song_url?, 9000, &headers).await?;
    let text = tokio::task::spawn_blocking(move || genius_extract(&html)).await.ok().flatten()?;
    plain_found("Genius", &text)
}

/* ------------------------ the playing video's own tabs ------------------------ */

/// Timed captions for the exact playing video (get_transcript; params = protobuf field 1 = the id).
pub async fn fetch_transcript(music: &crate::music::Music, ctx: &Ctx<'_>) -> Option<Found> {
    static NOISE: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(\[(music|applause|laughter|cheering|instrumental)\]|[♪♫\s]*)$"));
    let video_id = &ctx.q.id;
    if !ctx.is_youtube() || video_id.len() != 11 {
        return None;
    }
    let mut raw = vec![10u8, video_id.len() as u8];
    raw.extend_from_slice(video_id.as_bytes());
    let params = base64::engine::general_purpose::STANDARD.encode(raw);
    let body = music.it.get_transcript(&params).await.ok()?;
    let ms = |v: Option<&Value>| -> Option<f64> {
        match v? {
            Value::Number(n) => n.as_f64().map(|x| x / 1000.0),
            Value::String(s) => s.parse::<f64>().ok().map(|x| x / 1000.0),
            _ => None,
        }
    };
    let mut lines: Vec<Line> = Vec::new();
    let segments = crate::ytm::collect_renderers(Some(&body), "transcriptSegmentRenderer");
    if !segments.is_empty() {
        for seg in segments {
            let Some(time) = ms(seg.get("startMs")) else { continue };
            let text = crate::ytm::text(seg.get("snippet")).replace(['♪', '♫'], "").trim().to_string();
            if text.is_empty() || NOISE.is_match(&text) {
                continue;
            }
            lines.push(Line { time, text, end: ms(seg.get("endMs")).filter(|e| *e > time), ..Default::default() });
        }
    } else {
        for cue in crate::ytm::collect_renderers(Some(&body), "transcriptCueRenderer") {
            let Some(time) = ms(cue.get("startOffsetMs")) else { continue };
            let text = crate::ytm::text(cue.get("cue")).replace(['♪', '♫'], "").trim().to_string();
            if text.is_empty() || NOISE.is_match(&text) {
                continue;
            }
            lines.push(Line { time, text, ..Default::default() });
        }
    }
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    to_result("YouTube Captions", lines)
}

/// Plain lyrics from YT Music's own Lyrics tab, ranked as a source of its own.
pub async fn fetch_youtube_music(music: &crate::music::Music, ctx: &Ctx<'_>) -> Option<Found> {
    if !ctx.is_youtube() {
        return None;
    }
    plain_found("YouTube Music", &music.yt_music_plain_lyrics(&ctx.q.id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn richsync_words() {
        let body = r#"[{"ts":1.0,"te":3.0,"l":[{"c":"Hel","o":0},{"c":"lo ","o":0.5},{"c":"world","o":1.0}],"x":"Hello world"}]"#;
        let lines = parse_musixmatch_richsync(body);
        assert_eq!(lines[0].words.as_ref().unwrap().iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), vec!["Hello", "world"]);
    }

    #[test]
    fn genius_html() {
        let html = r#"<html><body><div data-lyrics-container="true">Line one<br/>Line two<div data-exclude-from-selection="true">ad</div></div></body></html>"#;
        assert_eq!(genius_extract(html).as_deref(), Some("Line one\nLine two"));
    }

    #[test]
    fn mx_signature_shape() {
        let s = mx_sign("https://x/y?a=b c", "k");
        assert!(s.starts_with("https://x/y?a=b+c&signature="));
        assert!(s.ends_with("&signature_protocol=sha256"));
    }
}
