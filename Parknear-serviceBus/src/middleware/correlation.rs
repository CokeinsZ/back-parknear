use axum::{
    body::Body,
    http::{header::HeaderValue, Request},
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct CorrelationId(pub Uuid);

pub async fn correlation_middleware(mut req: Request<Body>, next: Next) -> Response {
    let id = req
        .headers()
        .get("X-Correlation-ID")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok())
        .unwrap_or_else(Uuid::new_v4);

    req.extensions_mut().insert(CorrelationId(id));

    req.headers_mut().insert("X-Correlation-ID", HeaderValue::from_str(&id.to_string()).unwrap());

    let mut response = next.run(req).await;

    response.headers_mut().insert("X-Correlation-ID", HeaderValue::from_str(&id.to_string()).unwrap());

    response
}