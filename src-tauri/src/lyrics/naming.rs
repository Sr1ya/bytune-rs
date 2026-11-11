//! Naming the playing recording — ByTune's lyrics.ts title cleaning and `namesRecording`.
//!
//! Every source that searches by name must name the playing recording before its words are used: the
//! same song, the same version words ("Live", "Remix", "Sped Up", "Versión Pop"…) and a shared artist.
//! A miss is recoverable — the next source gets its turn — and the wrong words scrolling in time with
//! the right song are not. Names are read the way catalogues write them: Traditional and Simplified
//! Chinese alike, an artist in another script by the entry's length, "(Album Version)" as a label,
//! "Artist - Song (Lyrics)" uploads by their dash, and the playing release's own entry for its title
//! track.

use crate::han_fold::fold_han;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

/// How far a hit's length may be from the playing track's (BitChord's figure, ByTune's LRCRED_TOLERANCE_SEC).
pub const LENGTH_TOLERANCE_SEC: f64 = 3.0;

pub const PLACEHOLDER_ARTISTS: &[&str] = &["", "unknown artist", "unknown", "various artists", "artist"];

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}
fn fre(p: &str) -> fancy_regex::Regex {
    fancy_regex::Regex::new(p).unwrap()
}

/* ---------------------------- titles and credits ---------------------------- */

/// YouTube's auto-generated channels for licensed music are "Artist - Topic".
pub fn untopic(artist: &str) -> String {
    static TOPIC: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s+-\s+Topic\s*$"));
    TOPIC.replace(artist, "").to_string()
}

/// The artist every source is asked with: the whole credit, " - Topic" off, placeholders empty.
pub fn search_artist(artist: &str) -> String {
    let credit = untopic(artist).trim().to_string();
    if PLACEHOLDER_ARTISTS.contains(&credit.to_lowercase().as_str()) {
        String::new()
    } else {
        credit
    }
}

/// The credit as a list ("A, B, C") and as YouTube's "A, B & C": both are tried, the list first.
pub fn credit_forms(artist: &str) -> Vec<String> {
    let credit = search_artist(artist);
    let list = match credit.rfind(" & ") {
        Some(i) => format!("{}, {}", &credit[..i], &credit[i + 3..]),
        None => credit.clone(),
    };
    if list == credit {
        vec![credit]
    } else {
        vec![list, credit]
    }
}

/// How far a matched rendition's own runtime may sit from the playing track before they're different edits.
pub fn within_tolerance(record_sec: Option<f64>, playing_sec: f64) -> bool {
    match record_sec {
        Some(r) if r > 0.0 && playing_sec > 0.0 => (r - playing_sec).abs() <= 12f64.max(playing_sec * 0.08),
        _ => true,
    }
}

/// Strip the noise YouTube titles carry: "(Official Video)", "[HD]", " - Lyrics", "M/V", "歌詞"…
pub fn clean_title(title: &str) -> String {
    static A: Lazy<Regex> = Lazy::new(|| re(r"(?i)\((official\s+)?(music\s+)?(lyrics?\s+)?(video|audio|visualizer?|mv)\)"));
    static B: Lazy<Regex> = Lazy::new(|| re(r"(?i)\[(official\s+)?(music\s+)?(lyrics?\s+)?(video|audio|hd|4k)\]"));
    // A label tail ("- Official Video HD", "- Lyrics (HD)"), never a song that starts with the word ("- Video Games").
    static C: Lazy<fancy_regex::Regex> = Lazy::new(|| {
        fre(r"(?i)\s*-\s*(?:official\s+)?(?:music\s+)?(?:lyrics?|lyrical|audio|video|visuali[sz]er|mv)\b(?=\s*(?:$|[-–—|(\[/&+:]|(?:official|oficial|music|lyrics?|lyrical|audio|video|visuali[sz]er|song|mv|hd|hq|4k)\b)).*$")
    });
    static D: Lazy<Regex> = Lazy::new(|| re(r"\|.*$"));
    // A K-pop upload's closing tag: "GANGNAM STYLE(강남스타일) M/V".
    static E: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s+(?:official\s+)?m/?v\s*$"));
    // An upload's unbracketed lyric label: "周杰倫 - 告白氣球 歌詞", "Artist - Song Lyrics".
    static F: Lazy<Regex> = Lazy::new(|| re(r"(?i)^(.+\s-\s.+?)\s+(?:with\s+)?(?:lyrics?|letra|歌詞|歌词|가사)\s*$"));
    let t = A.replace_all(title, "");
    let t = B.replace_all(&t, "");
    let t = C.replace(&t, "").to_string();
    let t = D.replace(&t, "");
    let t = E.replace(&t, "");
    let t = F.replace(&t, "$1");
    t.trim().to_string()
}

