//! Raw InnerTube (YouTube Music) response parsing — a port of ByTune's
//! `electron/ytm.ts`, itself a port of BitChord mobile's InnertubeParser.
//!
//! Every function reads the raw renderer JSON (`musicResponsiveListItemRenderer`,
//! `musicCardShelfRenderer`, …) and classifies rows the way the mobile app does,
//! so results keep YouTube's own order, count and subtitles. All navigation is
//! null-safe: a missing key yields `None`/"" and never panics.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

/* ---------------- shared data shapes (src/types.ts) ---------------- */

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    /// seconds (0 = unknown)
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub thumb: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explicit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<bool>,
    /// ParsedSong.isVideo — the row's own kind word / widescreen-art verdict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_video: Option<bool>,
    /// RadioTrack.videoType: song | video | upload | episode
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_type: Option<String>,
    /// PodcastEpisode extras
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl Track {
    pub fn is_video(&self) -> bool {
        self.is_video == Some(true)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowseItem {
    pub browse_id: String,
    pub title: String,
    pub subtitle: String,
    pub thumb: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Clone, Debug, Default)]
pub struct Credits {
    pub artist_id: Option<String>,
    pub artist_name: Option<String>,
    pub album_id: Option<String>,
    pub album_name: Option<String>,
}

/// One search row: the promoted card, an ordinary track, or a browsable page row.
#[derive(Clone, Debug)]
pub enum SearchRow {
    Top(Track),
    Track(Track),
    Browse { item: BrowseItem, top: bool },
}

impl SearchRow {
    pub fn to_json(&self) -> Value {
        match self {
            SearchRow::Top(song) => json!({ "kind": "top", "song": song }),
            SearchRow::Track(song) => json!({ "kind": "track", "song": song }),
            SearchRow::Browse { item, top } => {
                if *top {
                    json!({ "kind": "browse", "item": item, "top": true })
                } else {
                    json!({ "kind": "browse", "item": item })
                }
            }
        }
    }
}

/* ---------------- search filter params (mobile SearchFilter) ---------------- */

pub fn search_filter_params(filter: &str) -> Option<&'static str> {
    match filter {
        "songs" => Some("EgWKAQIIAWoKEAkQChAFEAMQBA=="),
        "videos" => Some("EgWKAQIQAWoKEAkQChAFEAMQBA=="),
        "albums" => Some("EgWKAQIYAWoKEAkQChAFEAMQBA=="),
        "artists" => Some("EgWKAQIgAWoKEAkQChAFEAMQBA=="),
        "playlists" => Some("EgWKAQIoAWoKEAkQChAFEAMQBA=="),
        "podcasts" => Some("EgWKAQJQAWoKEAkQChAFEAMQBA=="),
        _ => None,
    }
}

/* ---------------- tiny JSON navigation (null-safe, never panics) ---------------- */

pub fn o<'a>(node: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    node?.as_object()?.get(key).filter(|v| v.is_object())
}

pub fn a<'a>(node: Option<&'a Value>, key: &str) -> Option<&'a Vec<Value>> {
    node?.as_object()?.get(key)?.as_array()
}

pub fn s(node: Option<&Value>, key: &str) -> Option<String> {
    match node?.as_object()?.get(key)? {
        Value::String(v) => Some(v.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// {runs:[{text}]} | {simpleText} | string — joined.
pub fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(t)) => t.clone(),
        Some(Value::Object(m)) => {
            if let Some(Value::String(t)) = m.get("simpleText") {
                return t.clone();
            }
            if let Some(Value::Array(runs)) = m.get("runs") {
                return runs.iter().map(|r| s(Some(r), "text").unwrap_or_default()).collect();
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn first_run_text(node: Option<&Value>) -> Option<String> {
    let runs = a(node, "runs")?;
    runs.first().and_then(|r| s(Some(r), "text"))
}

/// Depth-first collection of a named renderer, preserving document order.
pub fn collect_renderers<'a>(root: Option<&'a Value>, name: &str) -> Vec<&'a Value> {
    fn visit<'a>(node: &'a Value, name: &str, out: &mut Vec<&'a Value>) {
        match node {
            Value::Array(items) => {
                for item in items {
                    visit(item, name, out);
                }
            }
            Value::Object(map) => {
                if let Some(hit) = map.get(name) {
                    if hit.is_object() || hit.is_array() {
                        out.push(hit);
                    }
                }
                for value in map.values() {
                    if value.is_object() || value.is_array() {
                        visit(value, name, out);
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    if let Some(root) = root {
        visit(root, name, &mut out);
    }
    out
}

fn ptr(v: &Value) -> usize {
    v as *const Value as usize
}

/* ---------------- artwork (electron/artwork.ts) ---------------- */

pub fn largest_thumb_url(thumbnails: Option<&Value>) -> String {
    let Some(list) = thumbnails.and_then(|t| t.as_array()) else { return String::new() };
    if list.is_empty() {
        return String::new();
    }
    let mut best = list.last().unwrap();
    let mut best_area: f64 = -1.0;
    for t in list {
        let w = t.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let h = t.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let area = if w > 0.0 && h > 0.0 { w * h } else { -1.0 };
        if area > best_area {
            best_area = area;
            best = t;
        }
    }
    best.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string()
}

static RE_SPARSE: Lazy<Regex> = Lazy::new(|| Regex::new(r"150x150|50x50").unwrap());
static RE_YTIMG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(https?://i\.ytimg\.com/vi/[^/?#]+/)(default|mqdefault|hqdefault|sddefault|hq720)(?:\.jpg)?(?:\?.*)?$").unwrap()
});
static RE_S: Lazy<Regex> = Lazy::new(|| Regex::new(r"=s\d+").unwrap());
static RE_WH: Lazy<Regex> = Lazy::new(|| Regex::new(r"=w\d+(-c)?-h\d+").unwrap());
static RE_PATH_WH: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)/w\d+(-c)?-h\d+((?:-[a-z0-9]+)*)/").unwrap());
static RE_DEFAULT_JPG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)/default\.jpg(?:\?.*)?$").unwrap());

pub fn upgrade_thumb(url: &str, target: u32) -> String {
    let mut out = url.trim().to_string();
    if out.is_empty() {
        return out;
    }
    out = RE_SPARSE.replace_all(&out, "500x500").into_owned();
    out = RE_YTIMG
        .replace(&out, |c: &regex::Captures| {
            let name = c[2].to_lowercase();
            let file = if name == "default" || name == "mqdefault" { "hqdefault".to_string() } else { name };
            format!("{}{}.jpg", &c[1], file)
        })
        .into_owned();
    out = RE_S.replace_all(&out, format!("=s{target}").as_str()).into_owned();
    out = RE_WH
        .replace_all(&out, |c: &regex::Captures| {
            format!("=w{target}{}-h{target}", c.get(1).map(|m| m.as_str()).unwrap_or(""))
        })
        .into_owned();
    out = RE_PATH_WH
        .replace_all(&out, |c: &regex::Captures| {
            format!(
                "/w{target}{}-h{target}{}/",
                c.get(1).map(|m| m.as_str()).unwrap_or(""),
                c.get(2).map(|m| m.as_str()).unwrap_or("")
            )
        })
        .into_owned();
    out = RE_DEFAULT_JPG.replace(&out, "/hqdefault.jpg").into_owned();
    out
}

pub fn best_thumb(thumbnails: Option<&Value>) -> String {
    upgrade_thumb(&largest_thumb_url(thumbnails), 544)
}

/* ---------------- parse vocabulary (mobile constants) ---------------- */

static DURATION: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+(?::\d{2}){1,2}$").unwrap());
static YEAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}$").unwrap());
static TALLY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)[\d.,]+\s*[KMB]?\s+(plays|views|likes|songs|tracks|subscribers|hours?|minutes?|seconds?)\b.*").unwrap()
});
static VIDEO_WORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bvideos?\b").unwrap());
const TYPE_WORDS: &[&str] = &["song", "video", "album", "single", "ep", "artist", "playlist", "podcast", "episode"];
const RELEASE_WORDS: &[&str] = &["album", "single", "ep"];
const HEADER_RENDERERS: &[&str] = &["musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer"];
const HEADER_CREDIT_LINES: &[&str] = &["straplineTextOne", "subtitle"];

