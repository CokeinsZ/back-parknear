use sqlx::PgPool;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::error;
use uuid::Uuid;

use crate::telemetry::db;

#[derive(Debug)]
pub struct LogMessage {
    pub service_name: String,
    pub event_type: String,
    pub correlation_id: Uuid,
    pub payload: Value,
}

pub async fn log_worker(mut rx: mpsc::Receiver<LogMessage>, pool: PgPool) {
    while let Some(log) = rx.recv().await {
        if let Err(e) = db::insert_log(&pool, log).await {
            error!("Error guardando log en TimescaleDB: {}", e);
        }
    }
}