/// Title for provider queries: brackets of any kind dropped.
pub fn query_title(title: &str) -> String {
    static BR: Lazy<Regex> = Lazy::new(|| re(r"\([^)]*\)|\[[^\]]*]"));
    let cleaned = clean_title(title);
    let base = BR.replace_all(&cleaned, "").split_whitespace().collect::<Vec<_>>().join(" ");
    if base.is_empty() {
        cleaned
    } else {
        base
    }
}

/// The title as a catalogue files it: credits and upload labels off, everything else ("(Live)",
/// "(Remix)", "(From …)") kept, so the search asks for this recording rather than another one.
pub fn search_title(title: &str) -> String {
    static FEAT_BR: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]"));
    static FEAT_TAIL: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s(?:feat\.?|ft\.?|featuring)\s.*$"));
    static LABEL: Lazy<Regex> = Lazy::new(|| {
        re(r"(?i)\s*[(\[]\s*(?:official\s*)?(?:music\s*)?(?:hd\s*)?(?:video|audio|visuali[sz]er|lyrics?\s*video|lyrics?|m/?v|hd|hq|4k|full\s*song|official)\s*[)\]]")
    });
    static TAIL: Lazy<Regex> = Lazy::new(|| re(r"[\s,–—-]+$"));
    let cleaned = clean_title(title);
    let t = FEAT_BR.replace_all(&cleaned, " ");
    let t = FEAT_TAIL.replace(&t, " ");
    let t = LABEL.replace_all(&t, " ");
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = TAIL.replace(&t, "").trim().to_string();
    if t.is_empty() {
        cleaned
    } else {
        t
    }
}

/// Lower case, Latin accents folded ("Versión" → "version"), Chinese in its Simplified form, only
/// letters, marks and digits — Indic vowel signs and kana marks stay.
pub fn plain_words(s: &str) -> String {
    static NON_WORD: Lazy<Regex> = Lazy::new(|| re(r"[^\p{L}\p{M}\p{N}]+"));
    let folded: String = s.nfkd().filter(|c| !('\u{0300}'..='\u{036f}').contains(c)).collect::<String>().to_lowercase();
    fold_han(NON_WORD.replace_all(&folded, " ").trim())
}

/* ----------------------------- recording names ----------------------------- */

/// Words that, in brackets or after a " - ", name a different recording rather than a different label.
const VERSION_WORDS: &[&str] = &[
    "live", "vivo", "directo", "concierto", "concert", "remix", "remixed", "rmx", "mix", "mixed", "mashup", "bootleg",
    "flip", "rework", "vip", "dj", "edit", "extended", "intro", "outro", "acoustic", "acustico", "acustica", "unplugged",
    "instrumental", "inst", "karaoke", "cappella", "acapella", "demo", "maqueta", "take", "outtake", "alternate",
    "rehearsal", "session", "sessions", "version", "ver", "cover", "sped", "speed", "slowed", "slow", "reverb",
    "nightcore", "daycore", "lofi", "chopped", "screwed", "8d", "orchestral", "symphonic", "reprise", "pt", "part",
];
/// One token per kind of version, in any language: "(En Vivo)" meets "(Live)", "演唱會" meets "现场".
const VERSION_SAME: &[(&str, &str)] = &[
    ("vivo", "live"), ("directo", "live"), ("concierto", "live"), ("concert", "live"), ("演唱会", "live"),
    ("演唱會", "live"), ("音乐会", "live"), ("音樂會", "live"), ("现场", "live"), ("現場", "live"), ("ライブ", "live"),
    ("라이브", "live"), ("acustico", "acoustic"), ("acustica", "acoustic"), ("maqueta", "demo"),
];
/// Qualifiers that only label a release: "(Album Version)", "(Main Version - Clean)".
const LABEL_WORDS: &[&str] = &["album", "main", "single", "lp", "original", "explicit", "clean", "studio", "mono", "stereo"];
const NOT_A_NAME_EXTRA: &[&str] = &["originally", "performed", "famous", "style", "tribute", "prod", "produced", "official"];

