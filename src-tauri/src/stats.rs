//! Replay listening stats — a port of `electron/stats.ts`.
//!
//! Listening time arrives as playback events from the UI and is bucketed by
//! month (tracks, artists, albums, hours of the day, days). A track counts as
//! one play once this listen reaches min(max(duration/2, 30 s), 4 min) — replays
//! count again, loops don't inflate. Buckets persist in the `listening-history`
//! store, 36 months at most, flushed every few seconds.

use crate::persist::Persist;
use crate::ytm::Track;
use chrono::{Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

const PLAY_FLOOR_MS: f64 = 30_000.0;
const PLAY_CEILING_MS: f64 = 4.0 * 60.0 * 1000.0;
const KEEP_MONTHS: i32 = 36;
const MAX_TRACKS: usize = 600;
const MAX_NAMES: usize = 400;
pub const HISTORY_STORE: &str = "listening-history";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackEntry {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub thumb: String,
    #[serde(default)]
    pub ms: f64,
    #[serde(default)]
    pub plays: f64,
    #[serde(default)]
    pub last_at: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NameEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(default)]
    pub ms: f64,
    #[serde(default)]
    pub plays: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MonthBucket {
    pub month: String,
    #[serde(default)]
    pub tracks: HashMap<String, TrackEntry>,
    #[serde(default)]
    pub artists: HashMap<String, NameEntry>,
    #[serde(default)]
    pub albums: HashMap<String, NameEntry>,
    #[serde(default)]
    pub hours: Vec<f64>,
    #[serde(default)]
    pub days: HashMap<String, f64>,
}

impl MonthBucket {
    fn new(month: &str) -> Self {
        Self { month: month.into(), hours: vec![0.0; 24], ..Default::default() }
    }
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    dirty: bool,
    open: BTreeMap<String, MonthBucket>,
    rule_ms: HashMap<String, f64>,
    rule_counted: HashSet<String>,
}

pub struct Stats {
    inner: Mutex<Inner>,
}

fn month_key(year: i32, month: u32) -> String {
    format!("{year}-{month:02}")
}

fn cutoff_key() -> String {
    let now = Local::now();
    let total = now.year() * 12 + now.month0() as i32 - KEEP_MONTHS;
    month_key(total.div_euclid(12), (total.rem_euclid(12) + 1) as u32)
}

/// "A, B & C feat. D" → ["A", "B", "C", "D"] (src/lib/replayFormat.ts creditNames).
fn credit_names(line: &str) -> Vec<String> {
    let re = regex::Regex::new(r"(?i)\s*(?:,|&|\bfeat\.?\s|\bft\.?\s|\bfeaturing\b)\s*").unwrap();
    let names: Vec<String> = re.split(line).map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
    if names.is_empty() { vec![line.trim().to_string()] } else { names }
}

fn prune_bucket(b: &mut MonthBucket) {
    fn trim<T>(rec: &mut HashMap<String, T>, max: usize, ms: impl Fn(&T) -> f64) {
        if rec.len() <= max {
            return;
        }
        let mut keys: Vec<(String, f64)> = rec.iter().map(|(k, v)| (k.clone(), ms(v))).collect();
        keys.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        for (k, _) in keys.into_iter().take(rec.len() - max) {
            rec.remove(&k);
        }
    }
    trim(&mut b.tracks, MAX_TRACKS, |t| t.ms);
    trim(&mut b.artists, MAX_NAMES, |a| a.ms);
    trim(&mut b.albums, MAX_NAMES, |a| a.ms);
}

impl Stats {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Inner::default()) }
    }

    fn load(&self, persist: &Persist, inner: &mut Inner) {
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        let raw = persist.read(HISTORY_STORE);
        for b in raw.pointer("/state/buckets").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
            if let Ok(mut bucket) = serde_json::from_value::<MonthBucket>(b) {
                let valid = regex::Regex::new(r"^\d{4}-\d{2}$").unwrap().is_match(&bucket.month);
                if !valid {
                    continue;
                }
                if bucket.hours.len() != 24 {
                    bucket.hours = vec![0.0; 24];
                }
                inner.open.insert(bucket.month.clone(), bucket);
            }
        }
    }

    pub fn note_track_start(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.rule_ms.remove(id);
        inner.rule_counted.remove(id);
    }

    pub fn record(&self, persist: &Persist, track: &Track, listened_ms: f64) {
        if track.id.is_empty() || listened_ms <= 0.0 || !listened_ms.is_finite() {
            return;
        }
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        self.load(persist, inner);
        let now = Local::now();
        let month = month_key(now.year(), now.month());
        let day = format!("{month}-{:02}", now.day());
        let at = now.timestamp_millis() as f64;
        let b = inner.open.entry(month.clone()).or_insert_with(|| MonthBucket::new(&month));
        let t = b.tracks.entry(track.id.clone()).or_insert_with(|| TrackEntry {
            title: track.title.clone(),
            artist: track.artist.clone(),
            thumb: track.thumb.clone(),
            ..Default::default()
        });
        t.title = track.title.clone();
        t.artist = track.artist.clone();
        if !track.thumb.is_empty() {
            t.thumb = track.thumb.clone();
        }
        t.ms += listened_ms;
        t.last_at = at;
        let artist_name = if track.artist.is_empty() { "Unknown artist".to_string() } else { track.artist.clone() };
        let key = artist_name.to_lowercase();
        let a = b.artists.entry(key.clone()).or_insert_with(|| NameEntry { name: artist_name.clone(), ..Default::default() });
        a.name = artist_name.clone();
        a.ms += listened_ms;
        if a.thumb.is_none() {
            a.thumb = track.artist_image.clone();
        }
        let album_key = track.album.as_ref().filter(|al| !al.is_empty()).map(|al| format!("{}|{key}", al.to_lowercase()));
        if let (Some(ak), Some(album)) = (&album_key, &track.album) {
            let al = b.albums.entry(ak.clone()).or_insert_with(|| NameEntry {
                name: album.clone(),
                artist: Some(track.artist.clone()),
                ..Default::default()
            });
            al.ms += listened_ms;
            if al.thumb.is_none() && !track.thumb.is_empty() {
                al.thumb = Some(track.thumb.clone());
            }
        }
        if b.hours.len() != 24 {
            b.hours = vec![0.0; 24];
        }
        b.hours[now.hour() as usize] += listened_ms;
        *b.days.entry(day).or_insert(0.0) += listened_ms;

        if !inner.rule_counted.contains(&track.id) {
            let listened = inner.rule_ms.get(&track.id).copied().unwrap_or(0.0) + listened_ms;
            inner.rule_ms.insert(track.id.clone(), listened);
            let dur_ms = if track.duration > 0.0 { track.duration * 1000.0 } else { PLAY_FLOOR_MS };
            let threshold = (dur_ms / 2.0).max(PLAY_FLOOR_MS).min(PLAY_CEILING_MS);
            if listened >= threshold {
                inner.rule_counted.insert(track.id.clone());
                let b = inner.open.get_mut(&month).unwrap();
                if let Some(t) = b.tracks.get_mut(&track.id) {
                    t.plays += 1.0;
                }
                if let Some(a) = b.artists.get_mut(&key) {
                    a.plays += 1.0;
                }
                if let Some(ak) = &album_key {
                    if let Some(al) = b.albums.get_mut(ak) {
                        al.plays += 1.0;
                    }
                }
            }
        }
        if let Some(b) = inner.open.get_mut(&month) {
            prune_bucket(b);
        }
        inner.dirty = true;
    }

    /// The store payload to write, when anything changed since the last flush.
    pub fn take_dirty_payload(&self) -> Option<Value> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.dirty {
            return None;
        }
        let cutoff = cutoff_key();
        inner.open.retain(|m, _| *m >= cutoff);
        inner.dirty = false;
        let buckets: Vec<&MonthBucket> = inner.open.values().collect();
        Some(json!({ "state": { "buckets": buckets }, "version": 1 }))
    }

    pub fn reset(&self) {
        *self.inner.lock().unwrap() = Inner::default();
    }

    pub fn summary(&self, persist: &Persist, period: &str) -> Value {
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        self.load(persist, inner);
        let now = Local::now();
        let months: Vec<String> = match period {
            "lastMonth" => {
                let total = now.year() * 12 + now.month0() as i32 - 1;
                vec![month_key(total.div_euclid(12), (total.rem_euclid(12) + 1) as u32)]
            }
            "year" => (1..=now.month()).map(|m| month_key(now.year(), m)).collect(),
            "all" => inner.open.keys().cloned().collect(),
            _ => vec![month_key(now.year(), now.month())],
        };
        let period = if ["month", "lastMonth", "year", "all"].contains(&period) { period } else { "month" };
        let mut tracks: HashMap<String, (TrackEntry, String)> = HashMap::new();
        let mut artists: HashMap<String, NameEntry> = HashMap::new();
        let mut albums: HashMap<String, NameEntry> = HashMap::new();
        let mut hours = vec![0.0f64; 24];
        let mut days: BTreeMap<String, f64> = BTreeMap::new();
        let (mut total_ms, mut plays) = (0.0, 0.0);
        for b in months.iter().filter_map(|m| inner.open.get(m)) {
            for (id, t) in &b.tracks {
                let cur = tracks.entry(id.clone()).or_insert_with(|| (TrackEntry { ms: 0.0, plays: 0.0, ..t.clone() }, id.clone()));
                cur.0.ms += t.ms;
                cur.0.plays += t.plays;
                if t.last_at > cur.0.last_at {
                    cur.0.title = t.title.clone();
                    cur.0.artist = t.artist.clone();
                    if !t.thumb.is_empty() {
                        cur.0.thumb = t.thumb.clone();
                    }
                    cur.0.last_at = t.last_at;
                }
                plays += t.plays;
                total_ms += t.ms;
            }
            for (k, a) in &b.artists {
                if k == "unknown artist" {
                    continue;
                }
                let cur = artists.entry(k.clone()).or_insert_with(|| NameEntry { ms: 0.0, plays: 0.0, ..a.clone() });
                cur.ms += a.ms;
                cur.plays += a.plays;
            }
            for (k, al) in &b.albums {
                let cur = albums.entry(k.clone()).or_insert_with(|| NameEntry { ms: 0.0, plays: 0.0, ..al.clone() });
                cur.ms += al.ms;
                cur.plays += al.plays;
            }
            for h in 0..24 {
                hours[h] += b.hours.get(h).copied().unwrap_or(0.0);
            }
            for (d, ms) in &b.days {
                *days.entry(d.clone()).or_insert(0.0) += ms;
            }
        }
        let by_ms = |a: f64, b: f64| b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal);
        let artist_count: HashSet<String> = artists.keys().flat_map(|k| credit_names(k)).collect();
        let counts = json!({ "tracks": tracks.len(), "artists": artist_count.len(), "albums": albums.len() });
        let mut track_list: Vec<Value> = {
            let mut v: Vec<&(TrackEntry, String)> = tracks.values().collect();
            v.sort_by(|a, b| by_ms(a.0.ms, b.0.ms));
            v.into_iter()
                .take(50)
                .map(|(t, id)| {
                    let mut j = serde_json::to_value(t).unwrap();
                    j["id"] = json!(id);
                    j
                })
                .collect()
        };
        track_list.truncate(50);
        let mut artist_list: Vec<&NameEntry> = artists.values().collect();
        artist_list.sort_by(|a, b| by_ms(a.ms, b.ms));
        let mut album_list: Vec<&NameEntry> = albums.values().collect();
        album_list.sort_by(|a, b| by_ms(a.ms, b.ms));
        json!({
            "totalMs": total_ms,
            "plays": plays,
            "tracks": track_list,
            "artists": artist_list.into_iter().take(50).collect::<Vec<_>>(),
            "albums": album_list.into_iter().take(50).collect::<Vec<_>>(),
            "hours": hours,
            "days": days.into_iter().map(|(date, ms)| json!({ "date": date, "ms": ms })).collect::<Vec<_>>(),
            "period": period,
            "months": months,
            "counts": counts,
        })
    }
}
