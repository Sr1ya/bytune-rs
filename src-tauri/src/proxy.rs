//! Local 127.0.0.1 streaming proxy — a port of ByTune's `electron/stream-proxy.ts`.
//!
//! The UI's `<audio>` element plays from here rather than from googlevideo or
//! `file://`: the backend does the upstream traffic (with re-resolution on a
//! 403), sends `Access-Control-Allow-Origin: *` so Web Audio (EQ, analysis)
//! can read the samples, and serves local and downloaded files with HTTP ranges.
//!
//!   /?id=<videoId>[&kbps=N][&retry=x][&meta=1]   YouTube Music track
//!   /?lid=<local:id>                              local library file

use crate::music::BoundedMap;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::routing::get;
use axum::Router;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const PASSTHROUGH: &[&str] = &["content-type", "content-length", "content-range", "accept-ranges"];

pub struct ProxyShared {
    /// Which rendition (itag:clen) each request URL first got — a range into a different file is refused.
    served: Mutex<BoundedMap<String>>,
}

pub async fn start(state: Arc<AppState>) -> anyhow::Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let shared = Arc::new(ProxyShared { served: Mutex::new(BoundedMap::new(500)) });
    let app = Router::new().route("/", get(handle)).with_state((state, shared));
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("stream proxy stopped: {e}");
        }
    });
    log::info!("stream proxy on 127.0.0.1:{port}");
    Ok(port)
}

pub fn url_for(port: u16, track_id: &str, retry: bool, max_kbps: Option<u32>) -> String {
    let kbps = max_kbps.filter(|k| *k > 0).map(|k| format!("&kbps={k}")).unwrap_or_default();
    let retry = if retry { format!("&retry={:x}", chrono::Utc::now().timestamp_millis()) } else { String::new() };
    format!("http://127.0.0.1:{port}/?id={}{retry}{kbps}", urlencoding::encode(track_id))
}

pub fn url_for_local(port: u16, local_id: &str) -> String {
    format!("http://127.0.0.1:{port}/?lid={}", urlencoding::encode(local_id))
}

fn cors(mut res: Response<Body>) -> Response<Body> {
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn status(code: StatusCode) -> Response<Body> {
    cors(Response::builder().status(code).body(Body::empty()).unwrap())
}

fn json_response(code: StatusCode, body: serde_json::Value) -> Response<Body> {
    cors(Response::builder().status(code).header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())).unwrap())
}

fn allowed(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let host_ok = host.is_empty() || {
        let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
        matches!(name, "127.0.0.1" | "localhost" | "[::1]")
    };
    if !host_ok {
        return false;
    }
    match headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        None | Some("null") => true,
        Some(origin) => {
            let re = regex::Regex::new(r"^(https?://(127\.0\.0\.1|localhost)(:\d+)?|tauri://localhost|https?://tauri\.localhost)$").unwrap();
            re.is_match(origin)
        }
    }
}

async fn handle(
    State((state, shared)): State<(Arc<AppState>, Arc<ProxyShared>)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response<Body> {
    if !allowed(&headers) {
        return status(StatusCode::FORBIDDEN);
    }
    let range = headers.get(header::RANGE).and_then(|r| r.to_str().ok()).map(String::from);
    if let Some(lid) = q.get("lid") {
        return serve_file(state.local_stream_path(lid).as_deref(), range.as_deref()).await;
    }
    let Some(track_id) = q.get("id").cloned() else { return status(StatusCode::BAD_REQUEST) };
    let max_kbps = q.get("kbps").and_then(|k| k.parse::<u32>().ok()).filter(|k| *k > 0);
    let meta = q.get("meta").map(|m| m == "1").unwrap_or(false);
    let key = {
        let mut keys: Vec<_> = q.iter().filter(|(k, _)| k.as_str() != "meta").collect();
        keys.sort();
        keys.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
    };

    // A downloaded song plays from its file.
    if let Some(file) = state.downloaded_file(&track_id) {
        if meta {
            return json_response(StatusCode::OK, serde_json::json!({ "lufs": null }));
        }
        let identity = format!("file:{file}");
        if refuse_range(&shared, &key, range.as_deref(), &identity) {
            return status(StatusCode::CONFLICT);
        }
        return serve_file(Some(&file), range.as_deref()).await;
    }

    if meta {
        return match state.music.resolve_stream(&track_id, false, max_kbps, false).await {
            Ok(s) => json_response(StatusCode::OK, serde_json::json!({ "lufs": s.lufs })),
            Err(e) => {
                log::warn!("proxy meta error: {e}");
                json_response(StatusCode::BAD_GATEWAY, serde_json::json!({ "lufs": null }))
            }
        };
    }

    let mut stream = match state.music.resolve_stream(&track_id, false, max_kbps, false).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("proxy resolve error for {track_id}: {e}");
            return status(StatusCode::BAD_GATEWAY);
        }
    };
    let mut upstream = fetch_upstream(&state.music.http, &stream.url, stream.ua, range.as_deref()).await;
    if matches!(&upstream, Ok(r) if r.status() == StatusCode::FORBIDDEN) {
        log::warn!("proxy upstream 403 for {track_id}, re-resolving");
        if let Ok(s) = state.music.resolve_stream(&track_id, true, max_kbps, false).await {
            stream = s;
            upstream = fetch_upstream(&state.music.http, &stream.url, stream.ua, range.as_deref()).await;
        }
    }
    let upstream = match upstream {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            log::warn!("proxy upstream HTTP {} for {track_id}", r.status());
            return status(if r.status() == StatusCode::FORBIDDEN { StatusCode::NOT_FOUND } else { r.status() });
        }
        Err(e) => {
            log::warn!("proxy upstream error for {track_id}: {e}");
            return status(StatusCode::BAD_GATEWAY);
        }
    };
    let identity = format!("{}:{}", stream.itag.map(|i| i.to_string()).unwrap_or("?".into()), stream.clen.map(|c| c.to_string()).unwrap_or("?".into()));
    if refuse_range(&shared, &key, range.as_deref(), &identity) {
        log::warn!("proxy: rendition changed mid-song for {track_id}, refusing the range");
        return status(StatusCode::CONFLICT);
    }

    // The player asked for the whole file but upstream was asked for an open range (see fetch_upstream):
    // answer as the plain 200 it expects, with the full length and no Content-Range.
    // Only when upstream really sent all of it (bytes 0-(T-1)/T): a short 206 stays a 206, or the
    // player would take the part for the whole song.
    let covers_all = upstream
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes 0-"))
        .and_then(|v| v.split_once('/'))
        .and_then(|(end, total)| Some(end.parse::<u64>().ok()? + 1 == total.parse::<u64>().ok()?))
        .unwrap_or(false);
    let whole = range.is_none() && upstream.status() == StatusCode::PARTIAL_CONTENT && covers_all;
    let mut builder = Response::builder().status(if whole { StatusCode::OK } else { upstream.status() });
    for name in PASSTHROUGH {
        if whole && *name == "content-range" {
            continue;
        }
        if let Some(v) = upstream.headers().get(*name) {
            builder = builder.header(*name, v);
        }
    }
    if whole && !upstream.headers().contains_key(header::ACCEPT_RANGES) {
        builder = builder.header(header::ACCEPT_RANGES, "bytes");
    }
    // A stalled upstream (no bytes for 20 s) ends the response so the player can retry.
    let body = upstream.bytes_stream().map(|chunk| chunk.map_err(std::io::Error::other));
    let body = tokio_stream_timeout(body, Duration::from_secs(20));
    cors(builder.body(Body::from_stream(body)).unwrap())
}

