//! Lyrics — a partial port of `electron/lyrics.ts` and the lyrics part of
//! `music-service.ts`.
//!
//! Sources, in priority order (all asked at once; the highest-ranked one with
//! timed lines wins, plain text is the fallback):
//!   1. BetterLyrics  — Apple Music TTML, word-synced
//!   2. YouTube captions for the playing video
//!   3. YouTube Music's own Lyrics tab (plain text)
//!   4. LRCLIB        — line-synced LRC
//! A local file's own timed lyrics tag is read first.
//! ByTune's other sources (lrc.red, BiniLyrics, Portato, PaxSenix, LyricsPlus,
//! Unison, KuGou, Musixmatch, Genius) are not ported yet.

use crate::music::{BoundedMap, Music};
use base64::Engine;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LYRICS_AGENT: &str = "ByTune (https://github.com/Sr1ya/bytune-rs)";
/// How long the sweep waits for higher-ranked sources before settling.
const SWEEP_CEILING: Duration = Duration::from_secs(9);

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Line {
    pub time: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<Word>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roman: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Found {
    pub source: String,
    pub word_synced: bool,
    pub lines: Vec<Line>,
    pub plain: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct LyricsMeta {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
}

#[derive(Clone)]
struct Query {
    id: String,
    title: String,
    artist: String,
    album: Option<String>,
    duration: f64,
}

pub struct Lyrics {
    cache: Mutex<BoundedMap<(Option<Value>, Instant)>>,
}

const PLACEHOLDER_ARTISTS: &[&str] = &["", "unknown artist", "unknown", "various artists", "artist"];

/* ---------------------------- shared parsing ---------------------------- */

fn decode_entities(s: &str) -> String {
    static HEX: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#x([0-9a-fA-F]+);").unwrap());
    static DEC: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#(\d+);").unwrap());
    let s = HEX.replace_all(s, |c: &regex::Captures| {
        u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    let s = DEC.replace_all(&s, |c: &regex::Captures| c[1].parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default());
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn stamp_ms(min: &str, sec: &str, frac: &str) -> f64 {
    let m: f64 = min.parse().unwrap_or(0.0);
    let s: f64 = sec.parse().unwrap_or(0.0);
    let f: f64 = if frac.len() == 2 { frac.parse::<f64>().unwrap_or(0.0) * 10.0 } else { frac.parse().unwrap_or(0.0) };
    (m * 60.0 + s) * 1000.0 + f
}

fn untopic(artist: &str) -> String {
    static TOPIC: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\s+-\s+Topic\s*$").unwrap());
    TOPIC.replace(artist, "").to_string()
}

fn search_artist(artist: &str) -> String {
    let credit = untopic(artist).trim().to_string();
    if PLACEHOLDER_ARTISTS.contains(&credit.to_lowercase().as_str()) { String::new() } else { credit }
}

/// The credit as a list ("A, B, C") and as YouTube's "A, B & C".
fn credit_forms(artist: &str) -> Vec<String> {
    let credit = search_artist(artist);
    let list = match credit.rfind(" & ") {
        Some(i) => format!("{}, {}", &credit[..i], &credit[i + 3..]),
        None => credit.clone(),
    };
    if list == credit { vec![credit] } else { vec![list, credit] }
}

fn within_tolerance(record_sec: Option<f64>, playing_sec: f64) -> bool {
    match record_sec {
        Some(r) if r > 0.0 && playing_sec > 0.0 => (r - playing_sec).abs() <= (12f64).max(playing_sec * 0.08),
        _ => true,
    }
}

/// Strip the noise YouTube titles carry: "(Official Video)", "[HD]", " - Lyrics" …
fn clean_title(title: &str) -> String {
    static A: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\((official\s+)?(music\s+)?(lyrics?\s+)?(video|audio|visualizer?|mv)\)").unwrap());
    static B: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\[(official\s+)?(music\s+)?(lyrics?\s+)?(video|audio|hd|4k)\]").unwrap());
    static C: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)\s*-\s*(?:official\s+)?(?:music\s+)?(?:lyrics?|lyrical|audio|video|visuali[sz]er|mv)\b.*$").unwrap()
    });
    static D: Lazy<Regex> = Lazy::new(|| Regex::new(r"\|.*$").unwrap());
    let t = A.replace_all(title, "");
    let t = B.replace_all(&t, "");
    let t = C.replace(&t, "");
    let t = D.replace(&t, "");
    t.trim().to_string()
}

/// Title for queries: brackets of any kind dropped.
fn query_title(title: &str) -> String {
    static BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\([^)]*\)|\[[^\]]*]").unwrap());
    let cleaned = clean_title(title);
    let base = BR.replace_all(&cleaned, "").split_whitespace().collect::<Vec<_>>().join(" ");
    if base.is_empty() { cleaned } else { base }
}