static VERSION_MARKS: Lazy<Regex> = Lazy::new(|| {
    re(r"(?i)演唱会|演唱會|音乐会|音樂會|라이브|版|现场|現場|混音|伴奏|翻唱|纯音乐|純音樂|片段|剪辑|剪輯|铃声|鈴聲|抖音|倍速|加速|降速|慢速|ライブ|リミックス|アコースティック|カラオケ|インスト|バージョン|\b[0-9]+(?:\.[0-9]+)?x\b")
});
static LABEL_BAN: Lazy<Regex> = Lazy::new(|| re(r"^(?:唱片|录音室|錄音室|正式|原)$"));
/// A tempo edit sings the same words at another speed.
static TEMPO_EDIT: Lazy<Regex> = Lazy::new(|| re(r"(?i)\b(?:sped|speed|slowed|slow|reverb|nightcore|daycore|8d|lo-?fi|chopped|screwed)\b"));
/// A bracket, one level of brackets inside it included.
static NAME_BRACKETS: Lazy<Regex> =
    Lazy::new(|| re(r"[(\[【「](?:[^()\[\]【】「」]|[(\[【「][^()\[\]【】「」]*[)\]】」])*[)\]】」]"));
static CREDIT_GROUP: Lazy<Regex> = Lazy::new(|| re(r"(?i)^.\s*(?:feat\.?|ft\.?|featuring|with|from|prod\.?|produced\s+by)\s"));
static LATIN: Lazy<Regex> = Lazy::new(|| re(r"\p{Latin}"));
static HAN: Lazy<Regex> = Lazy::new(|| re(r"\p{Han}"));
static HANGUL: Lazy<Regex> = Lazy::new(|| re(r"\p{Hangul}"));
static KANA: Lazy<Regex> = Lazy::new(|| re(r"[\p{Hiragana}\p{Katakana}]"));
static LETTER: Lazy<Regex> = Lazy::new(|| re(r"\p{L}"));
static FEAT_TAIL: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s(?:feat\.?|ft\.?|featuring)\s.*$"));

