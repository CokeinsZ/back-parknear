use axum::http::{header, HeaderName, HeaderValue, Method};
use std::time::Duration;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// CORS del gateway.
///
/// El navegador manda un preflight (OPTIONS) antes de cada petición con
/// `Content-Type: application/json` o `Authorization`. El gateway es la única
/// puerta de entrada, así que los responde aquí mismo: antes se reenviaban a
/// los microservicios NestJS, que no tienen CORS y contestaban 404, y el
/// navegador bloqueaba la petición real.
///
/// `origenes` viene de `CORS_ALLOWED_ORIGINS`. Vacío o con `*` acepta cualquier
/// origen: es seguro porque la sesión viaja en el header `Authorization` y no
/// en cookies, así que otra página no puede usar la sesión de nadie.
pub fn cors_layer(origenes: &[String]) -> CorsLayer {
    let allow_origin = if origenes.is_empty() || origenes.iter().any(|o| o == "*") {
        AllowOrigin::any()
    } else {
        AllowOrigin::list(
            origenes
                .iter()
                .filter_map(|origen| HeaderValue::from_str(origen).ok()),
        )
    };

    let correlation_id = HeaderName::from_static("x-correlation-id");

    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            correlation_id.clone(),
        ])
        .expose_headers([correlation_id])
        // El navegador guarda la respuesta del preflight y no lo repite en cada petición.
        .max_age(Duration::from_secs(60 * 60))
}