/// The title as a catalogue files it: credits and upload labels off, versions kept.
fn search_title(title: &str) -> String {
    static FEAT_BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]").unwrap());
    static FEAT_TAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\s(?:feat\.?|ft\.?|featuring)\s.*$").unwrap());
    let cleaned = clean_title(title);
    let t = FEAT_BR.replace_all(&cleaned, " ");
    let t = FEAT_TAIL.replace(&t, " ");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = t.trim_end_matches(|c: char| c.is_whitespace() || c == ',' || c == '-' || c == '–' || c == '—').to_string();
    if t.is_empty() { cleaned } else { t }
}

fn plain_words(s: &str) -> String {
    s.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn artist_names(artist: &str) -> Vec<String> {
    static SPLIT: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)\s*(?:,|;|/|&|\+|、|，|\s(?:and|x|×|with|feat\.?|ft\.?|featuring|vs\.?)\s)\s*").unwrap());
    let a = search_artist(artist);
    SPLIT.split(&a).map(plain_words).filter(|n| !n.is_empty()).collect()
}

/// Does a catalogue record (title, artist, length) name the playing recording? A simplified
/// form of ByTune's namesRecording: the title words must agree, a credited artist must be
/// shared when both sides name one, and the length must be within tolerance.
fn names_recording(rec_title: &str, rec_artist: &str, rec_len: Option<f64>, q: &Query) -> bool {
    let a = plain_words(&query_title(rec_title));
    let b = plain_words(&query_title(&q.title));
    if a.is_empty() || b.is_empty() || !(a == b || a.starts_with(&b) || b.starts_with(&a)) {
        return false;
    }
    let mine = artist_names(&q.artist);
    let theirs = artist_names(rec_artist);
    if !mine.is_empty() && !theirs.is_empty() && !mine.iter().any(|m| theirs.iter().any(|t| t == m || t.contains(m.as_str()) || m.contains(t.as_str()))) {
        return false;
    }
    within_tolerance(rec_len, q.duration)
}

fn line_end(line: &Line, next_start: f64) -> f64 {
    if let Some(e) = line.end {
        return e;
    }
    if let Some(w) = line.words.as_ref().and_then(|w| w.last()) {
        return w.end;
    }
    line.time + (next_start - line.time).clamp(2.0, 8.0)
}

/// Gap markers where ≥5 s of nobody sings.
fn with_instrumental_gaps(lines: Vec<Line>) -> Vec<Line> {
    let mut out = Vec::new();
    for i in 0..lines.len() {
        out.push(lines[i].clone());
        if let Some(next) = lines.get(i + 1) {
            let end = line_end(&lines[i], next.time);
            if next.time - end >= 5.0 {
                out.push(Line { time: end, text: String::new(), gap: Some(true), ..Default::default() });
            }
        }
    }
    out
}

fn to_result(source: &str, lines: Vec<Line>) -> Option<Found> {
    if lines.is_empty() {
        return None;
    }
    if !lines.iter().any(|l| l.time > 0.0 || l.words.as_ref().map(|w| !w.is_empty()).unwrap_or(false)) {
        let plain = lines.iter().map(|l| l.text.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
        return if plain.is_empty() { None } else { Some(Found { source: source.into(), word_synced: false, lines: vec![], plain: Some(plain) }) };
    }
    let word_synced = lines.iter().any(|l| l.words.as_ref().map(|w| !w.is_empty()).unwrap_or(false));
    Some(Found { source: source.into(), word_synced, lines: with_instrumental_gaps(lines), plain: None })
}

/* ------------------------------ LRC ------------------------------ */

static LRC_LINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[(\d{1,3}):(\d{2})[.:](\d{2,3})](.*)$").unwrap());
static LRC_WORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"<(\d{1,3}):(\d{2})[.:](\d{2,3})>([^<]*)").unwrap());
static LRC_WORD_STAMP: Lazy<Regex> = Lazy::new(|| Regex::new(r"<\d{1,3}:\d{2}[.:]\d{2,3}>").unwrap());

