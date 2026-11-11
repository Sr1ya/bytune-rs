//! Lyrics — a port of ByTune's electron/lyrics.ts (BitChord's lyrics system) and the lyrics part of
//! music-service.ts.
//!
//! The recording is settled first: the BiniLyrics search names it by ISRC (`identify_recording`), so
//! lrc.red fetches that very recording's document and LyricsPlus asks for it by code. Every source is
//! asked at once (Genius, a scraper, only when nothing else answered), and the answers are taken in
//! priority order: a lower source finishing first never beats one still pending above it, and the
//! highest-priority source with timed lyrics wins — word or line timing. Plain text is the fallback.
//!
//! The order: lrc.red → BiniLyrics → BetterLyrics (Apple TTML) → Portato (QQ Music karaoke timings) →
//! PaxSenix (Apple TTML via a public proxy) → LyricsPlus (syllable mirrors) → Unison → the playing
//! video's own captions → YT Music's Lyrics tab → KuGou → LRCLIB → Musixmatch → Genius.
//!
//! Every source that searches by name must name the playing recording before its words are used
//! (naming.rs). A local file's own timed lyrics tag is read before any source is asked.

mod naming;
mod parse;
mod sources;

use crate::music::{BoundedMap, Music};
use futures_util::future::{BoxFuture, FutureExt};
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sources::Ctx;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub use parse::{parse_enhanced_lrc, parse_lrc};

/// The longest a lookup waits for the racing sources; when it passes, the pick goes on with whatever
/// has landed. Genius, asked only when nothing answered, is bounded by its own request timeouts.
const SWEEP_CEILING: Duration = Duration::from_secs(12);

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

#[derive(Clone, Debug)]
pub struct Query {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    /// seconds, 0 = unknown
    pub duration: f64,
}

pub struct Lyrics {
    cache: Mutex<BoundedMap<(Option<Value>, Instant)>>,
}

/// A local file's own lyrics tag, when it carries LRC timing ("Lyrics from this file").
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
        if let Some(found) = parse::to_result("this file", lines) {
            if found.plain.is_none() && found.lines.iter().any(|l| !l.text.trim().is_empty()) {
                return Some(found);
            }
        }
    }
    None
}

fn found_json(f: Found) -> Value {
    if let Some(plain) = f.plain {
        return json!({ "synced": null, "plain": plain, "source": f.source, "wordSynced": false });
    }
    json!({ "synced": f.lines, "plain": null, "source": f.source, "wordSynced": f.word_synced })
}

/// The sources, in priority order, the last one lazy (asked only when nothing above it answered).
const SOURCES: [&str; 13] = [
    "lrc.red", "BiniLyrics", "BetterLyrics", "Portato", "PaxSenix", "LyricsPlus", "Unison", "YouTube Captions", "YouTube Music", "KuGou",
    "LRCLIB", "Musixmatch", "Genius",
];
const LAZY: usize = 12;

impl Lyrics {
    pub fn new() -> Self {
        Self { cache: Mutex::new(BoundedMap::new(400)) }
    }

    pub async fn get(&self, music: &Music, meta: LyricsMeta, local_path: Option<String>) -> Value {
        if meta.id.is_empty() {
            return Value::Null;
        }
        // A word-synced answer sticks for the session; anything else (a miss included) for 10 minutes.
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
        // The "All" search page credits rows it has no links for "Unknown artist", and some rows carry no
        // length: the track's own watch-queue row has both.
        let mut artist = meta.artist.trim().to_string();
        let mut album = meta.album.clone();
        let mut duration = meta.duration.filter(|d| d.is_finite()).map(|d| d.round()).unwrap_or(0.0);
        let placeholder = naming::PLACEHOLDER_ARTISTS.contains(&artist.to_lowercase().as_str());
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
        let ctx = Ctx { http: &music.http, q: &q };
        let began = Instant::now();
        let pick = take_in_priority_order(&ctx, music).await;
        match &pick {
            Some(f) => log::info!("lyrics: {} for \"{}\" ({} lines, word={}) in {} ms", f.source, q.title, f.lines.len(), f.word_synced, began.elapsed().as_millis()),
            None => log::info!("lyrics: none for \"{}\" in {} ms", q.title, began.elapsed().as_millis()),
        }
        pick.map(found_json)
    }
}