fn is_version_word(w: &str) -> bool {
    VERSION_WORDS.contains(&w)
}
fn is_ver(w: &str) -> bool {
    w == "version" || w == "ver"
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordingName {
    /// The song's own name: brackets, an unbracketed "feat." and anything after " - " left out.
    pub core: String,
    /// The same name in another script, from a bracket ("봄날 (Spring Day)").
    pub aliases: Vec<String>,
    /// Its version words, sorted — "" for the plain recording.
    pub versions: String,
}

/// "Song (Live) [feat. X] - 2011 Remaster" → core "song", versions "live". `plain_text`: untimed words
/// don't care how fast they are sung, so a tempo edit's group names nothing.
pub fn recording_name(title: &str, plain_text: bool) -> RecordingName {
    let name: String = clean_title(title).nfkc().collect();
    let groups: Vec<String> = NAME_BRACKETS.find_iter(&name).map(|m| m.as_str().to_string()).collect();
    let mut core = NAME_BRACKETS.replace_all(&name, " ").to_string();
    let mut tail = String::new();
    if let Some(dash) = core.find(" - ") {
        tail = core[dash + 3..].to_string();
        core.truncate(dash);
    }
    let mut core = plain_words(&FEAT_TAIL.replace(&core, ""));
    if core.is_empty() {
        core = plain_words(&name);
    }
    let mut versions: BTreeSet<String> = BTreeSet::new();
    let mut aliases = Vec::new();
    let parts: Vec<&String> = groups.iter().chain(std::iter::once(&tail)).collect();
    for part in parts {
        if part.trim().is_empty() || CREDIT_GROUP.is_match(part) {
            continue;
        }
        let remaster = part.to_lowercase().contains("remaster");
        let tempo = plain_text && TEMPO_EDIT.is_match(part);
        // "Live版" → "live 版", "Lo-Fi" → "lofi": a word glued to a mark, or split by a hyphen, still counts.
        let mut spaced = String::new();
        let mut prev: Option<char> = None;
        for c in plain_words(part).chars() {
            if let Some(p) = prev {
                if LATIN.is_match(&p.to_string()) && HAN.is_match(&c.to_string()) {
                    spaced.push(' ');
                }
            }
            spaced.push(c);
            prev = Some(c);
        }
        let mut all: Vec<String> = Vec::new();
        for w in spaced.split(' ').filter(|w| !w.is_empty()) {
            if w == "fi" && all.last().map(|l| l == "lo").unwrap_or(false) {
                all.pop();
                all.push("lofi".into());
            } else {
                all.push(w.to_string());
            }
        }
        let found: Vec<String> = VERSION_MARKS.find_iter(part).map(|m| m.as_str().to_string()).collect();
        let mut words: Vec<String> = all
            .iter()
            .filter(|w| is_version_word(w) && !is_ver(w) && !(tempo && (TEMPO_EDIT.is_match(w) || *w == "edit")))
            .cloned()
            .collect();
        let mut marks: Vec<String> = found.iter().filter(|m| m.as_str() != "版").cloned().collect();
        if words.is_empty() && marks.is_empty() && !remaster && !tempo {
            // "(X Version)" alone: X names the version, unless it only labels the release.
            let qualifier: BTreeSet<&String> = all.iter().filter(|w| !is_ver(w) && !LABEL_WORDS.contains(&w.as_str())).collect();
            if !qualifier.is_empty() && all.iter().any(|w| is_ver(w)) {
                words.push(format!("version:{}", qualifier.into_iter().map(|s| s.as_str()).collect::<Vec<_>>().join("+")));
            }
            // "(X版)" the same, X glued to 版: 粤语版 ≠ 国语版, and 唱片版 is a label.
            if found.iter().any(|m| m == "版") {
                static BAN: Lazy<Regex> = Lazy::new(|| re(r"([^\s()\[\]【】「」]*?)版"));
                for m in BAN.captures_iter(part) {
                    let x: String = plain_words(&m[1]).chars().filter(|c| !c.is_whitespace()).collect();
                    if !x.is_empty() && !LABEL_BAN.is_match(&x) {
                        marks.push(format!("版:{x}"));
                    }
                }
            }
        }
        for w in words.iter().chain(marks.iter()) {
            let lower = w.to_lowercase();
            let same = VERSION_SAME.iter().find(|(k, _)| *k == lower).map(|(_, v)| v.to_string());
            versions.insert(same.unwrap_or(lower));
        }
        // A bracket in another script that names no version is the title, translated.
        let named = all.iter().any(|w| is_version_word(w)) || !found.is_empty();
        if *part != tail && !named && LETTER.is_match(part) && LATIN.is_match(part) != LATIN.is_match(&core) {
            let alias = plain_words(part);
            if !alias.is_empty() {
                aliases.push(alias);
            }
        }
    }
    RecordingName { core, aliases, versions: versions.into_iter().collect::<Vec<_>>().join(" ") }
}

static ARTIST_SPLIT: Lazy<Regex> =
    Lazy::new(|| re(r"(?i)\s*(?:,|;|/|&|\+|、|，|\s(?:and|x|×|with|feat\.?|ft\.?|featuring|vs\.?)\s)\s*"));
static CREDIT_LEAD: Lazy<Regex> = Lazy::new(|| re(r"(?i)^\s*(?:feat\.?|ft\.?|featuring|with)\s+"));

/// Credited artists, normalised: "A, B & C", "A x B", "A、B", "A feat. B", and a bracket's names
/// ("(Ft. A & B)", "버스커 버스커 (Busker Busker)") unless the bracket describes the recording.
pub fn artist_names(artist: &str) -> Vec<String> {
    let name: String = untopic(artist).nfkc().collect();
    let outside_text = NAME_BRACKETS.replace_all(&name, " ").to_string();
    let mut out: Vec<String> = ARTIST_SPLIT.split(&outside_text).map(plain_words).collect();
    for m in NAME_BRACKETS.find_iter(&name) {
        let chars: Vec<char> = m.as_str().chars().collect();
        let inner: String = chars[1..chars.len() - 1].iter().collect();
        let describes = plain_words(&inner).split(' ').any(|w| is_version_word(w) || NOT_A_NAME_EXTRA.contains(&w));
        if !CREDIT_LEAD.is_match(&inner) && describes {
            continue;
        }
        for a in ARTIST_SPLIT.split(&CREDIT_LEAD.replace(&inner, "")) {
            let a = plain_words(a);
            if a.chars().count() > 1 && LETTER.is_match(&a) {
                out.push(a);
            }
        }
    }
    out.into_iter().filter(|a| !a.is_empty() && !PLACEHOLDER_ARTISTS.contains(&a.as_str())).collect()
}

/// Whether two credit lists share an artist — whole names, either way round.
pub fn share_artist(a: &[String], b: &[String]) -> bool {
    let within = |name: &str, list: &[String]| list.iter().any(|other| format!(" {other} ").contains(&format!(" {name} ")));
    a.iter().any(|x| within(x, b)) || b.iter().any(|y| within(y, a))
}

pub fn same_name(a: &RecordingName, b: &RecordingName) -> bool {
    a.versions == b.versions && std::iter::once(&a.core).chain(a.aliases.iter()).any(|x| *x == b.core || b.aliases.contains(x))
}

/// Whether two credit lists share a script — "Eason Chan" and "陈奕迅" don't, so no test can compare them.
fn comparable(a: &[String], b: &[String]) -> bool {
    let scripts: [&Lazy<Regex>; 4] = [&LATIN, &HAN, &HANGUL, &KANA];
    let used = |names: &[String]| -> Vec<usize> { (0..4).filter(|&i| names.iter().any(|n| scripts[i].is_match(n))).collect() };
    let x = used(a);
    let y = used(b);
    x.is_empty() || y.is_empty() || x.iter().any(|i| y.contains(i))
}

/// What a name is checked against: the playing track.
#[derive(Clone, Copy)]
pub struct Playing<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    /// seconds, 0 = unknown
    pub duration: f64,
}