/// Plain LRC → line-synced lines (word stamps ignored).
pub fn parse_lrc(lrc: &str) -> Vec<Line> {
    let mut rows: Vec<Line> = lrc
        .lines()
        .filter_map(|raw| {
            let c = LRC_LINE.captures(raw.trim())?;
            let text = decode_entities(LRC_WORD_STAMP.replace_all(&c[4], "").trim());
            Some(Line { time: stamp_ms(&c[1], &c[2], &c[3]) / 1000.0, text, ..Default::default() })
        })
        .collect();
    rows.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap());
    rows
}

/// Word-timed rich LRC (`[mm:ss.xx]<mm:ss.xx>word …`); empty when the LRC has no word stamps.
pub fn parse_enhanced_lrc(lrc: &str) -> Vec<Line> {
    struct Row {
        time: f64,
        words: Vec<(f64, String)>,
        plain: String,
    }
    let mut rows: Vec<Row> = lrc
        .lines()
        .filter_map(|raw| {
            let c = LRC_LINE.captures(raw.trim())?;
            let rest = decode_entities(&c[4]);
            let words = LRC_WORD.captures_iter(&rest).map(|w| (stamp_ms(&w[1], &w[2], &w[3]) / 1000.0, w[4].trim().to_string())).collect();
            Some(Row { time: stamp_ms(&c[1], &c[2], &c[3]) / 1000.0, words, plain: LRC_WORD_STAMP.replace_all(&rest, "").trim().to_string() })
        })
        .collect();
    rows.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap());
    if !rows.iter().any(|r| !r.words.is_empty()) {
        return vec![];
    }
    let mut out = Vec::new();
    for i in 0..rows.len() {
        let row = &rows[i];
        if row.words.is_empty() {
            if !row.plain.is_empty() {
                out.push(Line { time: row.time, text: row.plain.clone(), ..Default::default() });
            }
            continue;
        }
        let line_end = rows.get(i + 1).map(|r| r.time).unwrap_or(row.words.last().unwrap().0 + 4.0);
        let words: Vec<Word> = row
            .words
            .iter()
            .enumerate()
            .filter(|(_, w)| !w.1.is_empty())
            .map(|(wi, w)| {
                let end = row.words.get(wi + 1).map(|n| n.0).unwrap_or(line_end).max(w.0);
                Word { start: w.0, end, text: w.1.clone() }
            })
            .collect();
        if words.is_empty() {
            continue;
        }
        out.push(Line {
            time: row.time.min(words[0].start),
            text: words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
            end: Some(words.last().unwrap().end),
            words: Some(words),
            ..Default::default()
        });
    }
    out
}

/* ------------------------------ TTML ------------------------------ */

