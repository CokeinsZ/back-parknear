use dotenvy::dotenv;
use std::{env, sync::OnceLock};

#[derive(Clone, Debug)]
pub struct ServiceTarget {
    pub name: String,
    pub base_url: String,
}

#[derive(Debug)]
pub struct AppConfig {
    pub database_url: String,
    pub bind_addr: String,
    pub max_db_connections: u32,
    pub request_body_limit: usize,
    pub auth: ServiceTarget,
    pub users: ServiceTarget,
    pub zones: ServiceTarget,
    pub tickets: ServiceTarget,
    pub reservations: ServiceTarget,
    pub payments: ServiceTarget,
}

static CONFIG: OnceLock<AppConfig> = OnceLock::new();

impl AppConfig {
    pub fn init() -> &'static Self {
        CONFIG.get_or_init(|| {
            let _ = dotenv();

            Self {
                database_url: env::var("DATABASE_URL")
                    .expect("DATABASE_URL es obligatoria"),
                bind_addr: env::var("BIND_ADDR")
                    .unwrap_or_else(|_| "0.0.0.0:3000".to_string()),
                max_db_connections: env::var("MAX_DB_CONNECTIONS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(5),
                request_body_limit: env::var("REQUEST_BODY_LIMIT_BYTES")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(16 * 1024 * 1024),
                auth: ServiceTarget {
                    name: env::var("AUTH_SERVICE_NAME")
                        .unwrap_or_else(|_| "auth_service".to_string()),
                    base_url: env::var("AUTH_BASE_URL")
                        .expect("AUTH_BASE_URL es obligatoria"),
                },
                users: ServiceTarget {
                    name: env::var("USERS_SERVICE_NAME")
                        .unwrap_or_else(|_| "users_service".to_string()),
                    base_url: env::var("USERS_BASE_URL")
                        .expect("USERS_BASE_URL es obligatoria"),
                },
                zones: ServiceTarget {
                    name: env::var("ZONES_SERVICE_NAME")
                        .unwrap_or_else(|_| "zones_service".to_string()),
                    base_url: env::var("ZONES_BASE_URL")
                        .expect("ZONES_BASE_URL es obligatoria"),
                },
                tickets: ServiceTarget {
                    name: env::var("TICKETS_SERVICE_NAME")
                        .unwrap_or_else(|_| "tickets_service".to_string()),
                    base_url: env::var("TICKETS_BASE_URL")
                        .expect("TICKETS_BASE_URL es obligatoria"),
                },
                reservations: ServiceTarget {
                    name: env::var("RESERVATIONS_SERVICE_NAME")
                        .unwrap_or_else(|_| "reservations_service".to_string()),
                    base_url: env::var("RESERVATIONS_BASE_URL")
                        .expect("RESERVATIONS_BASE_URL es obligatoria"),
                },
                payments: ServiceTarget {
                    name: env::var("PAYMENTS_SERVICE_NAME")
                        .unwrap_or_else(|_| "payments_service".to_string()),
                    base_url: env::var("PAYMENTS_BASE_URL")
                        .expect("PAYMENTS_BASE_URL es obligatoria"),
                },
            }
        })
    }
}