/// Whether a catalogue entry names the playing recording: the same song once credits and labels are
/// gone, the same version words on both sides, and a shared artist (skipped when either side has no
/// real credit, or when the credits are in scripts that can't be compared but the entry's own
/// `length` matches). An "Artist - Song" upload also reads as the song after the dash.
pub fn names_recording(name: &str, artist: &str, q: Playing, length: Option<f64>, plain_text: bool) -> bool {
    static FEAT_INNER: Lazy<fancy_regex::Regex> = Lazy::new(|| fre(r"(?i)\s(?:feat\.?|ft\.?|featuring)\s.*?(?=\s-\s|[(\[]|$)"));
    static UPLOAD_LABEL: Lazy<Regex> = Lazy::new(|| {
        re(r"(?i)\s*[(\[]\s*(?:(?:official|oficial|music|lyrics?|letra|lyrical|video|audio|visuali[sz]er|mv|hd|hq|4k|with|and|y)\b[\s/&+,-]*)+[)\]]")
    });
    static FOREIGN_BRACKET: Lazy<Regex> = Lazy::new(|| re(r"[(\[【「][^\p{Latin}0-9()\[\]【】「」]*[)\]】」]"));
    static PIPE: Lazy<Regex> = Lazy::new(|| re(r"[|｜]"));
    static BRACKET_OR_DASH: Lazy<Regex> = Lazy::new(|| re(r"[(\[【「]| - "));
    static LATIN_OR_DIGIT: Lazy<Regex> = Lazy::new(|| re(r"[\p{Latin}0-9]"));

    let title: String = clean_title(q.title).nfkc().collect();
    let their_name = recording_name(name, plain_text);
    let theirs = artist_names(artist);
    let mine = artist_names(q.artist);
    let length = length.unwrap_or(0.0);
    let uncheckable = !comparable(&mine, &theirs) && length > 0.0 && q.duration > 0.0 && (length - q.duration).abs() <= LENGTH_TOLERANCE_SEC;
    let credited = mine.is_empty() || theirs.is_empty() || uncheckable || share_artist(&mine, &theirs);
    if credited && same_name(&recording_name(&title, plain_text), &their_name) {
        return true;
    }
    let Some(dash) = title.find(" - ").filter(|d| *d > 0) else { return false };
    if theirs.is_empty() {
        return false;
    }
    let lead = artist_names(&title[..dash]);
    let rest = &title[dash + 3..];
    let labels = FEAT_INNER.replace(rest, " ").to_string();
    let labels = UPLOAD_LABEL.replace_all(&labels, " ");
    let labels = FOREIGN_BRACKET.replace_all(&labels, " ");
    let bare = !PIPE.is_match(q.title)
        && !BRACKET_OR_DASH.is_match(&search_title(&labels))
        && !NAME_BRACKETS.find_iter(&title[..dash]).any(|g| LATIN_OR_DIGIT.is_match(g.as_str()));
    (credited || bare) && !lead.is_empty() && share_artist(&lead, &theirs) && same_name(&recording_name(rest, plain_text), &their_name)
}

