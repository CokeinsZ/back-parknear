use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    sync::{Arc, RwLock},
};
use tracing::warn;

/// Lista negra de IPs compartida y mutable en runtime.
/// Se puede extender para cargarla desde DB o un archivo de configuración.
#[derive(Clone, Default)]
pub struct IpBlacklist {
    blocked: Arc<RwLock<HashSet<IpAddr>>>,
}

impl IpBlacklist {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(dead_code)]
    pub fn block(&self, ip: IpAddr) {
        self.blocked.write().unwrap().insert(ip);
    }

    #[allow(dead_code)]
    pub fn unblock(&self, ip: IpAddr) {
        self.blocked.write().unwrap().remove(&ip);
    }

    pub fn is_blocked(&self, ip: IpAddr) -> bool {
        self.blocked.read().unwrap().contains(&ip)
    }
}

/// Middleware de blacklist.
/// Rechaza con 403 cualquier IP presente en la lista negra.
pub async fn blacklist_middleware(req: Request<Body>, next: Next) -> Response {
    let ip: IpAddr = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));

    let blocked = req
        .extensions()
        .get::<IpBlacklist>()
        .map(|bl| bl.is_blocked(ip))
        .unwrap_or(false);

    if blocked {
        warn!(ip = %ip, "IP bloqueada en blacklist");
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("Forbidden"))
            .unwrap();
    }

    next.run(req).await
}