fn attr_time(attrs: &str, name: &str) -> Option<f64> {
    let re = Regex::new(&format!(r#"{name}\s*=\s*"([^"]+)""#)).ok()?;
    let v = re.captures(attrs)?[1].trim().to_string();
    if let Some(ms) = v.strip_suffix("ms") {
        return ms.parse::<f64>().ok().map(|m| m / 1000.0);
    }
    let v = v.trim_end_matches('s');
    let parts: Vec<&str> = v.split(':').collect();
    if parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for p in parts {
        total = total * 60.0 + p.parse::<f64>().ok()?;
    }
    Some(total)
}

struct Piece {
    begin: f64,
    end: Option<f64>,
    text: String,
    boundary: bool,
}

fn pieces_to_words(timed: &[Piece]) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    let mut cur: Option<Word> = None;
    for p in timed {
        if p.text.is_empty() {
            continue;
        }
        let starts_ws = p.text.starts_with(char::is_whitespace);
        match cur.as_mut() {
            Some(c) if !(p.boundary || starts_ws) => {
                c.text.push_str(&p.text);
                if let Some(e) = p.end {
                    c.end = e;
                }
            }
            _ => {
                if let Some(c) = cur.take() {
                    words.push(Word { text: c.text.trim().to_string(), ..c });
                }
                cur = Some(Word { start: p.begin, end: p.end.unwrap_or(p.begin), text: p.text.clone() });
            }
        }
        if cur.as_ref().map(|c| c.text.ends_with(char::is_whitespace)).unwrap_or(false) {
            let c = cur.take().unwrap();
            words.push(Word { text: c.text.trim().to_string(), ..c });
        }
    }
    if let Some(c) = cur.take() {
        words.push(Word { text: c.text.trim().to_string(), ..c });
    }
    if words.iter().filter(|w| !w.text.is_empty()).count() <= 1 && timed.len() > 1 {
        words = timed
            .iter()
            .filter(|p| !p.text.trim().is_empty())
            .map(|p| Word { start: p.begin, end: p.end.unwrap_or(p.begin).max(p.begin), text: p.text.trim().to_string() })
            .collect();
    }
    words.retain(|w| !w.text.is_empty());
    for w in words.iter_mut() {
        if w.end < w.start {
            w.end = w.start;
        }
    }
    words
}

/// Apple Music TTML: a <p> per line, a timed <span> per syllable; background vocals kept apart.
pub fn parse_ttml(ttml: &str) -> Vec<Line> {
    static P_BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<p\b[^>]*>.*?</p>").unwrap());
    static P_OPEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"<p\b([^>]*)>").unwrap());
    static TOKENS: Lazy<Regex> = Lazy::new(|| Regex::new(r"<span\b([^>]*)>|</span>|<[^>]*>|[^<]+").unwrap());
    static SIDE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?:ttm:role|x-role)\s*=\s*"(?:x-translation|x-roman)""#).unwrap());
    static BG: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?:ttm:role|x-role)\s*=\s*"x-bg""#).unwrap());
    static TAGS: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());

    struct Span {
        begin: Option<f64>,
        end: Option<f64>,
        skip: bool,
        bg: bool,
        in_bg: bool,
    }
    let mut lines = Vec::new();
    for block in P_BLOCK.find_iter(ttml) {
        let block = block.as_str();
        let Some(open) = P_OPEN.captures(block) else { continue };
        let attrs = &open[1];
        if SIDE.is_match(attrs) {
            continue;
        }
        let Some(begin) = attr_time(attrs, "begin") else { continue };
        let end = attr_time(attrs, "end");
        let mut main: Vec<Piece> = Vec::new();
        let mut backing: Vec<Piece> = Vec::new();
        let mut stack: Vec<Span> = Vec::new();
        let mut owner: Option<usize> = None; // stack depth + id of the span that owns the last piece
        let mut span_id = 0usize;
        let mut ids: Vec<usize> = Vec::new();
        let mut gap = String::new();
        let mut all = String::new();
        let inner = &block[open.get(0).unwrap().end()..];
        for t in TOKENS.captures_iter(inner) {
            let tag = t.get(0).unwrap().as_str();
            if tag.starts_with("<span") {
                let sattrs = t.get(1).map(|m| m.as_str()).unwrap_or("");
                if sattrs.trim_end().ends_with('/') {
                    continue;
                }
                let parent = stack.last();
                let span = Span {
                    begin: attr_time(sattrs, "begin"),
                    end: attr_time(sattrs, "end"),
                    skip: parent.map(|p| p.skip).unwrap_or(false) || SIDE.is_match(sattrs),
                    bg: BG.is_match(sattrs),
                    in_bg: parent.map(|p| p.in_bg).unwrap_or(false) || BG.is_match(sattrs),
                };
                if span.bg {
                    gap.push(' ');
                }
                stack.push(span);
                span_id += 1;
                ids.push(span_id);
            } else if tag == "</span>" {
                ids.pop();
                if stack.pop().map(|s| s.bg).unwrap_or(false) {
                    gap.push(' ');
                }
            } else if tag == "</p>" {
                break;
            } else if !tag.starts_with('<') {
                let Some(top) = stack.last() else {
                    all.push_str(tag);
                    gap.push_str(tag);
                    continue;
                };
                if top.skip {
                    continue;
                }
                all.push_str(tag);
                match top.begin {
                    None => gap.push_str(tag),
                    Some(b) => {
                        let into = if top.in_bg { &mut backing } else { &mut main };
                        let id = *ids.last().unwrap();
                        if owner == Some(id) && !into.is_empty() {
                            into.last_mut().unwrap().text.push_str(&decode_entities(tag));
                        } else {
                            into.push(Piece { begin: b, end: top.end, text: decode_entities(tag), boundary: gap.chars().any(char::is_whitespace) });
                            owner = Some(id);
                            gap.clear();
                        }
                    }
                }
            } else if stack.last().map(|s| s.begin.is_none()).unwrap_or(true) {
                gap.push(' ');
            }
        }
        if main.is_empty() && backing.is_empty() {
            let text = decode_entities(&TAGS.replace_all(&all, "")).trim().to_string();
            if text.is_empty() {
                continue;
            }
            lines.push(Line { time: begin, text, end: end.filter(|e| *e > begin), ..Default::default() });
            continue;
        }
        let mut words = pieces_to_words(&main);
        let mut bg_words = pieces_to_words(&backing);
        if words.is_empty() {
            std::mem::swap(&mut words, &mut bg_words);
        }
        if words.is_empty() {
            continue;
        }
        let first_start = words[0].start.min(bg_words.first().map(|w| w.start).unwrap_or(f64::INFINITY));
        let last_end = words.last().unwrap().end.max(bg_words.last().map(|w| w.end).unwrap_or(0.0));
        let bg = if bg_words.is_empty() {
            None
        } else {
            Some(json!({ "text": bg_words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "), "words": bg_words }))
        };
        lines.push(Line {
            time: begin.min(first_start),
            text: words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
            end: Some(match end {
                Some(e) if e > begin => e,
                _ => last_end,
            }),
            words: Some(words),
            bg,
            ..Default::default()
        });
    }
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap());
    lines
}

/* ------------------------------ sources ------------------------------ */

async fn get_text(http: &reqwest::Client, url: &str, timeout: Duration) -> Option<String> {
    let res = http.get(url).header("User-Agent", LYRICS_AGENT).header("Accept", "application/json").timeout(timeout).send().await.ok()?;
    if !res.status().is_success() {
        log::debug!("lyrics HTTP {} {}", res.status(), &url[..url.len().min(90)]);
        return None;
    }
    res.text().await.ok()
}

async fn fetch_better_lyrics(http: &reqwest::Client, q: &Query) -> Option<Found> {
    for a in credit_forms(&q.artist) {
        let mut url = format!("https://lyrics-api.boidu.dev/getLyrics?s={}&a={}", urlencoding::encode(&search_title(&q.title)), urlencoding::encode(&a));
        if q.duration > 0.0 {
            url.push_str(&format!("&d={}", q.duration.round() as i64));
        }
        if let Some(al) = &q.album {
            url.push_str(&format!("&al={}", urlencoding::encode(&clean_title(al))));
        }
        let Some(body) = get_text(http, &url, Duration::from_secs(6)).await else { continue };
        let ttml = serde_json::from_str::<Value>(&body).ok().and_then(|v| v.get("ttml").and_then(|t| t.as_str()).map(String::from));
        if let Some(found) = ttml.filter(|t| !t.is_empty()).and_then(|t| to_result("BetterLyrics", parse_ttml(&t))) {
            return Some(found);
        }
    }
    None
}

fn lrclib_record(rec: &Value) -> Option<Found> {
    let synced = rec.get("syncedLyrics").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(parse_lrc);
    if let Some(s) = synced.as_ref().filter(|s| s.len() >= 3) {
        return to_result("LRCLIB", s.clone());
    }
    if let Some(plain) = rec.get("plainLyrics").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        return Some(Found { source: "LRCLIB".into(), word_synced: false, lines: vec![], plain: Some(plain.to_string()) });
    }
    synced.filter(|s| !s.is_empty()).and_then(|s| to_result("LRCLIB", s))
}

