//! A minimal InnerTube client for YouTube Music's browse/search/next endpoints.
//!
//! Browsing needs no sign-in and no PO token: requests go out as the
//! `WEB_REMIX` (music.youtube.com) client with the device market as `gl`.
//! The visitor id YouTube hands back on the first answer is kept and sent
//! with every later request, as the web client does.
//!
//! For stream URLs, `player()` asks as the VISIONOS or ANDROID_VR app client:
//! both answer with plain, fully streamable URLs (no signature deobfuscation,
//! no PO token) — the clients ByTune preferred too. rustypipe is the fallback.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::sync::RwLock;
use std::time::Duration;

pub const UA: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const MUSIC_CLIENT_VERSION: &str = "1.20251103.01.00";
const WEB_CLIENT_VERSION: &str = "2.20251103.00.00";

pub struct InnerTube {
    pub http: reqwest::Client,
    hl: String,
    gl: String,
    visitor: RwLock<Option<String>>,
}

impl InnerTube {
    pub fn new(http: reqwest::Client, hl: String, gl: String) -> Self {
        Self { http, hl, gl, visitor: RwLock::new(None) }
    }

    fn context(&self, web: bool) -> Value {
        let mut client = json!({
            "clientName": if web { "WEB" } else { "WEB_REMIX" },
            "clientVersion": if web { WEB_CLIENT_VERSION } else { MUSIC_CLIENT_VERSION },
            "hl": self.hl,
            "gl": self.gl,
            "platform": "DESKTOP",
            "userAgent": UA,
        });
        if let Some(v) = self.visitor.read().unwrap().clone() {
            client["visitorData"] = Value::String(v);
        }
        json!({ "client": client, "user": { "lockedSafetyMode": false } })
    }

    async fn post_as(&self, endpoint: &str, mut body: Value, web: bool) -> Result<Value> {
        body["context"] = self.context(web);
        let (host, origin, client_name, version) = if web {
            ("www.youtube.com", "https://www.youtube.com", "1", WEB_CLIENT_VERSION)
        } else {
            ("music.youtube.com", "https://music.youtube.com", "67", MUSIC_CLIENT_VERSION)
        };
        let url = format!("https://{host}/youtubei/v1/{endpoint}?prettyPrint=false");
        let mut req = self
            .http
            .post(&url)
            .timeout(Duration::from_secs(15))
            .header("User-Agent", UA)
            .header("Origin", origin)
            .header("Referer", format!("{origin}/"))
            .header("X-YouTube-Client-Name", client_name)
            .header("X-YouTube-Client-Version", version)
            .json(&body);
        if let Some(v) = self.visitor.read().unwrap().clone() {
            req = req.header("X-Goog-Visitor-Id", v);
        }
        let res = req.send().await?;
        let status = res.status();
        if !status.is_success() {
            return Err(anyhow!("InnerTube {endpoint}: HTTP {status}"));
        }
        let value: Value = res.json().await?;
        if let Some(v) = value.pointer("/responseContext/visitorData").and_then(|v| v.as_str()) {
            let mut slot = self.visitor.write().unwrap();
            if slot.is_none() {
                *slot = Some(v.to_string());
            }
        }
        Ok(value)
    }

    /// POST with up to two attempts (the second after a short pause), like ByTune's withRetry.
    async fn post(&self, endpoint: &str, body: Value) -> Result<Value> {
        match self.post_as(endpoint, body.clone(), false).await {
            Ok(v) => Ok(v),
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(600)).await;
                self.post_as(endpoint, body, false).await
            }
        }
    }

    pub async fn search(&self, query: &str, params: Option<&str>) -> Result<Value> {
        let mut body = json!({ "query": query });
        if let Some(p) = params {
            body["params"] = Value::String(p.to_string());
        }
        self.post("search", body).await
    }

    pub async fn search_continuation(&self, token: &str) -> Result<Value> {
        self.post("search", json!({ "continuation": token })).await
    }

    pub async fn suggestions(&self, input: &str) -> Result<Value> {
        self.post("music/get_search_suggestions", json!({ "input": input })).await
    }

    pub async fn browse(&self, browse_id: &str, params: Option<&str>) -> Result<Value> {
        let mut body = json!({ "browseId": browse_id });
        if let Some(p) = params {
            body["params"] = Value::String(p.to_string());
        }
        self.post("browse", body).await
    }

    pub async fn browse_continuation(&self, token: &str) -> Result<Value> {
        self.post("browse", json!({ "continuation": token })).await
    }

    pub async fn next(&self, body: Value) -> Result<Value> {
        self.post("next", body).await
    }

    /// Timed captions for a video (the WEB client's get_transcript).
    pub async fn get_transcript(&self, params: &str) -> Result<Value> {
        self.post_as("get_transcript", json!({ "params": params }), true).await
    }

    /// A visitor id, fetched with one cheap browse when none is known yet.
    async fn ensure_visitor(&self) -> Option<String> {
        if let Some(v) = self.visitor.read().unwrap().clone() {
            return Some(v);
        }
        let _ = self.browse("FEmusic_home", None).await;
        self.visitor.read().unwrap().clone()
    }

    /// The `/player` answer for a video as one of the app clients in `PlayerClient`.
    pub async fn player(&self, video_id: &str, client: PlayerClient) -> Result<Value> {
        let visitor = self.ensure_visitor().await;
        let (name, id, version, ua, extra) = client.params();
        let mut c = json!({ "clientName": name, "clientVersion": version, "hl": self.hl, "gl": self.gl });
        for (k, v) in extra.as_object().unwrap() {
            c[k] = v.clone();
        }
        if let Some(v) = &visitor {
            c["visitorData"] = json!(v);
        }
        let body = json!({ "context": { "client": c }, "videoId": video_id, "contentCheckOk": true, "racyCheckOk": true });
        let mut req = self
            .http
            .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
            .timeout(Duration::from_secs(15))
            .header("User-Agent", ua)
            .header("X-YouTube-Client-Name", id)
            .header("X-YouTube-Client-Version", version)
            .json(&body);
        if let Some(v) = &visitor {
            req = req.header("X-Goog-Visitor-Id", v);
        }
        let res = req.send().await?;
        if !res.status().is_success() {
            return Err(anyhow!("player {name}: HTTP {}", res.status()));
        }
        Ok(res.json().await?)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum PlayerClient {
    VisionOs,
    AndroidVr,
}

impl PlayerClient {
    /// (clientName, numeric id, version, User-Agent, extra context fields) — youtubei.js 18.3 constants.
    fn params(self) -> (&'static str, &'static str, &'static str, &'static str, Value) {
        match self {
            PlayerClient::VisionOs => (
                "VISIONOS",
                "101",
                "1.02",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
                json!({ "deviceMake": "Apple", "deviceModel": "RealityDevice17,1", "osName": "visionOS", "osVersion": "26.5.23O471" }),
            ),
            PlayerClient::AndroidVr => (
                "ANDROID_VR",
                "28",
                "1.65.10",
                "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
                json!({ "deviceMake": "Oculus", "deviceModel": "Quest 3", "androidSdkVersion": 32, "osName": "Android", "osVersion": "12L" }),
            ),
        }
    }

    pub fn user_agent(self) -> &'static str {
        self.params().3
    }
}
