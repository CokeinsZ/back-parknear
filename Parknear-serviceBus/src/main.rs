mod telemetry;
mod middleware;
mod proxy;
mod config;

use axum::{middleware::from_fn, routing::any, routing::get, Router};
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::config::AppConfig;
use crate::middleware::blacklist::blacklist_middleware;
use crate::middleware::blacklist::IpBlacklist;
use crate::middleware::correlation::correlation_middleware;
use crate::middleware::rate_limit::RateLimiter;
use crate::middleware::rate_limit::rate_limit_middleware;
use crate::proxy::router::{health_handler, reverse_proxy_handler, AppState};

#[tokio::main]
async fn main() {
    // Inicializar tracing. El nivel se controla con RUST_LOG en el entorno.
    // Ejemplo: RUST_LOG=parknear_service_bus=debug,tower_http=info
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = AppConfig::init();

    let pool = PgPoolOptions::new()
        .max_connections(config.max_db_connections)
        .connect(&config.database_url)
        .await
        .expect("Fallo al conectar a TimescaleDB");

    info!("Conectado a TimescaleDB");

    let (tx, rx) = mpsc::channel(1000);
    tokio::spawn(telemetry::worker::log_worker(rx, pool));

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("Fallo al construir el cliente HTTP");

    let state = Arc::new(AppState {
        http_client,
        log_tx: tx,
        config,
    });

    let rate_limiter = RateLimiter::new();
    let ip_blacklist = IpBlacklist::new();

    let bind_addr = state.config.bind_addr.clone();

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/*path", any(reverse_proxy_handler))
        .layer(from_fn(rate_limit_middleware))
        .layer(from_fn(blacklist_middleware))
        .layer(axum::Extension(rate_limiter))
        .layer(axum::Extension(ip_blacklist))
        .layer(from_fn(correlation_middleware))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("Fallo al hacer bind en la dirección");

    info!("Service Bus escuchando en {}", bind_addr);

    // Graceful shutdown al recibir SIGTERM o Ctrl-C
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();

    info!("Service Bus apagado correctamente");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Fallo al instalar el handler de Ctrl-C");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Fallo al instalar el handler de SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("Señal de apagado recibida, cerrando...");
}