fn pick_lrclib_hit(results: Option<Value>, q: &Query) -> Option<Found> {
    let results = results?.as_array()?.clone();
    let synced: Vec<&Value> = results
        .iter()
        .filter(|rec| {
            rec.get("syncedLyrics").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false)
                && names_recording(
                    rec.get("trackName").and_then(|v| v.as_str()).unwrap_or(""),
                    rec.get("artistName").and_then(|v| v.as_str()).unwrap_or(""),
                    rec.get("duration").and_then(|v| v.as_f64()),
                    q,
                )
        })
        .collect();
    if synced.is_empty() {
        return None;
    }
    let credited = !artist_names(&q.artist).is_empty();
    let seconds = q.duration.round();
    if seconds <= 0.0 {
        return if credited { lrclib_record(synced[0]) } else { None };
    }
    let dur = |r: &Value| r.get("duration").and_then(|v| v.as_f64());
    let near: Vec<&Value> = synced.iter().copied().filter(|r| within_tolerance(dur(r), seconds)).collect();
    if !credited && near.is_empty() {
        return None;
    }
    let pool = if near.is_empty() { synced } else { near };
    let best = pool.into_iter().min_by(|a, b| {
        let da = (dur(a).unwrap_or(1e9) - seconds).abs();
        let db = (dur(b).unwrap_or(1e9) - seconds).abs();
        da.partial_cmp(&db).unwrap()
    })?;
    lrclib_record(best)
}

