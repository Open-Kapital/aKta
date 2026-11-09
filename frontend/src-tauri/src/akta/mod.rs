//! aKta-specific behaviour layered on top of Meetily.

pub mod commands;
pub mod internal_llm;
pub mod supabase_sync;

use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;

/// Waits for the database to be ready, pins the summary provider to the
/// internal AI and then runs the Supabase sync loop in the background.
pub fn start_background_tasks<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let pool = loop {
            if let Some(state) = app.try_state::<AppState>() {
                break state.db_manager.pool().clone();
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        };
        if let Err(e) = internal_llm::ensure_settings(&pool).await {
            log::error!("Failed to pin internal AI settings: {}", e);
        }
        supabase_sync::run_loop(pool).await;
    });
}
