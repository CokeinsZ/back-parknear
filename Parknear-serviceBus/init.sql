CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS bus_logs (
    time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service_name VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    correlation_id UUID NOT NULL,
    payload JSONB
);

SELECT create_hypertable('bus_logs', 'time', if_not_exists => TRUE);

ALTER TABLE bus_logs SET (timescaledb.compress = false);

CREATE INDEX IF NOT EXISTS ix_logs_correlation ON bus_logs (correlation_id);