async fn fetch_lrclib(http: &reqwest::Client, q: &Query) -> Option<Found> {
    let get = |path: String| async move {
        let body = get_text(http, &format!("https://lrclib.net/api{path}"), Duration::from_secs(7)).await?;
        serde_json::from_str::<Value>(&body).ok()
    };
    let artist = search_artist(&q.artist);
    let stripped = query_title(&q.title);
    if stripped.is_empty() {
        return None;
    }
    let enc = |s: &str| urlencoding::encode(s).into_owned();
    let full = clean_title(&q.title);
    let titles = if !full.is_empty() && full.to_lowercase() != stripped.to_lowercase() { vec![full, stripped.clone()] } else { vec![stripped.clone()] };
    let mut plain_only: Option<Found> = None;
    for title in &titles {
        if !artist.is_empty() && q.duration > 0.0 {
            let album = q.album.as_ref().map(|a| format!("&album_name={}", enc(&clean_title(a)))).unwrap_or_default();
            let rec = get(format!("/get?artist_name={}&track_name={}{album}&duration={}", enc(&artist), enc(title), q.duration.round() as i64)).await;
            if let Some(rec) = rec {
                let named = names_recording(
                    rec.get("trackName").and_then(|v| v.as_str()).unwrap_or(""),
                    rec.get("artistName").and_then(|v| v.as_str()).unwrap_or(""),
                    rec.get("duration").and_then(|v| v.as_f64()),
                    q,
                );
                if named {
                    if let Some(exact) = lrclib_record(&rec) {
                        if !exact.lines.is_empty() {
                            return Some(exact);
                        }
                        plain_only = plain_only.or(Some(exact));
                    }
                }
            }
        }
        if !artist.is_empty() {
            let results = get(format!("/search?track_name={}&artist_name={}", enc(title), enc(&artist))).await;
            if let Some(hit) = pick_lrclib_hit(results, q) {
                return Some(hit);
            }
        }
    }
    let results = get(format!("/search?q={}", enc(format!("{artist} {stripped}").trim()))).await;
    pick_lrclib_hit(results, q).or(plain_only)
}

/// Timed captions for the exact playing video (get_transcript; params = protobuf field 1 = the id).
async fn fetch_transcript(music: &Music, video_id: &str) -> Option<Found> {
    static NOISE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(\[(music|applause|laughter|cheering|instrumental)\]|[♪♫\s]*)$").unwrap());
    if video_id.len() != 11 {
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
            let end = ms(seg.get("endMs")).filter(|e| *e > time);
            lines.push(Line { time, text, end, ..Default::default() });
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
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap());
    to_result("YouTube Captions", lines)
}

/// A local file's own lyrics tag, when it carries LRC timing.
fn embedded_lyrics(path: &str) -> Option<Found> {
    use lofty::file::TaggedFileExt;
    use lofty::tag::ItemKey;
    let tagged = lofty::read_from_path(path).ok()?;
    for tag in tagged.tags() {
        let Some(text) = tag.get_string(ItemKey::Lyrics) else { continue };
        if text.len() > 256 * 1024 {
            continue;
        }
        let rich = parse_enhanced_lrc(text);
        let lines = if rich.is_empty() { parse_lrc(text) } else { rich };
        if lines.len() >= 3 {
            if let Some(found) = to_result("Embedded", lines) {
                if found.plain.is_none() {
                    return Some(found);
                }
            }
        }
    }
    None
}

impl Lyrics {
    pub fn new() -> Self {
        Self { cache: Mutex::new(BoundedMap::new(400)) }
    }

    pub async fn get(&self, music: &Music, meta: LyricsMeta, local_path: Option<String>) -> Value {
        if meta.id.is_empty() {
            return Value::Null;
        }
        if let Some((cached, at)) = self.cache.lock().unwrap().get(&meta.id) {
            let word = cached.as_ref().map(|c| c["wordSynced"] == json!(true) && c["synced"].is_array()).unwrap_or(false);
            if word || at.elapsed() < Duration::from_secs(600) {
                return cached.unwrap_or(Value::Null);
            }
        }
        let result = self.sweep(music, &meta, local_path).await;
        self.cache.lock().unwrap().insert(meta.id.clone(), (result.clone(), Instant::now()));
        result.unwrap_or(Value::Null)
    }