fn is_type_word(p: &str) -> bool {
    TYPE_WORDS.contains(&p.to_lowercase().as_str())
}

fn page_type_of(endpoint: Option<&Value>) -> String {
    s(
        o(o(endpoint, "browseEndpointContextSupportedConfigs"), "browseEndpointContextMusicConfig"),
        "pageType",
    )
    .unwrap_or_default()
}

fn kind_of_page(page_type: &str) -> &'static str {
    if page_type.contains("PODCAST") {
        "podcast"
    } else if page_type.contains("ALBUM") {
        "album"
    } else if page_type.contains("ARTIST") {
        "artist"
    } else if page_type.contains("PLAYLIST") {
        "playlist"
    } else {
        "other"
    }
}

fn has_explicit_badge(node: Option<&Value>) -> bool {
    match node {
        Some(Value::String(t)) => t == "MUSIC_EXPLICIT_BADGE",
        Some(Value::Array(items)) => items.iter().any(|v| has_explicit_badge(Some(v))),
        Some(Value::Object(m)) => m.values().any(|v| has_explicit_badge(Some(v))),
        _ => false,
    }
}

fn row_thumbnails(renderer: Option<&Value>) -> Option<&Value> {
    o(o(o(renderer, "thumbnail"), "musicThumbnailRenderer"), "thumbnail").and_then(|t| t.get("thumbnails"))
}

/// Catalogue art is square; a music-video upload's thumbnail is widescreen.
fn is_not_square(thumbnails: Option<&Value>) -> bool {
    let Some(last) = thumbnails.and_then(|t| t.as_array()).and_then(|l| l.last()) else { return false };
    let w = s(Some(last), "width").and_then(|v| v.parse::<f64>().ok()).unwrap_or(f64::NAN);
    let h = s(Some(last), "height").and_then(|v| v.parse::<f64>().ok()).unwrap_or(f64::NAN);
    if !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return false;
    }
    !(w / h >= 0.85 && w / h <= 1.15)
}

fn credits_of<'a>(runs: impl IntoIterator<Item = &'a Value>) -> Credits {
    let mut credits = Credits::default();
    for run in runs {
        let browse = o(o(Some(run), "navigationEndpoint"), "browseEndpoint");
        let Some(id) = s(browse, "browseId") else { continue };
        let page_type = page_type_of(browse);
        if page_type.contains("ARTIST") && credits.artist_id.is_none() {
            credits.artist_id = Some(id);
            credits.artist_name = s(Some(run), "text");
        } else if page_type.contains("ALBUM") && credits.album_id.is_none() {
            credits.album_id = Some(id);
            credits.album_name = s(Some(run), "text");
        }
    }
    credits
}

pub fn parse_duration_text(v: &str) -> f64 {
    let v = v.trim();
    if !DURATION.is_match(v) {
        return 0.0;
    }
    v.split(':').fold(0.0, |acc, p| acc * 60.0 + p.parse::<f64>().unwrap_or(0.0))
}

fn split_bullets(line: &str) -> Vec<String> {
    line.split(" • ").map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

fn flex_text(columns: &[Value], i: usize) -> String {
    text(o(o(columns.get(i), "musicResponsiveListItemFlexColumnRenderer"), "text"))
}

/* ---------------- row parsers (mobile parseResponsiveListItem) ---------------- */

/// One track row. `fallback` is what the page it came from is billed to.
pub fn parse_responsive_list_item(renderer: Option<&Value>, fallback: &Credits) -> Option<Track> {
    let renderer = renderer.filter(|r| r.is_object())?;
    let r = Some(renderer);
    let play_overlay = o(
        o(o(o(r, "overlay"), "musicItemThumbnailOverlayRenderer"), "content"),
        "musicPlayButtonRenderer",
    );
    let video_id = s(o(r, "playlistItemData"), "videoId")
        .or_else(|| s(o(o(play_overlay, "playNavigationEndpoint"), "watchEndpoint"), "videoId"))?;

    let empty = Vec::new();
    let columns = a(r, "flexColumns").unwrap_or(&empty);
    let title = flex_text(columns, 0);
    if title.trim().is_empty() {
        return None;
    }
    let subtitle = flex_text(columns, 1);
    let parts = split_bullets(&subtitle);
    let last = parts.last().cloned().unwrap_or_default();
    let mut duration = if DURATION.is_match(&last) { last } else { String::new() };
    if duration.is_empty() {
        for column in a(r, "fixedColumns").unwrap_or(&empty) {
            let t = text(o(o(Some(column), "musicResponsiveListItemFixedColumnRenderer"), "text"));
            let t = t.trim();
            if DURATION.is_match(t) {
                duration = t.to_string();
                break;
            }
        }
    }
    let row_type = parts.iter().find(|p| is_type_word(p)).map(|p| p.to_lowercase());
    let artist = parts
        .iter()
        .find(|p| !DURATION.is_match(p) && !is_type_word(p) && !TALLY.is_match(p))
        .cloned()
        .unwrap_or_default();

    let runs: Vec<&Value> = columns
        .iter()
        .flat_map(|column| {
            let flex = o(Some(column), "musicResponsiveListItemFlexColumnRenderer");
            a(o(flex, "text"), "runs").or_else(|| a(flex, "runs")).map(|v| v.iter().collect::<Vec<_>>()).unwrap_or_default()
        })
        .collect();
    let credits = credits_of(runs);
    let thumbnails = row_thumbnails(r);

    let artist = if !artist.is_empty() {
        artist
    } else {
        credits
            .artist_name
            .clone()
            .or_else(|| fallback.artist_name.clone())
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| "Unknown artist".into())
    };
    Some(Track {
        id: video_id,
        title,
        artist,
        artist_id: credits.artist_id.or_else(|| fallback.artist_id.clone()),
        album_id: credits.album_id.or_else(|| fallback.album_id.clone()),
        album: credits.album_name.or_else(|| fallback.album_name.clone()),
        duration: parse_duration_text(&duration),
        thumb: best_thumb(thumbnails),
        explicit: if has_explicit_badge(renderer.get("subtitleBadges")) { Some(true) } else { None },
        is_video: Some(row_type.as_deref() == Some("video") || is_not_square(thumbnails)),
        ..Default::default()
    })
}

