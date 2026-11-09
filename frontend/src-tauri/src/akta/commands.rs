use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::supabase_sync::{self, SupabaseConfig, SyncReport, SyncStatus};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseConfigView {
    pub url: String,
    pub anon_key: String,
    pub email: String,
    pub has_password: bool,
    pub enabled: bool,
}

/// Builds a config from form input; an empty password keeps the stored one.
async fn config_from_input(
    state: &AppState,
    url: String,
    anon_key: String,
    email: String,
    password: Option<String>,
    enabled: bool,
) -> Result<SupabaseConfig, String> {
    let url = supabase_sync::normalize_url(&url)?;
    let anon_key = anon_key.trim().to_string();
    let email = email.trim().to_string();
    if anon_key.is_empty() {
        return Err("Supabase anon key is required".to_string());
    }
    if email.is_empty() {
        return Err("Email is required".to_string());
    }
    let password = match password.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => supabase_sync::load_config(state.db_manager.pool())
            .await?
            .map(|c| c.password)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "Password is required".to_string())?,
    };
    Ok(SupabaseConfig {
        url,
        anon_key,
        email,
        password,
        enabled,
    })
}

#[tauri::command]
pub async fn akta_supabase_get_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SupabaseConfigView>, String> {
    Ok(supabase_sync::load_config(state.db_manager.pool())
        .await?
        .map(|c| SupabaseConfigView {
            url: c.url,
            anon_key: c.anon_key,
            email: c.email,
            has_password: !c.password.is_empty(),
            enabled: c.enabled,
        }))
}

#[tauri::command]
pub async fn akta_supabase_save_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    url: String,
    anon_key: String,
    email: String,
    password: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    let config = config_from_input(&state, url, anon_key, email, password, enabled).await?;
    supabase_sync::save_config(state.db_manager.pool(), &config).await?;
    supabase_sync::request_sync();
    Ok(())
}

#[tauri::command]
pub async fn akta_supabase_test_connection<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    url: String,
    anon_key: String,
    email: String,
    password: Option<String>,
) -> Result<(), String> {
    let config = config_from_input(&state, url, anon_key, email, password, true).await?;
    supabase_sync::test_connection(&config).await
}

#[tauri::command]
pub async fn akta_supabase_sync_now<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    supabase_sync::sync_once(state.db_manager.pool()).await
}

#[tauri::command]
pub async fn akta_supabase_get_status<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<SyncStatus, String> {
    Ok(supabase_sync::current_status())
}
