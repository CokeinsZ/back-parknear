use sqlx::PgPool;
use crate::telemetry::worker::LogMessage;

pub async fn insert_log(pool: &PgPool, log: LogMessage) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO bus_logs (service_name, event_type, correlation_id, payload)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(log.service_name)
    .bind(log.event_type)
    .bind(log.correlation_id)
    .bind(log.payload)
    .execute(pool)
    .await?;

    Ok(())
}