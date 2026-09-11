use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Instant,
};
use tracing::warn;

/// Token bucket por IP.
/// Configurable mediante constantes; en una versión más avanzada
/// se puede mover a AppConfig.
const BUCKET_CAPACITY: u32 = 100;  // máximo de tokens por IP
const REFILL_RATE: u32 = 10;       // tokens repuestos por segundo
const REFILL_INTERVAL_SECS: f64 = 1.0;

struct Bucket {
    tokens: u32,
    last_refill: Instant,
}

impl Bucket {
    fn new() -> Self {
        Self {
            tokens: BUCKET_CAPACITY,
            last_refill: Instant::now(),
        }
    }

    /// Recarga tokens según el tiempo transcurrido y luego
    /// intenta consumir uno. Devuelve true si hay cupo.
    fn try_consume(&mut self) -> bool {
        let elapsed = self.last_refill.elapsed().as_secs_f64();
        let refill = (elapsed / REFILL_INTERVAL_SECS * REFILL_RATE as f64) as u32;

        if refill > 0 {
            self.tokens = (self.tokens + refill).min(BUCKET_CAPACITY);
            self.last_refill = Instant::now();
        }

        if self.tokens > 0 {
            self.tokens -= 1;
            true
        } else {
            false
        }
    }
}

#[derive(Clone, Default)]
pub struct RateLimiter {
    buckets: Arc<Mutex<HashMap<IpAddr, Bucket>>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn check(&self, ip: IpAddr) -> bool {
        let mut map = self.buckets.lock().unwrap();
        map.entry(ip).or_insert_with(Bucket::new).try_consume()
    }
}

/// Middleware de rate limiting.
/// Extrae la IP del cliente (respetando X-Forwarded-For si existe),
/// y rechaza con 429 si el bucket está vacío.
pub async fn rate_limit_middleware(req: Request<Body>, next: Next) -> Response {
    // Usamos la IP de conexión directa para evitar spoofing por cabeceras.
    let ip: IpAddr = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));

    // El estado del rate limiter se comparte vía extensión de la request.
    // Si no está disponible, se permite pasar (fail-open).
    let allowed = req
        .extensions()
        .get::<RateLimiter>()
        .map(|rl| rl.check(ip))
        .unwrap_or(true);

    if !allowed {
        warn!(ip = %ip, "Rate limit excedido");
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("Retry-After", "1")
            .body(Body::from("Too Many Requests"))
            .unwrap();
    }

    next.run(req).await
}