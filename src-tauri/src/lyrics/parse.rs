//! Reading what the sources send — ByTune's lyrics.ts parsers: LRC, word-timed LRC, QQ's karaoke LRC,
//! Apple's TTML (syllables, background vocals, romanized readings), and the envelopes the smaller
//! backends wrap any of those in. All times are SECONDS end to end: sources that send milliseconds
//! convert here, at the parse boundary.

use super::naming::{names_recording, Playing};
use super::{Found, Line, Word};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

pub fn decode_entities(s: &str) -> String {
    static HEX: Lazy<Regex> = Lazy::new(|| re(r"&#x([0-9a-fA-F]+);"));
    static DEC: Lazy<Regex> = Lazy::new(|| re(r"&#([0-9]+);"));
    let s = HEX.replace_all(s, |c: &regex::Captures| {
        u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    let s = DEC.replace_all(&s, |c: &regex::Captures| c[1].parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default());
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// [mm:ss.xx] or [mm:ss.xxx] → milliseconds. Hundredths get ×10.
fn stamp_ms(min: &str, sec: &str, frac: &str) -> f64 {
    let m: f64 = min.parse().unwrap_or(0.0);
    let s: f64 = sec.parse().unwrap_or(0.0);
    let f: f64 = if frac.len() == 2 { frac.parse::<f64>().unwrap_or(0.0) * 10.0 } else { frac.parse().unwrap_or(0.0) };
    (m * 60.0 + s) * 1000.0 + f
}

fn by_time(lines: &mut [Line]) {
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
}

/* ------------------------------ results ------------------------------ */

fn line_end(line: &Line, next_start: f64) -> f64 {
    if let Some(e) = line.end {
        return e;
    }
    if let Some(w) = line.words.as_ref().and_then(|w| w.last()) {
        return w.end;
    }
    line.time + (next_start - line.time).clamp(2.0, 8.0)
}

/// Gap markers where ≥5 s of nobody sings — instrumental sections.
fn with_instrumental_gaps(lines: Vec<Line>) -> Vec<Line> {
    let mut out = Vec::with_capacity(lines.len());
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

pub fn plain_found(source: &str, text: &str) -> Option<Found> {
    let text = text.trim();
    (!text.is_empty()).then(|| Found { source: source.into(), word_synced: false, lines: vec![], plain: Some(text.to_string()) })
}

/// Lines as a source's answer: timed, or (every stamp at 0:00) its text as plain.
pub fn to_result(source: &str, lines: Vec<Line>) -> Option<Found> {
    if lines.is_empty() {
        return None;
    }
    let has_words = |l: &Line| l.words.as_ref().map(|w| !w.is_empty()).unwrap_or(false);
    if !lines.iter().any(|l| l.time > 0.0 || has_words(l)) {
        let plain = lines.iter().map(|l| l.text.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
        return plain_found(source, &plain);
    }
    let word_synced = lines.iter().any(has_words);
    Some(Found { source: source.into(), word_synced, lines: with_instrumental_gaps(lines), plain: None })
}

/* ----------------------- a file's own opening name ----------------------- */

/// "Lyrics by：…", "作曲：…" — a credit stamped like a lyric.
static CREDIT_LINE: Lazy<Regex> = Lazy::new(|| re(r"^[^:：]{1,40}[:：]\s*\S"));

/// The "Title - Artist" line QQ and KuGou stamp at the head of a file, split at its dash.
fn opening_name(lines: &[Line]) -> Option<(String, String)> {
    let first = lines.iter().find(|l| !l.text.trim().is_empty())?;
    if first.time > 2.0 {
        return None;
    }
    let text = first.text.trim();
    let cut = text.rfind(" - ").filter(|c| *c > 0)?;
    Some((text[..cut].to_string(), text[cut + 3..].to_string()))
}

/// Whether a file's opening name line names the playing recording, read either way round; None when
/// the file has no such line.
pub fn opening_name_fits(lines: &[Line], q: Playing, length: Option<f64>) -> Option<bool> {
    let (a, b) = opening_name(lines)?;
    Some(names_recording(&a, &b, q, length, false) || names_recording(&b, &a, q, length, false))
}

/// The lyrics without that opening name line and the credits stamped next to it or at the very end.
pub fn without_opening(lines: Vec<Line>) -> Vec<Line> {
    let skip = |l: &Line| l.text.trim().is_empty() || CREDIT_LINE.is_match(&l.text);
    let mut start = if opening_name(&lines).is_some() { lines.iter().position(|l| !l.text.trim().is_empty()).map(|i| i + 1).unwrap_or(0) } else { 0 };
    while start < lines.len() && skip(&lines[start]) {
        start += 1;
    }
    let mut end = lines.len();
    while end > start && skip(&lines[end - 1]) {
        end -= 1;
    }
    lines[start..end].to_vec()
}

/* ------------------------------ LRC ------------------------------ */

static LRC_LINE: Lazy<Regex> = Lazy::new(|| re(r"^\[([0-9]{1,3}):([0-9]{2})[.:]([0-9]{2,3})](.*)$"));
static LRC_WORD: Lazy<Regex> = Lazy::new(|| re(r"<([0-9]{1,3}):([0-9]{2})[.:]([0-9]{2,3})>([^<]*)"));
static LRC_WORD_STAMP: Lazy<Regex> = Lazy::new(|| re(r"<[0-9]{1,3}:[0-9]{2}[.:][0-9]{2,3}>"));

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
    by_time(&mut rows);
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
    rows.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
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

/* ----------------------- karaoke LRC (QRC / YRC) ----------------------- */

static KARAOKE_LINE: Lazy<Regex> = Lazy::new(|| re(r"^\[([0-9]{1,8}),([0-9]{1,8})](.*)$"));
static KARAOKE_PREFIX_WORD: Lazy<Regex> = Lazy::new(|| re(r"\(([0-9]{1,8}),([0-9]{1,8})(?:,[0-9]{1,8})?\)([^()]*)"));
static KARAOKE_SUFFIX_WORD: Lazy<Regex> = Lazy::new(|| re(r"([^()]*)\(([0-9]{1,8}),([0-9]{1,8})(?:,[0-9]{1,8})?\)"));
static KARAOKE_WORD_TIME: Lazy<Regex> = Lazy::new(|| re(r"\([0-9]{1,8},[0-9]{1,8}(?:,[0-9]{1,8})?\)"));

/// Some producers wrap the whole thing in a `LyricContent="…"` variable, which is peeled off first.
fn karaoke_content(raw: &str) -> String {
    static VAR: Lazy<Regex> = Lazy::new(|| re(r#"(?i)LyricContent\s*=\s*"([^"]*)""#));
    match VAR.captures(raw) {
        Some(c) => c[1].replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"),
        None => raw.to_string(),
    }
}

fn karaoke_looks_like(raw: &str) -> bool {
    static BEFORE: Lazy<Regex> = Lazy::new(|| re(r"\([0-9]{1,8},[0-9]{1,8}(?:,[0-9]{1,8})?\)[^()]"));
    static AFTER: Lazy<Regex> = Lazy::new(|| re(r"[^()]\([0-9]{1,8},[0-9]{1,8}(?:,[0-9]{1,8})?\)"));
    karaoke_content(raw).lines().any(|source| {
        KARAOKE_LINE.captures(source.trim()).map(|m| BEFORE.is_match(&m[3]) || AFTER.is_match(&m[3])).unwrap_or(false)
    })
}

/// QQ Music's karaoke format: millisecond line ranges `[start,dur]` with per-word stamps written
/// `(start,dur[,0])word` before the word or `word(start,dur)` after it.
pub fn parse_karaoke_lrc(raw: &str) -> Vec<Line> {
    let ms = |s: &str| s.parse::<f64>().unwrap_or(0.0) / 1000.0;
    let mut rows = Vec::new();
    for source in karaoke_content(raw).lines() {
        let Some(m) = KARAOKE_LINE.captures(source.trim()) else { continue };
        let (line_start, line_dur, body) = (ms(&m[1]), ms(&m[2]), m[3].to_string());
        // The stamp set that carries more text is the real convention of this file.
        let prefixed: Vec<(f64, f64, String)> = KARAOKE_PREFIX_WORD.captures_iter(&body).map(|w| (ms(&w[1]), ms(&w[2]), decode_entities(&w[3]))).collect();
        let suffixed: Vec<(f64, f64, String)> = KARAOKE_SUFFIX_WORD.captures_iter(&body).map(|w| (ms(&w[2]), ms(&w[3]), decode_entities(&w[1]))).collect();
        let len = |list: &[(f64, f64, String)]| list.iter().map(|w| w.2.encode_utf16().count()).sum::<usize>();
        let picked = if len(&prefixed) >= len(&suffixed) { prefixed } else { suffixed };
        let words: Vec<Word> = picked
            .into_iter()
            .filter_map(|(start, dur, text)| {
                let text = text.trim().to_string();
                (!text.is_empty()).then(|| Word { start, end: (start + dur).max(start), text })
            })
            .collect();
        if words.is_empty() {
            continue;
        }
        let text = decode_entities(&KARAOKE_WORD_TIME.replace_all(&body, "")).trim().to_string();
        if text.is_empty() {
            continue;
        }
        rows.push(Line {
            time: line_start.min(words[0].start),
            text,
            end: Some(if line_dur > 0.0 { line_start + line_dur } else { words.last().unwrap().end }),
            words: Some(words),
            ..Default::default()
        });
    }
    by_time(&mut rows);
    rows
}

/* --------------------- generic provider-envelope parse ------------------- */

const PROVIDER_CONTENT_KEYS: &[&str] = &[
    "ttml", "ttmlContent", "lyrics", "lyricContent", "lrc", "content", "text", "plainLyrics", "syncedLyrics", "line", "lines", "lyric", "data",
    "result", "response",
];

fn provider_extract_string(el: &Value, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    match el {
        Value::String(s) => {
            let text = s.trim();
            if text.is_empty() {
                return None;
            }
            if (text.starts_with('{') && text.ends_with('}')) || (text.starts_with('[') && text.ends_with(']')) {
                return match serde_json::from_str::<Value>(text) {
                    Ok(v) => provider_extract_string(&v, depth + 1),
                    Err(_) => Some(text.to_string()),
                };
            }
            Some(text.to_string())
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(|v| provider_extract_string(v, depth + 1)).collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(obj) => {
            if obj.get("isError") == Some(&Value::Bool(true)) || obj.get("ok") == Some(&Value::Bool(false)) {
                return None;
            }
            match obj.get("error") {
                None | Some(Value::Null) | Some(Value::Bool(false)) => {}
                Some(Value::String(s)) if s.is_empty() || s == "false" => {}
                _ => return None,
            }
            for key in PROVIDER_CONTENT_KEYS {
                if let Some(found) = obj.get(*key).and_then(|v| provider_extract_string(v, depth + 1)) {
                    return Some(found);
                }
            }
            obj.get("metadata").filter(|m| m.is_object()).and_then(|m| provider_extract_string(m, depth + 1))
        }
        _ => None,
    }
}

pub enum Parsed {
    Lines(Vec<Line>),
    Plain(String),
}

/// Synced lines, or plain text when the payload carried no timing at all.
pub fn parse_provider_any(raw: &str) -> Option<Parsed> {
    static TT_ESCAPED: Lazy<Regex> = Lazy::new(|| re(r"(?i)&lt;(tt[\s>]|/tt)"));
    static TT: Lazy<Regex> = Lazy::new(|| re(r"(?i)<tt[\s>]"));
    static NOT_FOUND: Lazy<Regex> = Lazy::new(|| re(r"(?i)\b(lyrics? (?:not found|unavailable)|error)\b"));
    static TAG_LINE: Lazy<Regex> = Lazy::new(|| re(r"^\[[A-Za-z]+:.*]$"));
    let mut value = raw.trim_start_matches('\u{feff}').trim().to_string();
    if value.starts_with("```") {
        let mut lines: Vec<&str> = value.lines().collect();
        if lines.len() > 1 && lines.last().map(|l| l.trim() == "```").unwrap_or(false) {
            lines.pop();
        }
        value = lines.get(1..).map(|l| l.join("\n")).unwrap_or_default().trim().to_string();
    }
    if value.is_empty() {
        return None;
    }
    let mut content = value.clone();
    if let Ok(json) = serde_json::from_str::<Value>(&value) {
        content = provider_extract_string(&json, 0)?;
    }
    if TT_ESCAPED.is_match(&content) {
        content = decode_entities(&content);
    }
    if TT.is_match(&content) || content.to_lowercase().contains("http://www.w3.org/ns/ttml") {
        let ttml = parse_ttml(&content);
        if !ttml.is_empty() {
            return Some(Parsed::Lines(ttml));
        }
    }
    if karaoke_looks_like(&content) {
        let karaoke = parse_karaoke_lrc(&content);
        if !karaoke.is_empty() {
            return Some(Parsed::Lines(karaoke));
        }
    }
    if content.trim_start().starts_with('<') {
        return None;
    }
    let enhanced = parse_enhanced_lrc(&content);
    if !enhanced.is_empty() {
        return Some(Parsed::Lines(enhanced));
    }
    let lrc = parse_lrc(&content);
    if !lrc.is_empty() {
        return Some(Parsed::Lines(lrc));
    }
    if NOT_FOUND.is_match(&content) {
        return None;
    }
    let plain = content.lines().map(str::trim).filter(|l| !l.is_empty() && !TAG_LINE.is_match(l)).collect::<Vec<_>>().join("\n");
    (!plain.is_empty()).then_some(Parsed::Plain(plain))
}

/* ------------------------------ TTML ------------------------------ */

/// TTML time → seconds: "27.395", "12.5s", "800ms", "H:MM:SS.mmm", "M:SS.mmm", "02:39".
fn attr_time(attrs: &str, name: &str) -> Option<f64> {
    let re = Regex::new(&format!(r#"{name}\s*=\s*"([^"]+)""#)).ok()?;
    let v = re.captures(attrs)?[1].trim().to_string();
    if let Some(ms) = v.strip_suffix("ms") {
        return ms.parse::<f64>().ok().map(|m| m / 1000.0);
    }
    let v = v.strip_suffix('s').unwrap_or(&v);
    let parts: Vec<&str> = v.split(':').collect();
    if parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for p in parts {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return None;
        }
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

/// Glue syllable pieces into words: a boundary is whitespace in the gap before a piece or inside its
/// text. A producer that emits no whitespace at all gets one word per piece.
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

fn plain_markup(markup: &str) -> String {
    static TAGS: Lazy<Regex> = Lazy::new(|| re(r"<[^>]+>"));
    decode_entities(&TAGS.replace_all(markup, "")).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Romanized lines from the head's first transliteration block, keyed by line (itunes:key).
fn ttml_transliterations(ttml: &str) -> std::collections::HashMap<String, String> {
    static BLOCK: Lazy<Regex> = Lazy::new(|| re(r"(?s)<transliteration\b[^>]*>(.*?)</transliteration>"));
    static TEXT: Lazy<Regex> = Lazy::new(|| re(r#"(?s)<text\b[^>]*\bfor\s*=\s*"([^"]+)"[^>]*>(.*?)</text>"#));
    let mut out = std::collections::HashMap::new();
    if let Some(block) = BLOCK.captures(ttml) {
        for m in TEXT.captures_iter(&block[1]) {
            let text = plain_markup(&m[2]);
            if !text.is_empty() {
                out.insert(m[1].to_string(), text);
            }
        }
    }
    out
}

/// Apple Music TTML, word-timed: a <p> per line, a timed <span> per syllable; whitespace — not the
/// span boundary — separates words. Kept per line: background vocals (an x-bg wrapper) and a romanized
/// reading (head transliterations or an inline x-roman span).
pub fn parse_ttml(ttml: &str) -> Vec<Line> {
    static P_BLOCK: Lazy<Regex> = Lazy::new(|| re(r"(?s)<p\b[^>]*>.*?</p>|<p\b[^>]*/>"));
    static P_OPEN: Lazy<Regex> = Lazy::new(|| re(r"<p\b([^>]*)>"));
    static TOKENS: Lazy<Regex> = Lazy::new(|| re(r"<span\b([^>]*)>|</span>|<[^>]*>|[^<]+"));
    static SIDE: Lazy<Regex> = Lazy::new(|| re(r#"(?:ttm:role|x-role)\s*=\s*"(?:x-translation|x-roman)""#));
    static ROMAN: Lazy<Regex> = Lazy::new(|| re(r#"(?:ttm:role|x-role)\s*=\s*"x-roman""#));
    static BG: Lazy<Regex> = Lazy::new(|| re(r#"(?:ttm:role|x-role)\s*=\s*"x-bg""#));
    static KEY: Lazy<Regex> = Lazy::new(|| re(r#"itunes:key\s*=\s*"([^"]+)""#));
    static SELF_CLOSING: Lazy<Regex> = Lazy::new(|| re(r"/\s*$"));

    struct Span {
        begin: Option<f64>,
        end: Option<f64>,
        skip: bool,
        bg: bool,
        in_bg: bool,
        roman: bool,
        id: usize,
    }
    let romans = ttml_transliterations(ttml);
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
        let key = KEY.captures(attrs).map(|c| c[1].to_string());
        let mut main: Vec<Piece> = Vec::new();
        let mut backing: Vec<Piece> = Vec::new();
        let mut stack: Vec<Span> = Vec::new();
        let mut owner: Option<usize> = None;
        let mut next_id = 0usize;
        let mut gap = String::new();
        let mut all = String::new();
        let mut roman = String::new();
        for t in TOKENS.captures_iter(block) {
            let tag = t.get(0).unwrap().as_str();
            if tag.starts_with("<span") {
                let sattrs = t.get(1).map(|m| m.as_str()).unwrap_or("");
                if SELF_CLOSING.is_match(sattrs) {
                    continue; // <span/>: nothing inside
                }
                let parent = stack.last();
                next_id += 1;
                let span = Span {
                    begin: attr_time(sattrs, "begin"),
                    end: attr_time(sattrs, "end"),
                    skip: parent.map(|p| p.skip).unwrap_or(false) || SIDE.is_match(sattrs),
                    bg: BG.is_match(sattrs),
                    in_bg: parent.map(|p| p.in_bg).unwrap_or(false) || BG.is_match(sattrs),
                    roman: parent.map(|p| p.roman).unwrap_or(false) || ROMAN.is_match(sattrs),
                    id: next_id,
                };
                if span.bg {
                    gap.push(' ');
                }
                stack.push(span);
            } else if tag == "</span>" {
                if stack.pop().map(|s| s.bg).unwrap_or(false) {
                    gap.push(' ');
                }
            } else if !tag.starts_with('<') {
                let top = stack.last();
                if top.map(|s| s.roman).unwrap_or(false) {
                    roman.push_str(tag);
                }
                if top.map(|s| s.skip).unwrap_or(false) {
                    continue;
                }
                all.push_str(tag);
                match top.and_then(|s| s.begin.map(|b| (b, s.end, s.in_bg, s.id))) {
                    None => gap.push_str(tag),
                    Some((b, e, in_bg, id)) => {
                        let into = if in_bg { &mut backing } else { &mut main };
                        if owner == Some(id) && !into.is_empty() {
                            into.last_mut().unwrap().text.push_str(&decode_entities(tag));
                        } else {
                            into.push(Piece { begin: b, end: e, text: decode_entities(tag), boundary: gap.chars().any(char::is_whitespace) });
                            owner = Some(id);
                            gap.clear();
                        }
                    }
                }
            } else if stack.last().map(|s| s.begin.is_none()).unwrap_or(true) {
                gap.push(' '); // a <br/> or other tag between words still separates them
            }
        }
        let roman_text = key.as_ref().and_then(|k| romans.get(k).cloned()).or_else(|| Some(plain_markup(&roman)).filter(|r| !r.is_empty()));
        if main.is_empty() && backing.is_empty() {
            // Line-synced TTML: bare text, no timed spans.
            let text = decode_entities(&all).trim().to_string();
            if text.is_empty() {
                continue;
            }
            lines.push(Line { time: begin, text, end: end.filter(|e| *e > begin), roman: roman_text, ..Default::default() });
            continue;
        }
        let mut words = pieces_to_words(&main);
        let mut bg_words = pieces_to_words(&backing);
        // A line that is only background vocals is shown as the line itself.
        if words.is_empty() {
            std::mem::swap(&mut words, &mut bg_words);
        }
        if words.is_empty() {
            continue;
        }
        let first_start = words[0].start.min(bg_words.first().map(|w| w.start).unwrap_or(f64::INFINITY));
        let last_end = words.last().unwrap().end.max(bg_words.last().map(|w| w.end).unwrap_or(0.0));
        let bg = (!bg_words.is_empty())
            .then(|| json!({ "text": bg_words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "), "words": bg_words }));
        lines.push(Line {
            time: begin.min(first_start),
            text: words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
            end: Some(match end {
                Some(e) if e > begin => e,
                _ => last_end,
            }),
            words: Some(words),
            bg,
            roman: roman_text,
            ..Default::default()
        });
    }
    by_time(&mut lines);
    lines
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
    fn ttml_words_and_roman() {
        let ttml = r#"<tt><head><iTunesMetadata><transliterations><transliteration><text for="L1"><span>sa ran ghae</span></text></transliteration></transliterations></iTunesMetadata></head><body><div><p begin="1.0" end="3.0" itunes:key="L1"><span begin="1.0" end="1.5">Hel</span><span begin="1.5" end="2.0">lo </span><span begin="2.0" end="3.0">world</span></p></div></body></tt>"#;
        let lines = parse_ttml(ttml);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello world");
        assert_eq!(lines[0].words.as_ref().unwrap().len(), 2);
        assert_eq!(lines[0].roman.as_deref(), Some("sa ran ghae"));
    }

    #[test]
    fn karaoke() {
        let lines = parse_karaoke_lrc("[1000,2000](1000,500,0)Hel(1500,500,0)lo");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello");
        assert_eq!(lines[0].end, Some(3.0));
        assert!(matches!(parse_provider_any(r#"{"lyrics":"[1000,2000](1000,500,0)Hi"}"#), Some(Parsed::Lines(_))));
        assert!(matches!(parse_provider_any("just words\nmore words"), Some(Parsed::Plain(_))));
    }
}
