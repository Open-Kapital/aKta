//! aKta: one-way sync of meeting text (title, transcript, summary, notes) from
//! the local SQLite database to Supabase. SQLite stays the source of truth so
//! the app keeps working offline; pending changes are pushed when Supabase is
//! reachable. Audio never leaves the machine.

use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDateTime, Utc};
use log::{info, warn};
use once_cell::sync::Lazy;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use tokio::sync::{Mutex, Notify};

const SYNC_INTERVAL: Duration = Duration::from_secs(120);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const SCHEMA_HINT: &str = "Run supabase/schema.sql in the Supabase SQL editor first.";

#[derive(Debug, Clone)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key: String,
    pub email: String,
    pub password: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub enabled: bool,
    pub running: bool,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub last_synced_meetings: usize,
    pub last_deleted_meetings: usize,
    pub pending_meetings: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub synced_meetings: usize,
    pub deleted_meetings: usize,
    pub unchanged_meetings: usize,
}

struct AuthSession {
    config_fingerprint: String,
    access_token: String,
    expires_at: Instant,
}

static SESSION: Lazy<Mutex<Option<AuthSession>>> = Lazy::new(|| Mutex::new(None));
static SYNC_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static STATUS: Lazy<std::sync::Mutex<SyncStatus>> =
    Lazy::new(|| std::sync::Mutex::new(SyncStatus::default()));
static WAKE: Lazy<Notify> = Lazy::new(Notify::new);

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

fn update_status(f: impl FnOnce(&mut SyncStatus)) {
    if let Ok(mut status) = STATUS.lock() {
        f(&mut status);
    }
}

pub fn current_status() -> SyncStatus {
    STATUS.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Asks the background loop to sync as soon as possible.
pub fn request_sync() {
    WAKE.notify_one();
}

// ---------------------------------------------------------------------------
// Local configuration
// ---------------------------------------------------------------------------

pub fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(url).map_err(|_| "Invalid Supabase URL".to_string())?;
    if parsed.scheme() != "https"
        && parsed.host_str() != Some("localhost")
        && parsed.host_str() != Some("127.0.0.1")
    {
        return Err("Supabase URL must start with https://".to_string());
    }
    Ok(url.to_string())
}

pub async fn load_config(pool: &SqlitePool) -> Result<Option<SupabaseConfig>, String> {
    let row = sqlx::query(
        "SELECT url, anon_key, email, password, enabled FROM akta_supabase_config WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|r| SupabaseConfig {
        url: r.get("url"),
        anon_key: r.get("anon_key"),
        email: r.get("email"),
        password: r.get("password"),
        enabled: r.get::<i64, _>("enabled") != 0,
    }))
}

pub async fn save_config(pool: &SqlitePool, config: &SupabaseConfig) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO akta_supabase_config (id, url, anon_key, email, password, enabled, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            url = excluded.url, anon_key = excluded.anon_key, email = excluded.email,
            password = excluded.password, enabled = excluded.enabled, updated_at = excluded.updated_at",
    )
    .bind(&config.url)
    .bind(&config.anon_key)
    .bind(&config.email)
    .bind(&config.password)
    .bind(config.enabled as i64)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    *SESSION.lock().await = None;
    // Settings changed (possibly a different project): push everything again.
    sqlx::query("DELETE FROM akta_supabase_sync_state")
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Supabase HTTP API
// ---------------------------------------------------------------------------

fn fingerprint(config: &SupabaseConfig) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\n{}\n{}\n{}",
            config.url, config.anon_key, config.email, config.password
        ))
    )
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