/// An album name without the store's " - Single" / " - EP" suffix.
pub fn release_name(album: &str) -> String {
    static SUFFIX: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s+[-–]\s+(?:single|ep)\s*$"));
    SUFFIX.replace(&clean_title(album), "").to_string()
}

/// An entry of the playing release named as the release is, when the playing title is that name
/// without its version words: YT Music files the single "Despacito (Versión Pop)" as "Despacito".
pub fn names_release_recording(name: &str, artist: &str, album: Option<&str>, q: Playing, q_album: Option<&str>) -> bool {
    let Some(q_album) = q_album.filter(|a| !a.is_empty()) else { return false };
    if plain_words(&release_name(album.unwrap_or(""))) != plain_words(&release_name(q_album)) {
        return false;
    }
    let release = release_name(q_album);
    let r = recording_name(&release, false);
    let t = recording_name(q.title, false);
    !r.versions.is_empty()
        && t.versions.is_empty()
        && r.core == t.core
        && names_recording(name, artist, Playing { title: &release, artist: q.artist, duration: 0.0 }, None, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q<'a>(title: &'a str, artist: &'a str) -> Playing<'a> {
        Playing { title, artist, duration: 200.0 }
    }

    #[test]
    fn versions_must_agree() {
        assert!(names_recording("Despacito", "Luis Fonsi", q("Despacito (Official Video)", "Luis Fonsi, Daddy Yankee"), None, false));
        assert!(!names_recording("Despacito (Remix)", "Luis Fonsi", q("Despacito", "Luis Fonsi"), None, false));
        assert!(names_recording("Song (Live)", "A", q("Song (En Vivo)", "A"), None, false));
        assert!(names_recording("Song (2011 Remaster)", "A", q("Song", "A"), None, false));
        assert!(!names_recording("Song (Sped Up)", "A", q("Song", "A"), None, false));
        assert!(names_recording("Song (Sped Up)", "A", q("Song", "A"), None, true));
    }

    #[test]
    fn artists_and_scripts() {
        assert!(!names_recording("Hello", "Someone Else", q("Hello", "Adele"), None, false));
        assert!(names_recording("告白氣球", "周杰倫", q("告白气球", "周杰伦"), None, false));
        assert!(names_recording("Song", "陈奕迅", q("Song", "Eason Chan"), Some(201.0), false));
        assert!(!names_recording("Song", "陈奕迅", q("Song", "Eason Chan"), Some(240.0), false));
        assert!(names_recording("Wake Me Up", "Avicii", q("Avicii - Wake Me Up (Lyrics)", "7clouds"), None, false));
    }

    #[test]
    fn titles() {
        assert_eq!(clean_title("Song - Official Video HD"), "Song");
        assert_eq!(clean_title("Video Games"), "Video Games");
        assert_eq!(search_title("Song (feat. X) [Official Video]"), "Song");
        assert_eq!(credit_forms("A, B & C"), vec!["A, B, C".to_string(), "A, B & C".to_string()]);
        assert_eq!(plain_words("Versión  Señorita!"), "version senorita");
    }
}