/// The sources' answers taken in priority order — BitChord's loop. Every source but the lazy one is
/// asked at once, and their answers are awaited one at a time in order, so a lower source finishing
/// first never beats one still pending above it. The first timed answer wins; an untimed one is kept
/// as the fallback while the rest are searched. Past the ceiling, sources still running are skipped;
/// the lazy source (Genius) is only asked when nothing above it answered at all, however late.
async fn take_in_priority_order(ctx: &Ctx<'_>, music: &Music) -> Option<Found> {
    let (hit, full) = sources::identify_recording(ctx);
    let docs = sources::Docs::new(ctx.http);
    let cached_isrc = sources::cached_isrc(&ctx.q.id);
    let mut racing: FuturesUnordered<BoxFuture<'_, (usize, Option<Found>)>> = FuturesUnordered::new();
    let starts: Vec<BoxFuture<'_, Option<Found>>> = vec![
        sources::fetch_lrc_red(ctx, hit.clone(), &docs).boxed(),
        sources::fetch_bini(ctx, full, &docs).boxed(),
        sources::fetch_better_lyrics(ctx).boxed(),
        sources::fetch_portato(ctx).boxed(),
        sources::fetch_pax_senix(ctx).boxed(),
        async { sources::fetch_lyrics_plus(ctx, hit.await.and_then(|h| h.isrc).or(cached_isrc)).await }.boxed(),
        sources::fetch_unison(ctx).boxed(),
        sources::fetch_transcript(music, ctx).boxed(),
        sources::fetch_youtube_music(music, ctx).boxed(),
        sources::fetch_kugou(ctx).boxed(),
        sources::fetch_lrclib(ctx).boxed(),
        sources::fetch_musixmatch(ctx).boxed(),
    ];
    for (i, start) in starts.into_iter().enumerate() {
        racing.push(start.map(move |r| (i, r)).boxed());
    }
    let mut settled: Vec<Option<Option<Found>>> = vec![None; SOURCES.len()];
    let deadline = tokio::time::sleep(SWEEP_CEILING);
    tokio::pin!(deadline);
    let mut past_deadline = false;
    let mut fallback: Option<Found> = None;
    let mut i = 0;
    loop {
        while i < SOURCES.len() {
            if i == LAZY {
                if fallback.is_some() {
                    return fallback;
                }
                // Nothing answered: the lazy source runs, however late that is.
                let found = sources::fetch_genius(ctx).await;
                log::debug!("lyrics {}: {}", SOURCES[i], found.as_ref().map(|f| f.source.as_str()).unwrap_or("nothing"));
                return found;
            }
            match settled[i].take() {
                Some(Some(found)) => {
                    if found.word_synced || !found.lines.is_empty() {
                        return Some(found);
                    }
                    fallback.get_or_insert(found);
                    i += 1;
                }
                Some(None) => i += 1,
                None if past_deadline => {
                    log::debug!("lyrics {}: still running at the deadline", SOURCES[i]);
                    i += 1;
                }
                None => break,
            }
        }
        if i >= SOURCES.len() {
            return fallback;
        }
        tokio::select! {
            next = racing.next() => match next {
                Some((k, r)) => settled[k] = Some(r),
                None => past_deadline = true,
            },
            _ = &mut deadline, if !past_deadline => past_deadline = true,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sources_in_order() {
        assert_eq!(super::SOURCES[super::LAZY], "Genius");
    }

    /// Every source asked on its own, against the live services: which answer, and with what.
    /// `cargo test --lib live_sources -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_sources() {
        use super::*;
        let m = crate::music::live_music();
        let songs = [
            ("9qnqYL0eNNI", "Yellow", "Coldplay", Some("Parachutes"), 267.0),
            ("VuNIsY6JdUw", "Tum Hi Ho", "Arijit Singh", Some("Aashiqui 2"), 262.0),
            ("Ff0pYV2fbxM", "Brown Munde", "AP Dhillon, Gurinder Gill & Shinda Kahlon", None, 267.0),
            ("XsX3ATc3FbA", "Spring Day", "BTS", Some("YOU NEVER WALK ALONE"), 274.0),
        ];
        for (id, title, artist, album, duration) in songs {
            let q = Query { id: id.into(), title: title.into(), artist: artist.into(), album: album.map(String::from), duration };
            let ctx = Ctx { http: &m.http, q: &q };
            let (hit, full) = sources::identify_recording(&ctx);
            let docs = sources::Docs::new(ctx.http);
            let isrc = hit.clone().await.and_then(|h| h.isrc);
            println!("== {title} — {artist}: isrc={isrc:?}");
            let all: Vec<(&str, BoxFuture<'_, Option<Found>>)> = vec![
                ("lrc.red", sources::fetch_lrc_red(&ctx, hit.clone(), &docs).boxed()),
                ("BiniLyrics", sources::fetch_bini(&ctx, full, &docs).boxed()),
                ("BetterLyrics", sources::fetch_better_lyrics(&ctx).boxed()),
                ("Portato", sources::fetch_portato(&ctx).boxed()),
                ("PaxSenix", sources::fetch_pax_senix(&ctx).boxed()),
                ("LyricsPlus", sources::fetch_lyrics_plus(&ctx, isrc.clone()).boxed()),
                ("Unison", sources::fetch_unison(&ctx).boxed()),
                ("KuGou", sources::fetch_kugou(&ctx).boxed()),
                ("LRCLIB", sources::fetch_lrclib(&ctx).boxed()),
                ("Musixmatch", sources::fetch_musixmatch(&ctx).boxed()),
                ("Genius", sources::fetch_genius(&ctx).boxed()),
            ];
            for (name, fut) in all {
                let start = Instant::now();
                let r = fut.await;
                let what = match &r {
                    Some(f) if f.plain.is_some() => format!("plain ({} chars)", f.plain.as_ref().unwrap().len()),
                    Some(f) => format!("{} lines, word={}, first=\"{}\"", f.lines.len(), f.word_synced, f.lines.iter().find(|l| !l.text.is_empty()).map(|l| l.text.as_str()).unwrap_or("")),
                    None => "nothing".into(),
                };
                println!("  {name:<12} {what}  ({} ms)", start.elapsed().as_millis());
            }
            let lyr = Lyrics::new();
            let r = lyr.get(&m, LyricsMeta { id: id.into(), title: title.into(), artist: artist.into(), album: album.map(String::from), duration: Some(duration) }, None).await;
            println!("  => sweep picks {} (word={})", r["source"], r["wordSynced"]);
        }
    }
}