async fn sign_in(client: &Client, config: &SupabaseConfig) -> Result<String, String> {
    let fp = fingerprint(config);
    {
        let session = SESSION.lock().await;
        if let Some(s) = session.as_ref() {
            if s.config_fingerprint == fp && s.expires_at > Instant::now() {
                return Ok(s.access_token.clone());
            }
        }
    }

    let response = client
        .post(format!("{}/auth/v1/token?grant_type=password", config.url))
        .header("apikey", &config.anon_key)
        .json(&serde_json::json!({ "email": config.email, "password": config.password }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Supabase: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(match status {
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED => {
                format!("Supabase login failed (check email/password): {}", body)
            }
            _ => format!("Supabase login failed with status {}: {}", status, body),
        });
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Unexpected Supabase login response: {}", e))?;
    let lifetime = token.expires_in.unwrap_or(3600).saturating_sub(120).max(60);
    *SESSION.lock().await = Some(AuthSession {
        config_fingerprint: fp,
        access_token: token.access_token.clone(),
        expires_at: Instant::now() + Duration::from_secs(lifetime),
    });
    Ok(token.access_token)
}

async fn call_rpc(
    client: &Client,
    config: &SupabaseConfig,
    token: &str,
    function: &str,
    body: &serde_json::Value,
) -> Result<(), String> {
    let response = client
        .post(format!("{}/rest/v1/rpc/{}", config.url, function))
        .header("apikey", &config.anon_key)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Supabase: {}", e))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        *SESSION.lock().await = None;
    }
    if status == StatusCode::NOT_FOUND || text.contains("PGRST202") {
        return Err(format!(
            "Supabase function {} not found. {}",
            function, SCHEMA_HINT
        ));
    }
    Err(format!(
        "Supabase {} failed with status {}: {}",
        function, status, text
    ))
}

/// Signs in and checks that the aKta tables exist.
pub async fn test_connection(config: &SupabaseConfig) -> Result<(), String> {
    let client = http_client()?;
    *SESSION.lock().await = None;
    let token = sign_in(&client, config).await?;
    let response = client
        .get(format!(
            "{}/rest/v1/akta_meetings?select=id&limit=1",
            config.url
        ))
        .header("apikey", &config.anon_key)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Could not reach Supabase: {}", e))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    if status == StatusCode::NOT_FOUND || text.contains("PGRST205") || text.contains("42P01") {
        return Err(format!(
            "Logged in, but the aKta tables are missing. {}",
            SCHEMA_HINT
        ));
    }
    Err(format!("Supabase returned status {}: {}", status, text))
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

/// Converts the timestamp formats found in the SQLite database into RFC 3339
/// so Postgres can parse them as `timestamptz`.
fn normalize_timestamp(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc).to_rfc3339());
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f%:z", "%Y-%m-%d %H:%M:%S%.f%#z"] {
        if let Ok(dt) = DateTime::parse_from_str(raw, fmt) {
            return Some(dt.with_timezone(&Utc).to_rfc3339());
        }
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc).to_rfc3339());
        }
    }
    None
}

/// Extracts readable markdown from a `summary_processes.result` JSON blob.
fn summary_markdown(result: &serde_json::Value) -> Option<String> {
    if let Some(md) = result.get("markdown").and_then(|v| v.as_str()) {
        return Some(md.to_string());
    }
    // Older results may be double-encoded JSON strings.
    if let Some(inner) = result.as_str() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(inner) {
            return summary_markdown(&parsed);
        }
        return Some(inner.to_string());
    }
    None
}

async fn table_exists(pool: &SqlitePool, table: &str) -> bool {
    sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(table)
        .fetch_optional(pool)
        .await
        .map(|r| r.is_some())
        .unwrap_or(false)
}