    async fn sweep(&self, music: &Music, meta: &LyricsMeta, local_path: Option<String>) -> Option<Value> {
        if let Some(path) = local_path {
            if let Some(found) = tokio::task::spawn_blocking(move || embedded_lyrics(&path)).await.ok().flatten() {
                return Some(found_json(found));
            }
        }
        let mut artist = meta.artist.trim().to_string();
        let mut album = meta.album.clone();
        let mut duration = meta.duration.filter(|d| d.is_finite()).map(|d| d.round()).unwrap_or(0.0);
        let placeholder = PLACEHOLDER_ARTISTS.contains(&artist.to_lowercase().as_str());
        let is_yt = meta.id.len() == 11 && !meta.id.contains(':');
        if placeholder || (duration == 0.0 && is_yt) {
            if let Some((a, al, d)) = music.queue_credits(&meta.id).await {
                if placeholder {
                    if !a.is_empty() {
                        artist = a;
                    }
                    album = album.or(al);
                }
                if duration == 0.0 {
                    duration = d;
                }
            }
        }
        let q = Query { id: meta.id.clone(), title: meta.title.clone(), artist, album, duration };
        let http = &music.http;
        // Priority order; all run at once.
        let better = fetch_better_lyrics(http, &q);
        let captions = async { if is_yt { fetch_transcript(music, &q.id).await } else { None } };
        let ytm_plain = async {
            if !is_yt {
                return None;
            }
            music.yt_music_plain_lyrics(&q.id).await.map(|t| Found { source: "YouTube Music".into(), word_synced: false, lines: vec![], plain: Some(t) })
        };
        let lrclib = fetch_lrclib(http, &q);
        let deadline = tokio::time::sleep(SWEEP_CEILING);
        tokio::pin!(better, captions, ytm_plain, lrclib, deadline);
        let mut slots: [Option<Option<Found>>; 4] = [None, None, None, None];
        loop {
            // Settle as soon as the highest-ranked unsettled source can't be beaten.
            let mut fallback: Option<Found> = None;
            let mut decided: Option<Found> = None;
            let mut waiting = false;
            for slot in slots.iter() {
                match slot {
                    None => {
                        waiting = true;
                        break;
                    }
                    Some(Some(f)) if !f.lines.is_empty() => {
                        decided = Some(f.clone());
                        break;
                    }
                    Some(Some(f)) => {
                        if fallback.is_none() {
                            fallback = Some(f.clone());
                        }
                    }
                    Some(None) => {}
                }
            }
            if let Some(f) = decided {
                return Some(found_json(f));
            }
            if !waiting {
                return fallback.map(found_json);
            }
            tokio::select! {
                r = &mut better, if slots[0].is_none() => slots[0] = Some(r),
                r = &mut captions, if slots[1].is_none() => slots[1] = Some(r),
                r = &mut ytm_plain, if slots[2].is_none() => slots[2] = Some(r),
                r = &mut lrclib, if slots[3].is_none() => slots[3] = Some(r),
                _ = &mut deadline => {
                    // Out of time: the best of what has answered.
                    let answered: Vec<Found> = slots.iter().filter_map(|s| s.clone().flatten()).collect();
                    return answered.iter().find(|f| !f.lines.is_empty()).cloned().or_else(|| answered.into_iter().next()).map(found_json);
                }
            }
        }
    }
}

fn found_json(f: Found) -> Value {
    if let Some(plain) = f.plain {
        return json!({ "synced": null, "plain": plain, "source": f.source, "wordSynced": false });
    }
    json!({ "synced": f.lines, "plain": null, "source": f.source, "wordSynced": f.word_synced })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_lines() {
        let l = parse_lrc("[00:12.34]Hello\n[00:15.00]World &amp; more");
        assert_eq!(l.len(), 2);
        assert!((l[0].time - 12.34).abs() < 1e-6);
        assert_eq!(l[1].text, "World & more");
    }

    #[test]
    fn ttml_words() {
        let ttml = r#"<tt><body><div><p begin="1.0" end="3.0"><span begin="1.0" end="1.5">Hel</span><span begin="1.5" end="2.0">lo </span><span begin="2.0" end="3.0">world</span></p></div></body></tt>"#;
        let lines = parse_ttml(ttml);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello world");
        assert_eq!(lines[0].words.as_ref().unwrap().len(), 2);
    }
}