/// A later range of the same URL must come from the file the player first opened.
fn refuse_range(shared: &ProxyShared, key: &str, range: Option<&str>, identity: &str) -> bool {
    let mut served = shared.served.lock().unwrap();
    let before = served.get(key);
    if let (Some(range), Some(before)) = (range, before) {
        if !range.starts_with("bytes=0-") && before != identity {
            return true;
        }
    }
    served.insert(key.to_string(), identity.to_string());
    false
}

/// Always ranged: googlevideo throttles a request without a Range header to roughly playback speed
/// (~32 KB/s measured), and WebKitGTK's GStreamer source opens a stream without one, so a song sat
/// buffering for ~8 s before its first sound. An open range comes at full speed.
async fn fetch_upstream(http: &reqwest::Client, url: &str, ua: &str, range: Option<&str>) -> Result<reqwest::Response, String> {
    let req = http.get(url).header("User-Agent", ua).header("Range", range.unwrap_or("bytes=0-"));
    match tokio::time::timeout(Duration::from_secs(20), req.send()).await {
        Ok(Ok(res)) => Ok(res),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("upstream timed out".into()),
    }
}

fn tokio_stream_timeout<S>(stream: S, idle: Duration) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send + 'static,
{
    futures_util::stream::unfold(Box::pin(stream), move |mut s| async move {
        match tokio::time::timeout(idle, s.next()).await {
            Ok(Some(item)) => Some((item, s)),
            Ok(None) => None,
            Err(_) => Some((Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "upstream stalled")), s)),
        }
    })
}

pub fn audio_mime(path: &str) -> &'static str {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg; codecs=opus",
        "webm" | "weba" => "audio/webm",
        _ => "application/octet-stream",
    }
}

/// Serve a file with single-range support (bytes=a-b, a-, -n).
async fn serve_file(path: Option<&str>, range: Option<&str>) -> Response<Body> {
    let Some(path) = path else { return status(StatusCode::NOT_FOUND) };
    let Ok(mut file) = tokio::fs::File::open(path).await else { return status(StatusCode::NOT_FOUND) };
    let Ok(meta) = file.metadata().await else { return status(StatusCode::NOT_FOUND) };
    let size = meta.len();
    let (mut start, mut end, mut code) = (0u64, size.saturating_sub(1), StatusCode::OK);
    let mut builder = Response::builder().header(header::ACCEPT_RANGES, "bytes").header(header::CONTENT_TYPE, audio_mime(path));
    if let Some(r) = range {
        let re = regex::Regex::new(r"^bytes=(\d*)-(\d*)$").unwrap();
        if let Some(c) = re.captures(r.trim()) {
            let (a, b) = (&c[1], &c[2]);
            if !(a.is_empty() && b.is_empty()) {
                if a.is_empty() {
                    let suffix = b.parse::<u64>().unwrap_or(0).min(size);
                    start = size - suffix;
                    end = size.saturating_sub(1);
                } else {
                    start = a.parse().unwrap_or(0);
                    end = if b.is_empty() { size.saturating_sub(1) } else { b.parse::<u64>().unwrap_or(0).min(size.saturating_sub(1)) };
                }
                if start > end || start >= size {
                    return cors(
                        Response::builder()
                            .status(StatusCode::RANGE_NOT_SATISFIABLE)
                            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                            .body(Body::empty())
                            .unwrap(),
                    );
                }
                code = StatusCode::PARTIAL_CONTENT;
                builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
            }
        }
    }
    let len = if size == 0 { 0 } else { end - start + 1 };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let reader = file.take(len);
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(reader));
    cors(builder.status(code).header(header::CONTENT_LENGTH, len.to_string()).body(body).unwrap())
}