async fn build_payload(
    pool: &SqlitePool,
    meeting_id: &str,
    title: String,
    created_at: Option<String>,
    updated_at: Option<String>,
    has_notes_table: bool,
) -> Result<serde_json::Value, String> {
    let transcript_rows = sqlx::query(
        "SELECT id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker
         FROM transcripts WHERE meeting_id = ?
         ORDER BY COALESCE(audio_start_time, 0), timestamp, id",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let transcripts: Vec<serde_json::Value> = transcript_rows
        .iter()
        .enumerate()
        .map(|(position, r)| {
            serde_json::json!({
                "id": r.get::<String, _>("id"),
                "position": position,
                "text": r.get::<String, _>("transcript"),
                "timestamp": r.get::<Option<String>, _>("timestamp"),
                "audio_start_time": r.get::<Option<f64>, _>("audio_start_time"),
                "audio_end_time": r.get::<Option<f64>, _>("audio_end_time"),
                "duration": r.get::<Option<f64>, _>("duration"),
                "speaker": r.get::<Option<String>, _>("speaker"),
            })
        })
        .collect();

    let summary_row = sqlx::query(
        "SELECT status, result, CAST(updated_at AS TEXT) AS updated_at
         FROM summary_processes WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let (summary_status, summary_result, summary_updated_at) = match summary_row {
        Some(r) => {
            let result = r
                .get::<Option<String>, _>("result")
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
            (
                Some(r.get::<String, _>("status")),
                result,
                normalize_timestamp(r.get::<Option<String>, _>("updated_at")),
            )
        }
        None => (None, None, None),
    };
    let summary_markdown = summary_result.as_ref().and_then(summary_markdown);

    let (notes_markdown, notes_updated_at) = if has_notes_table {
        match sqlx::query(
            "SELECT notes_markdown, updated_at FROM meeting_notes WHERE meeting_id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        {
            Some(r) => (
                r.get::<Option<String>, _>("notes_markdown"),
                normalize_timestamp(r.get::<Option<String>, _>("updated_at")),
            ),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(serde_json::json!({
        "p_meeting": {
            "id": meeting_id,
            "title": title,
            "created_at": normalize_timestamp(created_at),
            "updated_at": normalize_timestamp(updated_at),
            "summary_status": summary_status,
            "summary_markdown": summary_markdown,
            "summary_result": summary_result,
            "summary_updated_at": summary_updated_at,
            "notes_markdown": notes_markdown,
            "notes_updated_at": notes_updated_at,
            "source_device": source_device(),
        },
        "p_transcripts": transcripts,
    }))
}

fn source_device() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string())
}

fn payload_hash(payload: &serde_json::Value) -> String {
    format!("{:x}", Sha256::digest(payload.to_string().as_bytes()))
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async fn count_pending(pool: &SqlitePool) -> usize {
    let changed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM meetings m
         LEFT JOIN akta_supabase_sync_state s ON s.meeting_id = m.id
         WHERE s.meeting_id IS NULL",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    let deletes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM akta_supabase_pending_deletes")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    (changed + deletes) as usize
}

/// Pushes every new or changed meeting and every pending deletion.
pub async fn sync_once(pool: &SqlitePool) -> Result<SyncReport, String> {
    let _guard = SYNC_LOCK.lock().await;
    let config = match load_config(pool).await? {
        Some(c) => c,
        None => {
            update_status(|s| {
                s.configured = false;
                s.enabled = false;
            });
            return Err("Supabase is not configured yet.".to_string());
        }
    };
    update_status(|s| {
        s.configured = true;
        s.enabled = config.enabled;
    });
    if !config.enabled {
        return Err("Supabase sync is disabled.".to_string());
    }

    update_status(|s| s.running = true);
    let result = sync_with_config(pool, &config).await;
    let pending = count_pending(pool).await;
    update_status(|s| {
        s.running = false;
        s.pending_meetings = pending;
        match &result {
            Ok(report) => {
                s.last_sync_at = Some(Utc::now().to_rfc3339());
                s.last_error = None;
                s.last_synced_meetings = report.synced_meetings;
                s.last_deleted_meetings = report.deleted_meetings;
            }
            Err(e) => s.last_error = Some(e.clone()),
        }
    });
    result
}

async fn sync_with_config(
    pool: &SqlitePool,
    config: &SupabaseConfig,
) -> Result<SyncReport, String> {
    let client = http_client()?;
    let token = sign_in(&client, config).await?;
    let mut report = SyncReport::default();

    let deletes: Vec<String> =
        sqlx::query_scalar("SELECT meeting_id FROM akta_supabase_pending_deletes")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    for meeting_id in deletes {
        call_rpc(
            &client,
            config,
            &token,
            "akta_delete_meeting",
            &serde_json::json!({ "p_id": meeting_id }),
        )
        .await?;
        sqlx::query("DELETE FROM akta_supabase_pending_deletes WHERE meeting_id = ?")
            .bind(&meeting_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        report.deleted_meetings += 1;
    }

    let has_notes_table = table_exists(pool, "meeting_notes").await;
    let meetings = sqlx::query(
        "SELECT m.id, m.title, CAST(m.created_at AS TEXT) AS created_at,
                CAST(m.updated_at AS TEXT) AS updated_at, s.content_hash
         FROM meetings m
         LEFT JOIN akta_supabase_sync_state s ON s.meeting_id = m.id
         ORDER BY m.created_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for row in meetings {
        let meeting_id: String = row.get("id");
        let payload = build_payload(
            pool,
            &meeting_id,
            row.get("title"),
            row.get("created_at"),
            row.get("updated_at"),
            has_notes_table,
        )
        .await?;
        let hash = payload_hash(&payload);
        if row.get::<Option<String>, _>("content_hash").as_deref() == Some(hash.as_str()) {
            report.unchanged_meetings += 1;
            continue;
        }
        call_rpc(&client, config, &token, "akta_sync_meeting", &payload).await?;
        sqlx::query(
            "INSERT INTO akta_supabase_sync_state (meeting_id, content_hash, synced_at)
             VALUES (?, ?, ?)
             ON CONFLICT(meeting_id) DO UPDATE SET
                content_hash = excluded.content_hash, synced_at = excluded.synced_at",
        )
        .bind(&meeting_id)
        .bind(&hash)
        .bind(Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        report.synced_meetings += 1;
    }

    if report.synced_meetings > 0 || report.deleted_meetings > 0 {
        info!(
            "Supabase sync: {} meetings pushed, {} deleted",
            report.synced_meetings, report.deleted_meetings
        );
    }
    Ok(report)
}

/// Background loop: syncs every [`SYNC_INTERVAL`] or when [`request_sync`] is called.
pub async fn run_loop(pool: SqlitePool) {
    loop {
        match sync_once(&pool).await {
            Ok(_) => {}
            Err(e) if e.contains("not configured") || e.contains("disabled") => {}
            Err(e) => warn!("Supabase sync failed (will retry): {}", e),
        }
        tokio::select! {
            _ = tokio::time::sleep(SYNC_INTERVAL) => {}
            _ = WAKE.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_sqlite_timestamps() {
        assert_eq!(
            normalize_timestamp(Some("2025-11-09T13:05:00.123Z".into())).as_deref(),
            Some("2025-11-09T13:05:00.123+00:00")
        );
        assert_eq!(
            normalize_timestamp(Some("2025-11-09 13:05:00.5+00:00".into())).as_deref(),
            Some("2025-11-09T13:05:00.500+00:00")
        );
        assert_eq!(
            normalize_timestamp(Some("2025-11-09T13:05:00".into())).as_deref(),
            Some("2025-11-09T13:05:00+00:00")
        );
        assert_eq!(normalize_timestamp(Some("not a date".into())), None);
        assert_eq!(normalize_timestamp(None), None);
    }

    #[test]
    fn extracts_summary_markdown() {
        let current = serde_json::json!({"markdown": "# Notes", "reasoning_stripped": false});
        assert_eq!(summary_markdown(&current).as_deref(), Some("# Notes"));
        let legacy = serde_json::json!("{\"markdown\": \"old\"}");
        assert_eq!(summary_markdown(&legacy).as_deref(), Some("old"));
        assert_eq!(summary_markdown(&serde_json::json!({"x": 1})), None);
    }

    #[test]
    fn validates_url() {
        assert_eq!(
            normalize_url(" https://abc.supabase.co/ ").unwrap(),
            "https://abc.supabase.co"
        );
        assert!(normalize_url("http://abc.supabase.co").is_err());
        assert!(normalize_url("nope").is_err());
    }
}
