use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header::HOST, Request, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::sync::Arc;
use tokio::sync::mpsc;
use reqwest::Client;
use serde_json::json;
use tracing::{error, warn};
use uuid::Uuid;

use crate::config::{AppConfig, ServiceTarget};
use crate::telemetry::worker::LogMessage;
use crate::middleware::correlation::CorrelationId;

/// Headers que no deben reenviarse entre proxies (RFC 2616 §13.5.1)
static HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length", // lo recalcula reqwest automáticamente
];

fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP.iter().any(|h| h.eq_ignore_ascii_case(name))
}

pub struct AppState {
    pub http_client: Client,
    pub log_tx: mpsc::Sender<LogMessage>,
    pub config: &'static AppConfig,
}

/// Envía un evento de telemetría sin bloquear el handler.
/// Si el canal está lleno se descarta el evento y se emite una advertencia.
fn send_log(tx: &mpsc::Sender<LogMessage>, msg: LogMessage) {
    if let Err(e) = tx.try_send(msg) {
        warn!("Canal de telemetría lleno, evento descartado: {}", e);
    }
}

pub async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

pub async fn reverse_proxy_handler(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
) -> Result<Response, StatusCode> {
    let correlation_id = req
        .extensions()
        .get::<CorrelationId>()
        .map(|c| c.0)
        .unwrap_or_else(Uuid::new_v4);

    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let method = parts.method.clone();
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();

    let stripped_path = path.strip_prefix("/api").unwrap_or(&path);

    let target: &ServiceTarget = match stripped_path {
        p if p.starts_with("/auth") => &state.config.auth,
        p if p.starts_with("/users") => &state.config.users,
        p if p.starts_with("/zonas") => &state.config.zones,
        p if p.starts_with("/tickets") => &state.config.tickets,
        p if p.starts_with("/reservas") => &state.config.reservations,
        p if p.starts_with("/pagos") => &state.config.payments,
        _ => return Err(StatusCode::NOT_FOUND),
    };

    let target_url = format!("{}{}{}", target.base_url, stripped_path, query);

    let body_bytes = to_bytes(body, state.config.request_body_limit)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;

    send_log(
        &state.log_tx,
        LogMessage {
            service_name: target.name.clone(),
            event_type: "REQUEST_ROUTED".to_string(),
            correlation_id,
            payload: json!({ "path": path, "method": method.as_str() }),
        },
    );

    let mut proxy_request = state
        .http_client
        .request(method.clone(), &target_url)
        .header("X-Correlation-ID", correlation_id.to_string())
        .body(body_bytes);

    for (name, value) in &parts.headers {
        if name == HOST || is_hop_by_hop(name.as_str()) {
            continue;
        }
        proxy_request = proxy_request.header(name, value.clone());
    }

    let upstream_response = proxy_request.send().await.map_err(|e| {
        error!(
            correlation_id = %correlation_id,
            target = %target_url,
            method = %method,
            error = %e,
            "Error al contactar servicio upstream"
        );
        send_log(
            &state.log_tx,
            LogMessage {
                service_name: target.name.clone(),
                event_type: "UPSTREAM_ERROR".to_string(),
                correlation_id,
                payload: json!({
                    "target": target_url,
                    "method": method.as_str(),
                    "error": e.to_string()
                }),
            },
        );
        StatusCode::BAD_GATEWAY
    })?;

    let status = upstream_response.status();
    let upstream_headers = upstream_response.headers().clone();
    let response_bytes = upstream_response
        .bytes()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    send_log(
        &state.log_tx,
        LogMessage {
            service_name: target.name.clone(),
            event_type: "RESPONSE_RECEIVED".to_string(),
            correlation_id,
            payload: json!({ "status": status.as_u16(), "target": target_url }),
        },
    );

    let mut response_builder = Response::builder().status(status);

    for (name, value) in &upstream_headers {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        response_builder = response_builder.header(name, value);
    }

    response_builder
        .header("X-Correlation-ID", correlation_id.to_string())
        .body(Body::from(response_bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}