/// A row that opens a page rather than playing: album/artist/playlist/other.
pub fn parse_browse_item(renderer: Option<&Value>) -> Option<BrowseItem> {
    let endpoint = o(o(renderer, "navigationEndpoint"), "browseEndpoint");
    let browse_id = s(endpoint, "browseId")?;
    let page_type = page_type_of(endpoint);
    let empty = Vec::new();
    let columns = a(renderer, "flexColumns").unwrap_or(&empty);
    let mut title = flex_text(columns, 0);
    if title.is_empty() {
        title = text(o(renderer, "title"));
    }
    if title.trim().is_empty() {
        return None;
    }
    let mut subtitle = flex_text(columns, 1);
    if subtitle.is_empty() {
        subtitle = text(o(renderer, "subtitle"));
    }
    if VIDEO_WORD.is_match(&title) || VIDEO_WORD.is_match(&subtitle) {
        return None;
    }
    let thumbs = row_thumbnails(renderer).or_else(|| {
        o(o(o(renderer, "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail").and_then(|t| t.get("thumbnails"))
    });
    Some(BrowseItem { browse_id, title, subtitle, thumb: best_thumb(thumbs), kind: kind_of_page(&page_type).into() })
}

/* ---------------- search (mobile parseSearchPage) ---------------- */

fn parse_card_shelf_song(renderer: Option<&Value>) -> Option<Track> {
    let video_id = s(o(o(renderer, "onTap"), "watchEndpoint"), "videoId")?;
    let title = text(o(renderer, "title"));
    if title.trim().is_empty() {
        return None;
    }
    let empty = Vec::new();
    let subtitle_runs = a(o(renderer, "subtitle"), "runs").unwrap_or(&empty);
    let subtitle: String = subtitle_runs.iter().map(|r| s(Some(r), "text").unwrap_or_default()).collect();
    let parts = split_bullets(&subtitle);
    let last = parts.last().cloned().unwrap_or_default();
    let duration = if DURATION.is_match(&last) { last } else { String::new() };
    let row_type = parts.iter().find(|p| is_type_word(p)).map(|p| p.to_lowercase());
    let credits = credits_of(subtitle_runs.iter());
    let artist = parts.iter().find(|p| !DURATION.is_match(p) && !is_type_word(p) && !TALLY.is_match(p)).cloned().unwrap_or_default();
    let thumbnails = row_thumbnails(renderer);
    Some(Track {
        id: video_id,
        title,
        artist: credits
            .artist_name
            .clone()
            .filter(|a| !a.is_empty())
            .or(Some(artist).filter(|a| !a.is_empty()))
            .unwrap_or_else(|| "Unknown artist".into()),
        artist_id: credits.artist_id,
        album_id: credits.album_id,
        album: credits.album_name,
        duration: parse_duration_text(&duration),
        thumb: best_thumb(thumbnails),
        explicit: if has_explicit_badge(renderer.and_then(|r| r.get("subtitleBadges"))) { Some(true) } else { None },
        is_video: Some(row_type.as_deref() == Some("video") || is_not_square(thumbnails)),
        ..Default::default()
    })
}

fn parse_card_shelf_browse(renderer: Option<&Value>) -> Option<BrowseItem> {
    let endpoint = o(o(renderer, "onTap"), "browseEndpoint");
    let browse_id = s(endpoint, "browseId")?;
    let page_type = page_type_of(endpoint);
    let title = text(o(renderer, "title"));
    if title.trim().is_empty() {
        return None;
    }
    let subtitle = text(o(renderer, "subtitle"));
    if VIDEO_WORD.is_match(&title) || VIDEO_WORD.is_match(&subtitle) {
        return None;
    }
    Some(BrowseItem { browse_id, title, subtitle, thumb: best_thumb(row_thumbnails(renderer)), kind: kind_of_page(&page_type).into() })
}

/// Token for the next page, or None — both continuation shapes YouTube ships.
pub fn continuation_token(root: Option<&Value>) -> Option<String> {
    let item = collect_renderers(root, "continuationItemRenderer").into_iter().next();
    if let Some(token) = s(o(o(item, "continuationEndpoint"), "continuationCommand"), "token") {
        return Some(token);
    }
    let legacy = collect_renderers(root, "nextContinuationData").into_iter().next();
    s(legacy, "continuation")
}

pub fn parse_search_page(response: &Value, include_videos: bool) -> (Vec<SearchRow>, Option<String>) {
    let root = Some(response);
    let mut billed_to: HashMap<usize, Credits> = HashMap::new();
    let mut top_results: Vec<SearchRow> = Vec::new();
    if !include_videos {
        for card in collect_renderers(root, "musicCardShelfRenderer") {
            if let Some(song) = parse_card_shelf_song(Some(card)) {
                if !song.is_video() {
                    top_results.push(SearchRow::Top(song));
                }
                continue;
            }
            let browse = parse_card_shelf_browse(Some(card));
            if let Some(b) = &browse {
                if b.kind == "artist" {
                    for row in a(Some(card), "contents").into_iter().flatten() {
                        if let Some(item) = o(Some(row), "musicResponsiveListItemRenderer") {
                            billed_to.insert(
                                ptr(item),
                                Credits { artist_id: Some(b.browse_id.clone()), artist_name: Some(b.title.clone()), ..Default::default() },
                            );
                        }
                    }
                }
            }
            if let Some(item) = browse {
                top_results.push(SearchRow::Browse { item, top: true });
            }
        }
    }
    let rows = collect_renderers(root, "musicResponsiveListItemRenderer");
    let mut seen = HashSet::new();
    let mut parsed = Vec::new();
    for result in top_results {
        match &result {
            SearchRow::Top(song) => {
                if seen.insert(format!("v:{}", song.id)) {
                    parsed.push(result);
                }
            }
            SearchRow::Browse { item, .. } => {
                if seen.insert(format!("b:{}", item.browse_id)) {
                    parsed.push(result);
                }
            }
            _ => {}
        }
    }
    let none = Credits::default();
    for renderer in rows {
        if let Some(browse) = parse_browse_item(Some(renderer)) {
            if seen.insert(format!("b:{}", browse.browse_id)) {
                parsed.push(SearchRow::Browse { item: browse, top: false });
            }
        } else if let Some(song) = parse_responsive_list_item(Some(renderer), billed_to.get(&ptr(renderer)).unwrap_or(&none)) {
            if song.is_video() == include_videos && seen.insert(format!("v:{}", song.id)) {
                parsed.push(SearchRow::Track(song));
            }
        }
    }
    (parsed, continuation_token(root))
}

/* ---------------- type-ahead (search suggestions) ---------------- */

const SUGGEST_TEXT_MAX: usize = 3;
const SUGGEST_RICH_MAX: usize = 12;

pub fn fold_text(t: &str) -> String {
    t.nfc().collect::<String>().trim().to_lowercase()
}

fn browse_suggestion(item: &BrowseItem) -> Option<Value> {
    if item.kind == "other" {
        return None;
    }
    Some(json!({ "kind": item.kind, "text": item.title, "subtitle": item.subtitle, "thumb": item.thumb, "id": item.browse_id, "browse": item }))
}

fn play_suggestion(track: &Track, kind: &str, subtitle: &str) -> Value {
    json!({ "kind": kind, "text": track.title, "subtitle": subtitle, "thumb": track.thumb, "id": track.id, "track": track })
}

fn suggestion_row(renderer: &Value) -> Option<Value> {
    if let Some(browse) = parse_browse_item(Some(renderer)) {
        let first = browse.subtitle.split(" • ").next().unwrap_or("").trim().to_lowercase();
        let bare = browse.kind == "artist" && !TYPE_WORDS.contains(&first.as_str());
        if bare {
            let subtitle = ["Artist", browse.subtitle.as_str()].iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join(" • ");
            return browse_suggestion(&BrowseItem { subtitle, ..browse });
        }
        return browse_suggestion(&browse);
    }
    let song = parse_responsive_list_item(Some(renderer), &Credits::default())?;
    let empty = Vec::new();
    let subtitle = flex_text(a(Some(renderer), "flexColumns").unwrap_or(&empty), 1);
    if radio_video_type(Some(renderer), row_thumbnails(Some(renderer))) == "episode" {
        let ep = Track { episode: Some(true), ..song };
        return Some(play_suggestion(&ep, "episode", &subtitle));
    }
    let kind = if song.is_video() { "video" } else { "song" };
    Some(play_suggestion(&song, kind, &subtitle))
}

fn twin_key(s: &Value) -> String {
    match s.get("track") {
        Some(t) if t.is_object() => format!(
            "{}|{}",
            fold_text(t.get("title").and_then(|v| v.as_str()).unwrap_or("")),
            fold_text(t.get("artist").and_then(|v| v.as_str()).unwrap_or(""))
        ),
        _ => String::new(),
    }
}

fn add_rich(items: Vec<Value>, rows: Vec<Option<Value>>) -> Vec<Value> {
    let mut out = items;
    let mut seen: HashSet<String> = HashSet::new();
    for item in &out {
        seen.insert(item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string());
        seen.insert(twin_key(item));
    }
    let mut rich = out.iter().filter(|s| s.get("kind").is_some()).count();
    for row in rows.into_iter().flatten() {
        if rich >= SUGGEST_RICH_MAX {
            break;
        }
        let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let twin = twin_key(&row);
        if id.is_empty() || seen.contains(&id) || (!twin.is_empty() && seen.contains(&twin)) {
            continue;
        }
        seen.insert(id);
        seen.insert(twin);
        out.push(row);
        rich += 1;
    }
    out
}

pub fn parse_search_suggestions(response: &Value, query: &str) -> Vec<Value> {
    let mut seen = HashSet::new();
    seen.insert(fold_text(query));
    let mut texts = Vec::new();
    for r in collect_renderers(Some(response), "searchSuggestionRenderer") {
        if texts.len() >= SUGGEST_TEXT_MAX {
            break;
        }
        let t = text(o(Some(r), "suggestion")).trim().to_string();
        if !t.is_empty() && seen.insert(fold_text(&t)) {
            texts.push(json!({ "text": t }));
        }
    }
    let rows = collect_renderers(Some(response), "musicResponsiveListItemRenderer").into_iter().map(suggestion_row).collect();
    add_rich(texts, rows)
}

/* ---------------- browse pages (mobile pageOf) ---------------- */

fn first_header(root: Option<&Value>) -> Option<&Value> {
    HEADER_RENDERERS.iter().find_map(|name| collect_renderers(root, name).into_iter().next())
}

#[derive(Clone, Debug, Default)]
pub struct BrowseHeader {
    pub title: String,
    pub subtitle: String,
    pub thumb: String,
    pub artist_id: Option<String>,
}

pub fn parse_browse_header(root: Option<&Value>) -> Option<BrowseHeader> {
    let header = first_header(root)?;
    let h = Some(header);
    let title = text(o(h, "title"));
    if title.trim().is_empty() {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    for key in HEADER_CREDIT_LINES {
        let t = text(o(h, key));
        if !t.trim().is_empty() && !lines.contains(&t) {
            lines.push(t);
        }
    }
    let subtitle = lines.join(" • ");
    let mut artist_id = None;
    'outer: for key in HEADER_CREDIT_LINES {
        for run in a(o(h, key), "runs").into_iter().flatten() {
            let browse = o(o(Some(run), "navigationEndpoint"), "browseEndpoint");
            if let Some(id) = s(browse, "browseId") {
                if page_type_of(browse).contains("ARTIST") {
                    artist_id = Some(id);
                    break 'outer;
                }
            }
        }
    }
    let thumb_renderer = collect_renderers(h, "musicThumbnailRenderer").into_iter().next();
    Some(BrowseHeader {
        title,
        subtitle,
        thumb: best_thumb(o(thumb_renderer, "thumbnail").and_then(|t| t.get("thumbnails"))),
        artist_id,
    })
}

/// Who a release page is billed to, off its own header.
pub fn page_credit(root: Option<&Value>) -> Credits {
    let Some(header) = first_header(root) else { return Credits::default() };
    let h = Some(header);
    let empty = Vec::new();
    let lines: Vec<&Vec<Value>> = HEADER_CREDIT_LINES.iter().map(|key| a(o(h, key), "runs").unwrap_or(&empty)).collect();
    let parts: Vec<String> = lines
        .iter()
        .flat_map(|line| {
            let joined: String = line.iter().map(|r| s(Some(r), "text").unwrap_or_default()).collect();
            joined.split(" • ").map(|p| p.trim().to_string()).collect::<Vec<_>>()
        })
        .collect();
    if !parts.iter().any(|p| RELEASE_WORDS.contains(&p.to_lowercase().as_str())) {
        return Credits::default();
    }
    let mut credits = credits_of(lines.iter().flat_map(|l| l.iter()));
    if credits.artist_name.is_some() {
        return credits;
    }
    credits.artist_name = parts
        .iter()
        .find(|p| !p.is_empty() && !is_type_word(p) && !TALLY.is_match(p) && !YEAR.is_match(p) && !DURATION.is_match(p))
        .cloned();
    credits
}

/// Layout-agnostic walk for every row that carries a videoId.
pub fn collect_songs_deep(root: Option<&Value>) -> Vec<Track> {
    let credit = page_credit(root);
    let mut out: Vec<Track> = Vec::new();
    let mut seen = HashSet::new();
    fn visit(node: &Value, credit: &Credits, out: &mut Vec<Track>, seen: &mut HashSet<String>) {
        match node {
            Value::Array(items) => items.iter().for_each(|i| visit(i, credit, out, seen)),
            Value::Object(map) => {
                if let Some(r) = map.get("musicResponsiveListItemRenderer") {
                    if let Some(song) = parse_responsive_list_item(Some(r), credit) {
                        if seen.insert(song.id.clone()) {
                            out.push(song);
                        }
                    }
                }
                for value in map.values() {
                    if value.is_object() || value.is_array() {
                        visit(value, credit, out, seen);
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(root) = root {
        visit(root, &credit, &mut out, &mut seen);
    }
    out
}

/// A playlist page's own tracks, scoped to the playlist shelf (not "Suggestions").
pub fn parse_playlist_shelf(root: Option<&Value>) -> Option<(Vec<Track>, Option<String>)> {
    let scope = o(root, "continuationContents")
        .or_else(|| o(o(o(root, "contents"), "twoColumnBrowseResultsRenderer"), "secondaryContents"))?;
    let playlist_scope = o(Some(scope), "musicPlaylistShelfContinuation")
        .or_else(|| collect_renderers(Some(scope), "musicPlaylistShelfRenderer").into_iter().next())?;
    let credit = page_credit(root);
    let mut seen = HashSet::new();
    let songs = collect_renderers(Some(playlist_scope), "musicResponsiveListItemRenderer")
        .into_iter()
        .filter_map(|r| parse_responsive_list_item(Some(r), &credit))
        .filter(|t| seen.insert(t.id.clone()))
        .collect();
    Some((songs, continuation_token(Some(playlist_scope))))
}

/// A later page of a playlist/album shelf (both continuation shapes).
pub fn parse_playlist_continuation(response: &Value, credit: &Credits) -> (Vec<Track>, Option<String>) {
    let scope = o(o(Some(response), "continuationContents"), "musicPlaylistShelfContinuation").unwrap_or(response);
    let songs = collect_renderers(Some(scope), "musicResponsiveListItemRenderer")
        .into_iter()
        .filter_map(|r| parse_responsive_list_item(Some(r), credit))
        .collect();
    (songs, continuation_token(Some(scope)))
}

/// The editorial blurb — "About the artist" / "About the album".
pub fn parse_description(root: Option<&Value>) -> Option<String> {
    let shelf = text(o(collect_renderers(root, "musicDescriptionShelfRenderer").into_iter().next(), "description"));
    if !shelf.trim().is_empty() {
        return Some(shelf);
    }
    for name in HEADER_RENDERERS.iter().chain(["musicImmersiveHeaderRenderer"].iter()) {
        let on_header = text(o(collect_renderers(root, name).into_iter().next(), "description"));
        if !on_header.trim().is_empty() {
            return Some(on_header);
        }
    }
    None
}

pub struct ReleasePage {
    pub header: Option<BrowseHeader>,
    pub tracks: Vec<Track>,
    pub continuation: Option<String>,
    pub description: Option<String>,
}

pub fn parse_release_page(response: &Value, browse_id: &str) -> ReleasePage {
    let root = Some(response);
    let header = parse_browse_header(root);
    let shelf = parse_playlist_shelf(root);
    let playlist = shelf.is_some() || browse_id.starts_with("VL") || browse_id.starts_with("PL");
    let header_thumb = header.as_ref().map(|h| h.thumb.clone()).unwrap_or_default();
    let (songs, continuation) = match shelf {
        Some((songs, c)) => (songs, c),
        None => (collect_songs_deep(root), continuation_token(root)),
    };
    let tracks = songs
        .into_iter()
        .map(|t| if t.thumb.is_empty() { Track { thumb: header_thumb.clone(), ..t } } else { t })
        .collect();
    ReleasePage { header, tracks, continuation, description: if playlist { None } else { parse_description(root) } }
}

/* ---------------- podcasts ---------------- */

pub struct Show {
    pub title: String,
    pub author: String,
    pub thumb: String,
}

pub fn parse_podcast_episodes(root: Option<&Value>, show: &Show) -> (Vec<Track>, Option<String>) {
    let mut episodes = Vec::new();
    for r in collect_renderers(root, "musicMultiRowListItemRenderer") {
        let r = Some(r);
        let Some(video_id) = s(o(o(r, "onTap"), "watchEndpoint"), "videoId") else { continue };
        let title = text(o(r, "title"));
        if title.trim().is_empty() {
            continue;
        }
        let subtitle = text(o(r, "subtitle"));
        let description = text(o(r, "description"));
        let thumb = best_thumb(row_thumbnails(r));
        episodes.push(Track {
            id: video_id,
            title,
            artist: if show.author.is_empty() { show.title.clone() } else { show.author.clone() },
            album: Some(show.title.clone()),
            thumb: if thumb.is_empty() { show.thumb.clone() } else { thumb },
            duration: 0.0,
            episode: Some(true),
            published: if subtitle.is_empty() { None } else { subtitle.split(" • ").last().map(|p| p.trim().to_string()) },
            description: if description.is_empty() { None } else { Some(description.chars().take(500).collect()) },
            ..Default::default()
        });
    }
    (episodes, continuation_token(root))
}

pub fn parse_podcast_page(response: &Value, id: &str) -> (Value, Option<String>, Show) {
    let header = parse_browse_header(Some(response));
    let show = Show {
        title: header.as_ref().map(|h| h.title.clone()).unwrap_or_else(|| "Podcast".into()),
        author: header.as_ref().map(|h| h.subtitle.clone()).unwrap_or_default(),
        thumb: header.as_ref().map(|h| h.thumb.clone()).unwrap_or_default(),
    };
    let (episodes, continuation) = parse_podcast_episodes(Some(response), &show);
    let page = json!({
        "id": id, "title": show.title, "author": show.author, "thumb": show.thumb,
        "description": parse_description(Some(response)), "episodes": episodes,
    });
    (page, continuation, show)
}

static SPOKEN_LENGTH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(?:(\d+) hr)? ?(?:(\d+) min)? ?(?:(\d+) sec)?$").unwrap());

pub fn parse_podcast_shelves(res: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for carousel in collect_renderers(Some(res), "musicCarouselShelfRenderer") {
        let c = Some(carousel);
        let title = text(o(o(o(c, "header"), "musicCarouselShelfBasicHeaderRenderer"), "title")).trim().to_string();
        let mut shows = Vec::new();
        let mut episodes: Vec<Track> = Vec::new();
        for item in a(c, "contents").into_iter().flatten() {
            let card = o(Some(item), "musicTwoRowItemRenderer");
            let id = s(o(o(card, "navigationEndpoint"), "browseEndpoint"), "browseId");
            let card_title = text(o(card, "title"));
            if let Some(id) = id.filter(|i| i.starts_with("MPSP")) {
                if !card_title.trim().is_empty() {
                    let thumbs = o(o(o(card, "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail").and_then(|t| t.get("thumbnails"));
                    shows.push(json!({ "id": id, "title": card_title, "author": text(o(card, "subtitle")), "thumb": best_thumb(thumbs) }));
                }
            }
            let Some(row) = o(Some(item), "musicMultiRowListItemRenderer") else { continue };
            let show_title = {
                let t = text(o(Some(row), "secondTitle"));
                if t.is_empty() { "Podcast".to_string() } else { t }
            };
            let (eps, _) = parse_podcast_episodes(Some(item), &Show { title: show_title, author: String::new(), thumb: String::new() });
            let printed = text(o(o(o(Some(row), "playbackProgress"), "musicPlaybackProgressRenderer"), "durationText"));
            let printed = printed.split('•').last().unwrap_or("").trim().to_string();
            let mut secs = 0.0;
            if let Some(m) = SPOKEN_LENGTH.captures(&printed) {
                let n = |i: usize| m.get(i).and_then(|x| x.as_str().parse::<f64>().ok()).unwrap_or(0.0);
                secs = n(1) * 3600.0 + n(2) * 60.0 + n(3);
            }
            if let Some(ep) = eps.into_iter().next() {
                episodes.push(Track { duration: secs, ..ep });
            }
        }
        if !title.is_empty() && (!shows.is_empty() || !episodes.is_empty()) {
            out.push(json!({ "title": title, "shows": shows, "episodes": episodes }));
        }
    }
    out
}

/* ---------------- artist page ---------------- */

fn artist_header_piece(header: Option<&Value>) -> Option<&Value> {
    o(header, "musicImmersiveHeaderRenderer").or_else(|| o(header, "musicVisualHeaderRenderer"))
}

fn artist_thumbnail(header: Option<&Value>) -> String {
    if header.is_none() {
        return String::new();
    }
    let immersive = o(header, "musicImmersiveHeaderRenderer");
    let visual = o(header, "musicVisualHeaderRenderer");
    let renderer = o(o(immersive, "thumbnail"), "musicThumbnailRenderer")
        .or_else(|| o(o(visual, "foregroundThumbnail"), "musicThumbnailRenderer"))
        .or_else(|| o(o(visual, "thumbnail"), "musicThumbnailRenderer"))
        .or_else(|| collect_renderers(header, "musicThumbnailRenderer").into_iter().next());
    best_thumb(o(renderer, "thumbnail").and_then(|t| t.get("thumbnails")))
}

fn artist_name_of(header: Option<&Value>) -> Option<String> {
    let name = text(o(artist_header_piece(header), "title"));
    if name.trim().is_empty() { None } else { Some(name) }
}

fn monthly_listeners(header: Option<&Value>) -> Option<String> {
    first_run_text(o(o(header, "musicImmersiveHeaderRenderer"), "monthlyListenerCount"))
}

fn subscriber_count(header: Option<&Value>) -> Option<String> {
    let immersive = o(header, "musicImmersiveHeaderRenderer")?;
    let im = Some(immersive);
    let button2 = o(o(im, "subscriptionButton2"), "subscribeButtonRenderer");
    let button1 = o(o(im, "subscriptionButton"), "subscribeButtonRenderer");
    [
        text(o(button2, "subscriberCountWithSubscribeText")),
        text(o(button1, "longSubscriberCountText")),
        text(o(button1, "shortSubscriberCountText")),
    ]
    .into_iter()
    .map(|t| t.trim().to_string())
    .find(|t| !t.is_empty())
}

/// Home/carousel cards — mobile parseTwoRowItem. Returns (HomeItem JSON, browseId).
pub fn parse_two_row_item(renderer: Option<&Value>) -> Option<(Value, Option<String>)> {
    let renderer = renderer?;
    let r = Some(renderer);
    let title = text(o(r, "title"));
    if title.trim().is_empty() {
        return None;
    }
    let endpoint = o(r, "navigationEndpoint");
    let raw_browse_id = s(o(endpoint, "browseEndpoint"), "browseId");
    let video_id = s(o(endpoint, "watchEndpoint"), "videoId").or_else(|| {
        raw_browse_id.as_ref().filter(|b| b.starts_with("MPED")).map(|b| b["MPED".len()..].to_string())
    });
    let browse_id = raw_browse_id.filter(|b| !b.starts_with("MPED"));
    let thumbnails = o(o(o(r, "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail").and_then(|t| t.get("thumbnails"));
    let subtitle = text(o(r, "subtitle"));
    if browse_id.is_none() && video_id.is_some() && is_not_square(thumbnails) {
        return None;
    }
    if browse_id.is_some() && (VIDEO_WORD.is_match(&title) || VIDEO_WORD.is_match(&subtitle)) {
        return None;
    }
    let thumb = best_thumb(thumbnails);
    let item = match (&browse_id, &video_id) {
        (Some(b), _) if b.starts_with("UC") => {
            json!({ "kind": "artist", "artist": { "id": b, "name": title, "thumb": thumb, "subtitle": subtitle } })
        }
        (Some(b), _) if b.starts_with("MPREb") => {
            json!({ "kind": "album", "album": { "id": b, "title": title, "artist": subtitle, "thumb": thumb } })
        }
        (Some(b), _) => json!({ "kind": "playlist", "playlist": { "id": b, "title": title, "thumb": thumb, "subtitle": subtitle } }),
        (None, Some(v)) => {
            let artist = if subtitle.is_empty() { "Unknown artist".to_string() } else { subtitle.clone() };
            json!({ "kind": "track", "track": Track { id: v.clone(), title, artist, duration: 0.0, thumb, ..Default::default() } })
        }
        _ => return None,
    };
    Some((item, browse_id))
}

fn first_tab_sections(res: Option<&Value>) -> Vec<&Value> {
    let tabs = a(o(o(res, "contents"), "singleColumnBrowseResultsRenderer"), "tabs");
    a(o(o(o(tabs.and_then(|t| t.first()), "tabRenderer"), "content"), "sectionListRenderer"), "contents")
        .map(|v| v.iter().collect())
        .unwrap_or_default()
}

/// A moods & genres category page: its title and every shelf, in order.
pub fn parse_mood_page(res: &Value) -> Value {
    let r = Some(res);
    let title = text(o(o(o(r, "header"), "musicHeaderRenderer"), "title")).trim().to_string();
    let mut shelves = Vec::new();
    for section in first_tab_sections(r) {
        let sec = Some(section);
        let carousel = o(sec, "musicCarouselShelfRenderer");
        let grid = o(sec, "gridRenderer");
        let list = o(sec, "musicShelfRenderer");
        let heading = if carousel.is_some() {
            text(o(o(o(carousel, "header"), "musicCarouselShelfBasicHeaderRenderer"), "title"))
        } else if grid.is_some() {
            text(o(o(o(grid, "header"), "gridHeaderRenderer"), "title"))
        } else {
            text(o(list, "title"))
        };
        let heading = heading.trim().to_string();
        let mut items = Vec::new();
        for row in a(list, "contents").into_iter().flatten() {
            if let Some(song) = parse_responsive_list_item(o(Some(row), "musicResponsiveListItemRenderer"), &Credits::default()) {
                items.push(json!({ "kind": "track", "track": song }));
            }
        }
        let cards = if carousel.is_some() { a(carousel, "contents") } else { a(grid, "items") };
        for card in cards.into_iter().flatten() {
            if let Some((item, _)) = parse_two_row_item(o(Some(card), "musicTwoRowItemRenderer")) {
                items.push(item);
            }
        }
        if !heading.is_empty() && !items.is_empty() {
            shelves.push(json!({ "title": heading, "items": items }));
        }
    }
    json!({ "title": title, "shelves": shelves })
}

pub struct ArtistPage {
    pub name: Option<String>,
    pub thumb: String,
    pub description: Option<String>,
    pub subscriber_count: Option<String>,
    pub monthly_listeners: Option<String>,
    pub songs: Vec<Track>,
    pub shelves: Vec<Value>,
}

pub fn parse_artist_page(response: &Value) -> ArtistPage {
    let r = Some(response);
    let header = response.get("header").filter(|h| h.is_object());
    let credit = Credits { artist_name: artist_name_of(header), ..Default::default() };
    let mut songs: Vec<Track> = Vec::new();
    let mut shelves = Vec::new();
    for section in first_tab_sections(r) {
        let sec = Some(section);
        if let Some(shelf) = o(sec, "musicShelfRenderer") {
            for row in a(Some(shelf), "contents").into_iter().flatten() {
                if let Some(song) = parse_responsive_list_item(o(Some(row), "musicResponsiveListItemRenderer"), &credit) {
                    if !songs.iter().any(|x| x.id == song.id) {
                        songs.push(song);
                    }
                }
            }
        }
        if let Some(carousel) = o(sec, "musicCarouselShelfRenderer") {
            let title = text(o(o(o(Some(carousel), "header"), "musicCarouselShelfBasicHeaderRenderer"), "title"));
            if VIDEO_WORD.is_match(&title) {
                continue;
            }
            let mut items = Vec::new();
            for card in a(Some(carousel), "contents").into_iter().flatten() {
                if let Some((item, Some(_))) = parse_two_row_item(o(Some(card), "musicTwoRowItemRenderer")) {
                    items.push(item);
                }
            }
            if !title.trim().is_empty() && !items.is_empty() {
                shelves.push(json!({ "title": title, "items": items }));
            }
        }
    }
    ArtistPage {
        name: artist_name_of(header),
        thumb: artist_thumbnail(header),
        description: parse_description(r),
        subscriber_count: subscriber_count(header),
        monthly_listeners: monthly_listeners(header),
        songs,
        shelves,
    }
}

/* ---------------- remote playlist header ---------------- */

fn facepile_name(header: Option<&Value>) -> Option<String> {
    let name = o(o(header, "facepile"), "avatarStackViewModel")
        .and_then(|v| v.get("text"))
        .and_then(|t| t.get("content"))
        .and_then(|c| c.as_str())?;
    let name = name.trim();
    if name.is_empty() { None } else { Some(name.to_string()) }
}

pub fn parse_remote_playlist_page(response: &Value, more_tracks: Vec<Track>) -> Value {
    let root = Some(response);
    let header = first_header(root);
    let shelf = parse_playlist_shelf(root);
    let page_thumb = best_thumb(
        o(collect_renderers(header, "musicThumbnailRenderer").into_iter().next(), "thumbnail").and_then(|t| t.get("thumbnails")),
    );
    let mut seen = HashSet::new();
    let base = match shelf {
        Some((songs, _)) => songs,
        None => collect_songs_deep(root),
    };
    let tracks: Vec<Track> = base
        .into_iter()
        .chain(more_tracks)
        .filter(|t| seen.insert(t.id.clone()))
        .map(|t| if t.thumb.is_empty() { Track { thumb: page_thumb.clone(), ..t } } else { t })
        .collect();
    let parts: Vec<String> = HEADER_CREDIT_LINES
        .iter()
        .flat_map(|key| text(o(header, key)).split('•').map(|p| p.trim().to_string()).collect::<Vec<_>>())
        .filter(|p| !p.is_empty())
        .collect();
    let year = parts.iter().rev().find(|p| YEAR.is_match(p)).cloned();
    let kind = parts.iter().find(|p| p.to_lowercase() == "playlist").cloned().unwrap_or_else(|| "Playlist".into());
    let mut credit = parts
        .iter()
        .filter(|p| Some(*p) != year.as_ref() && p.to_lowercase() != "playlist")
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if let Some(curator) = facepile_name(header) {
        if !credit.to_lowercase().contains(&curator.to_lowercase()) {
            credit = if credit.is_empty() { curator } else { format!("{curator}, {credit}") };
        }
    }
    let views = text(o(header, "secondSubtitle")).split('•').map(|p| p.trim().to_string()).find(|p| p.to_lowercase().contains("view"));
    if let Some(views) = views {
        if !credit.to_lowercase().contains(&views.to_lowercase()) {
            credit = if credit.is_empty() { views } else { format!("{credit}, {views}") };
        }
    }
    let count = if tracks.is_empty() {
        String::new()
    } else {
        format!("{} {}", tracks.len(), if tracks.len() == 1 { "track" } else { "tracks" })
    };
    let meta = [Some(kind), year, Some(count)].into_iter().flatten().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" • ").to_uppercase();
    let title = {
        let t = text(o(header, "title"));
        if t.is_empty() { "Playlist".to_string() } else { t }
    };
    json!({ "title": title, "credit": credit, "meta": meta, "thumb": page_thumb, "tracks": tracks })
}

/* ---------------- track credits off the watch queue ---------------- */

pub struct QueueCredits {
    pub artist: String,
    pub album: Option<String>,
    pub duration_sec: f64,
}

fn clock_seconds(v: &str) -> f64 {
    let parts: Vec<Option<f64>> = v.trim().split(':').map(|p| p.trim().parse::<f64>().ok()).collect();
    if parts.len() >= 2 && parts.iter().all(|p| p.is_some()) {
        parts.into_iter().fold(0.0, |acc, p| acc * 60.0 + p.unwrap())
    } else {
        0.0
    }
}

pub fn parse_queue_credits(response: &Value, video_id: &str) -> Option<QueueCredits> {
    let row = collect_renderers(Some(response), "playlistPanelVideoRenderer")
        .into_iter()
        .find(|r| s(Some(r), "videoId").as_deref() == Some(video_id))?;
    let empty = Vec::new();
    let byline_runs = a(o(Some(row), "longBylineText"), "runs").unwrap_or(&empty);
    let byline: Vec<String> = byline_runs.iter().map(|r| s(Some(r), "text").unwrap_or_default()).collect();
    let first_bullet = byline.iter().position(|t| t.contains('•'));
    let artist = match first_bullet {
        None => byline.join(""),
        Some(i) => byline[..i].join(""),
    }
    .trim()
    .to_string();
    let credits = credits_of(byline_runs.iter());
    let album = credits.album_name.or_else(|| {
        first_bullet.and_then(|i| {
            byline[i + 1..]
                .join("")
                .split('•')
                .map(|p| p.trim().to_string())
                .find(|p| !p.is_empty() && !YEAR.is_match(p) && !TALLY.is_match(p))
        })
    });
    Some(QueueCredits {
        artist,
        album: album.filter(|a| !a.is_empty()),
        duration_sec: clock_seconds(&text(o(Some(row), "lengthText"))),
    })
}

/* ---------------- song radio (endless AutoPlay) ---------------- */

fn byline_artist(runs: &[Value]) -> String {
    let byline: Vec<String> = runs.iter().map(|r| s(Some(r), "text").unwrap_or_default()).collect();
    match byline.iter().position(|t| t.contains('•')) {
        None => byline.join(""),
        Some(i) => byline[..i].join(""),
    }
    .trim()
    .to_string()
}

fn radio_video_type(row: Option<&Value>, thumbnails: Option<&Value>) -> &'static str {
    let t = s(
        o(o(o(o(row, "navigationEndpoint"), "watchEndpoint"), "watchEndpointMusicSupportedConfigs"), "watchEndpointMusicConfig"),
        "musicVideoType",
    );
    match t.as_deref() {
        Some("MUSIC_VIDEO_TYPE_ATV") => "song",
        Some("MUSIC_VIDEO_TYPE_UGC") => "upload",
        Some("MUSIC_VIDEO_TYPE_PODCAST_EPISODE") => "episode",
        Some(_) => "video",
        None => {
            if is_not_square(thumbnails) {
                "video"
            } else {
                "song"
            }
        }
    }
}

fn radio_row(row: Option<&Value>) -> Option<Track> {
    let video_id = s(row, "videoId").or_else(|| s(o(o(row, "navigationEndpoint"), "watchEndpoint"), "videoId"))?;
    let title = text(o(row, "title")).trim().to_string();
    if title.is_empty() {
        return None;
    }
    let empty = Vec::new();
    let runs = a(o(row, "longBylineText"), "runs").unwrap_or(&empty);
    let credits = credits_of(runs.iter());
    let thumbnails = o(row, "thumbnail").and_then(|t| t.get("thumbnails"));
    let mut artist = byline_artist(runs);
    if artist.is_empty() {
        artist = credits.artist_name.clone().unwrap_or_else(|| "Unknown artist".into());
    }
    Some(Track {
        id: video_id,
        title,
        artist,
        artist_id: credits.artist_id,
        album: credits.album_name,
        album_id: credits.album_id,
        duration: clock_seconds(&text(o(row, "lengthText"))),
        thumb: best_thumb(thumbnails),
        explicit: if has_explicit_badge(row.and_then(|r| r.get("badges"))) { Some(true) } else { None },
        video_type: Some(radio_video_type(row, thumbnails).to_string()),
        ..Default::default()
    })
}

pub fn parse_radio_page(response: &Value, seed_id: &str) -> Value {
    let r = Some(response);
    let panel = o(o(r, "continuationContents"), "playlistPanelContinuation")
        .or_else(|| collect_renderers(r, "playlistPanelRenderer").into_iter().next());
    let mut tracks = Vec::new();
    let mut seed: Option<Value> = None;
    for item in a(panel, "contents").into_iter().flatten() {
        let mut row = o(Some(item), "playlistPanelVideoRenderer");
        if let Some(wrapper) = o(Some(item), "playlistPanelVideoWrapperRenderer") {
            let mut sides: Vec<&Value> = Vec::new();
            if let Some(p) = o(o(Some(wrapper), "primaryRenderer"), "playlistPanelVideoRenderer") {
                sides.push(p);
            }
            for c in a(Some(wrapper), "counterpart").into_iter().flatten() {
                if let Some(p) = o(o(Some(c), "counterpartRenderer"), "playlistPanelVideoRenderer") {
                    sides.push(p);
                }
            }
            row = sides
                .iter()
                .find(|side| radio_row(Some(side)).and_then(|t| t.video_type).as_deref() == Some("song"))
                .or(sides.first())
                .copied();
        }
        let Some(row_v) = row else { continue };
        if o(Some(row_v), "unplayableText").is_some() {
            continue;
        }
        let Some(track) = radio_row(Some(row_v)) else { continue };
        if row_v.get("selected") == Some(&Value::Bool(true)) || track.id == seed_id {
            if seed.is_none() {
                seed = Some(json!({ "artist": track.artist, "artistId": track.artist_id }));
            }
            continue;
        }
        tracks.push(track);
    }
    let continuation = a(panel, "continuations").and_then(|c| c.first());
    let next = s(o(continuation, "nextRadioContinuationData"), "continuation")
        .or_else(|| s(o(continuation, "nextContinuationData"), "continuation"));
    json!({ "tracks": tracks, "next": next, "seed": seed })
}

/* ---------------- charts / moods / home ---------------- */

/// YTM Charts page → home shelves (song rows, artist and album cards).
pub fn parse_charts_shelves(res: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let mut harvest = |title: &str, rows: Vec<&Value>| {
        let mut items = Vec::new();
        for renderer in rows {
            if let Some(card) = parse_browse_item(Some(renderer)) {
                if card.kind == "artist" {
                    items.push(json!({ "kind": "artist", "artist": { "id": card.browse_id, "name": card.title, "thumb": card.thumb, "subtitle": card.subtitle } }));
                } else if card.kind == "album" {
                    let artist = card.subtitle.split(" • ").nth(1).map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).unwrap_or_else(|| "Unknown artist".into());
                    items.push(json!({ "kind": "album", "album": { "id": card.browse_id, "title": card.title, "artist": artist, "thumb": card.thumb } }));
                }
                if items.len() >= 24 {
                    break;
                }
                continue;
            }
            if let Some(song) = parse_responsive_list_item(Some(renderer), &Credits::default()) {
                if !song.is_video() && !song.id.is_empty() && !song.title.is_empty() {
                    items.push(json!({ "kind": "track", "track": song }));
                }
            }
            if items.len() >= 24 {
                break;
            }
        }
        if items.len() >= 3 {
            let t = title.trim();
            out.push(json!({ "title": if t.is_empty() { "Charts" } else { t }, "items": items }));
        }
    };
    for shelf in collect_renderers(Some(res), "musicCarouselShelfRenderer") {
        let sh = Some(shelf);
        let mut title = text(o(o(o(sh, "header"), "musicCarouselShelfBasicHeaderRenderer"), "title"));
        if title.is_empty() {
            title = "Charts".into();
        }
        let rows = a(sh, "contents")
            .into_iter()
            .flatten()
            .filter_map(|node| node.get("musicResponsiveListItemRenderer").or_else(|| node.get("musicTwoRowItemRenderer")))
            .collect();
        harvest(&title, rows);
    }
    for shelf in collect_renderers(Some(res), "musicShelfRenderer") {
        let sh = Some(shelf);
        let mut title = text(o(sh, "title"));
        if title.is_empty() {
            title = text(o(o(o(sh, "header"), "musicHeaderRenderer"), "title"));
        }
        if title.is_empty() {
            title = "Charts".into();
        }
        let rows = a(sh, "contents").into_iter().flatten().filter_map(|node| node.get("musicResponsiveListItemRenderer")).collect();
        harvest(&title, rows);
    }
    out.truncate(4);
    out
}

pub fn parse_moods(res: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut section_of: HashMap<usize, String> = HashMap::new();
    for grid in collect_renderers(Some(res), "gridRenderer") {
        let heading = text(o(o(Some(grid), "header"), "gridHeaderRenderer").and_then(|h| h.get("title"))).trim().to_string();
        if heading.is_empty() {
            continue;
        }
        for item in a(Some(grid), "items").into_iter().flatten() {
            if let Some(b) = item.get("musicNavigationButtonRenderer") {
                section_of.insert(ptr(b), heading.clone());
            }
        }
    }
    for button in collect_renderers(Some(res), "musicNavigationButtonRenderer") {
        let b = Some(button);
        let title = text(b.and_then(|x| x.get("buttonText")));
        let endpoint = o(o(b, "clickCommand"), "browseEndpoint");
        let Some(browse_id) = s(endpoint, "browseId") else { continue };
        if title.trim().is_empty() || !seen.insert(title.clone()) {
            continue;
        }
        let color = button
            .get("solid")
            .and_then(|sv| sv.get("leftStripeColor"))
            .and_then(|c| c.as_f64())
            .filter(|c| c.is_finite() && *c >= 0.0)
            .map(|c| format!("#{:06x}", (c as u64) & 0xffffff));
        out.push(json!({
            "title": title.trim(), "browseId": browse_id, "params": s(endpoint, "params"),
            "color": color, "section": section_of.get(&ptr(button)),
        }));
    }
    out
}

pub fn parse_mood_covers(res: &Value, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in collect_renderers(Some(res), "musicTwoRowItemRenderer") {
        let thumbs = o(o(o(Some(item), "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail").and_then(|t| t.get("thumbnails"));
        let url = best_thumb(thumbs);
        if !url.is_empty() && !out.contains(&url) {
            out.push(url);
        }
        if out.len() >= max {
            break;
        }
    }
    out
}

/// One home-feed section (a carousel) → its title and up to 24 music items.
/// Mirrors music-service.ts getHome: songs (no videos), albums, artists, playlists.
pub fn parse_home_section(section: &Value) -> Option<Value> {
    let sec = Some(section);
    let carousel = o(sec, "musicCarouselShelfRenderer").or_else(|| o(sec, "musicShelfRenderer"))?;
    let c = Some(carousel);
    let mut title = text(o(o(o(c, "header"), "musicCarouselShelfBasicHeaderRenderer"), "title"));
    if title.is_empty() {
        title = text(o(c, "title"));
    }
    if title.is_empty() {
        title = "For you".into();
    }
    let mut items = Vec::new();
    for node in a(c, "contents").into_iter().flatten() {
        if let Some(two_row) = node.get("musicTwoRowItemRenderer") {
            if let Some((item, _)) = parse_two_row_item(Some(two_row)) {
                items.push(item);
            }
        } else if let Some(row) = node.get("musicResponsiveListItemRenderer") {
            if let Some(song) = parse_responsive_list_item(Some(row), &Credits::default()) {
                if !song.is_video() {
                    items.push(json!({ "kind": "track", "track": song }));
                }
            }
        }
        if items.len() >= 24 {
            break;
        }
    }
    if items.len() >= 3 {
        Some(json!({ "title": title, "items": items }))
    } else {
        None
    }
}

/// The browse-page sections of a home feed page (first page or a continuation),
/// plus the token for the next page.
pub fn home_sections(res: &Value) -> (Vec<&Value>, Option<String>) {
    let r = Some(res);
    let list = o(o(r, "continuationContents"), "sectionListContinuation").or_else(|| {
        let tabs = a(o(o(r, "contents"), "singleColumnBrowseResultsRenderer"), "tabs");
        o(o(o(tabs.and_then(|t| t.first()), "tabRenderer"), "content"), "sectionListRenderer")
    });
    let sections = a(list, "contents").map(|v| v.iter().collect()).unwrap_or_default();
    let next = a(list, "continuations")
        .and_then(|c| c.first())
        .and_then(|c| s(o(Some(c), "nextContinuationData"), "continuation"))
        .or_else(|| continuation_token(list));
    (sections, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_thumbs() {
        assert_eq!(
            upgrade_thumb("https://lh3.googleusercontent.com/abc=w60-h60-l90-rj", 544),
            "https://lh3.googleusercontent.com/abc=w544-h544-l90-rj"
        );
        assert_eq!(
            upgrade_thumb("https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg?sqp=xx", 544),
            "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
        );
        assert_eq!(upgrade_thumb("https://yt3.ggpht.com/x=s60-c-k", 544), "https://yt3.ggpht.com/x=s544-c-k");
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration_text("3:43"), 223.0);
        assert_eq!(parse_duration_text("1:02:33"), 3753.0);
        assert_eq!(parse_duration_text("Song"), 0.0);
        assert!(TALLY.is_match("12.4M plays"));
        assert!(!TALLY.is_match("21 Savage"));
    }
}
