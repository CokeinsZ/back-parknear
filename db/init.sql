
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS UUID
LANGUAGE SQL VOLATILE PARALLEL UNSAFE AS $$ SELECT uuidv7() $$;

-- CREATE TYPE no admite IF NOT EXISTS: se envuelve en bloque DO idempotente.
DO $$ BEGIN
  CREATE TYPE estado_usuario AS ENUM ('activo', 'no_verificado', 'inactivo', 'eliminado');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Del SQL histórico (ningún schema.ts los declara; support-service aún no
-- tiene código de base de datos, pero las tablas se conservan).
DO $$ BEGIN
  CREATE TYPE estado_solicitud AS ENUM ('activa', 'pendiente', 'resuelta');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tipo_solicitud AS ENUM ('peticion', 'queja', 'reclamo', 'sugerencia');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE estado_reserva AS ENUM ('activa', 'pendiente', 'cancelada', 'completada');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE metodo_pago AS ENUM ('efectivo', 'mercadopago');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE estado_pago AS ENUM ('pendiente', 'aprobado', 'rechazado', 'reembolzado');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  documento_identidad VARCHAR(20) NOT NULL,
  primer_nombre VARCHAR(32) NOT NULL,
  segundo_nombre VARCHAR(32),
  primer_apellido VARCHAR(32) NOT NULL,
  segundo_apellido VARCHAR(32),
  email VARCHAR(255) NOT NULL,
  contrasena VARCHAR(255) NOT NULL,
  celular VARCHAR(13) NOT NULL,
  estado estado_usuario NOT NULL DEFAULT 'inactivo',
  fecha_creacion TIMESTAMP NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_email ON usuarios (email);
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_documento ON usuarios (documento_identidad);
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_celular ON usuarios (celular);

CREATE TABLE IF NOT EXISTS conductores (
  id UUID PRIMARY KEY REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  puntos_fidelidad INTEGER NOT NULL DEFAULT 0,
  estado estado_usuario NOT NULL
);

CREATE TABLE IF NOT EXISTS vehiculos (
  placa VARCHAR(10) PRIMARY KEY,
  id_conductor UUID REFERENCES conductores (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  marca VARCHAR(32),
  color VARCHAR(32)
);

CREATE TABLE IF NOT EXISTS controladores (
  id UUID PRIMARY KEY REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  estado estado_usuario
);

CREATE TABLE IF NOT EXISTS admin (
  id UUID PRIMARY KEY REFERENCES usuarios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  estado estado_usuario NOT NULL DEFAULT 'activo'
);

CREATE TABLE IF NOT EXISTS solicitudes_soporte (
  id SERIAL PRIMARY KEY,
  id_usuario UUID REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  tipo tipo_solicitud NOT NULL,
  titulo VARCHAR(255) NOT NULL,
  descripcion TEXT NOT NULL,
  estado estado_solicitud NOT NULL DEFAULT 'activa',
  fecha_creacion TIMESTAMP NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mensajes_soporte (
  id SERIAL PRIMARY KEY,
  id_solicitud INTEGER REFERENCES solicitudes_soporte (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  id_usuario UUID REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  mensaje TEXT NOT NULL,
  fecha TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zonas_azules (
  id SERIAL PRIMARY KEY,
  latitud DECIMAL(9, 6) NOT NULL,
  longitud DECIMAL(9, 6) NOT NULL,
  indicaciones TEXT,
  capacidad INTEGER NOT NULL DEFAULT 0,
  capacidad_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS horario_zona (
  id_zona INTEGER NOT NULL REFERENCES zonas_azules (id) ON DELETE CASCADE ON UPDATE CASCADE,
  id_controlador UUID NOT NULL REFERENCES controladores (id) ON DELETE CASCADE ON UPDATE CASCADE,
  fecha DATE NOT NULL,
  hora_inicio TIME NOT NULL DEFAULT '08:00:00',
  hora_fin TIME NOT NULL DEFAULT '18:00:00',
  PRIMARY KEY (id_zona, id_controlador, fecha)
);

CREATE TABLE IF NOT EXISTS reservas (
  id SERIAL PRIMARY KEY,
  id_conductor UUID REFERENCES conductores (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  id_zona INTEGER REFERENCES zonas_azules (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  id_vehiculo VARCHAR(10) REFERENCES vehiculos (placa) ON DELETE SET NULL ON UPDATE CASCADE,
  -- Llegada confirmada por el encargado (placa verificada). NULL = no ha llegado.
  fecha_real_inicio TIMESTAMP,
  -- Fin de la reserva: fecha_creacion + horas reservadas (más las extensiones).
  fecha_fin TIMESTAMP,
  precio DECIMAL(7, 2) NOT NULL DEFAULT '0',
  estado estado_reserva NOT NULL DEFAULT 'pendiente',
  -- Las fechas de reservas guardan la hora UTC (timestamp sin zona), como las escribe el backend.
  fecha_creacion TIMESTAMP NOT NULL DEFAULT (now() at time zone 'utc'),
  fecha_actualizacion TIMESTAMP NOT NULL DEFAULT (now() at time zone 'utc'),
  CONSTRAINT ck_reservas_precio_no_negativo CHECK (precio >= 0)
);

CREATE TABLE IF NOT EXISTS pagos (
  id SERIAL PRIMARY KEY,
  id_reserva INTEGER REFERENCES reservas (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  mp_id_transaccion VARCHAR(255),
  mp_payload JSONB,
  monto DECIMAL(7, 2) NOT NULL DEFAULT '0',
  metodo metodo_pago NOT NULL,
  estado estado_pago NOT NULL DEFAULT 'pendiente',
  anotaciones TEXT,
  fecha_creacion TIMESTAMP DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP DEFAULT NOW(),
  CONSTRAINT ck_pagos_monto_no_negativo CHECK (monto >= 0)
);

-- Cupos calculados y una reserva en curso por vehículo (igual que db/migrations/001_cupos_calculados.sql).

-- Qué ocupa un cupo. ÚNICA definición. Los 15 minutos también están en reglas.ts (MINUTOS_PARA_LLEGAR).
CREATE OR REPLACE VIEW reservas_en_curso AS
SELECT r.id, r.id_zona, r.id_vehiculo, r.id_conductor, r.estado,
       r.fecha_creacion, r.fecha_real_inicio, r.fecha_fin
  FROM reservas r
 WHERE (r.estado IN ('pendiente','activa') AND r.fecha_real_inicio IS NULL          -- en camino
        AND r.fecha_creacion > (now() at time zone 'utc') - interval '15 minutes')
    OR (r.estado = 'activa' AND r.fecha_real_inicio IS NOT NULL                     -- parqueada
        AND r.fecha_fin > (now() at time zone 'utc'));

-- Zonas con los cupos disponibles calculados. `capacidad` conserva el nombre que ya usa la app.
-- La columna zonas_azules.capacidad (el contador viejo) queda sin uso.
CREATE OR REPLACE VIEW zonas_con_disponibilidad AS
SELECT z.id, z.latitud, z.longitud, z.indicaciones, z.capacidad_total,
       greatest(z.capacidad_total - coalesce(o.ocupados, 0), 0)::int AS capacidad
  FROM zonas_azules z
  LEFT JOIN (SELECT id_zona, count(*)::int AS ocupados FROM reservas_en_curso GROUP BY id_zona) o
         ON o.id_zona = z.id;

CREATE INDEX IF NOT EXISTS ix_reservas_en_curso_zona
    ON reservas (id_zona) WHERE estado IN ('pendiente','activa');
-- Garantía final de "una reserva en curso por vehículo" (los NULL no chocan).
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservas_vehiculo_en_curso
    ON reservas (id_vehiculo) WHERE estado IN ('pendiente','activa');

ALTER TABLE zonas_azules DROP CONSTRAINT IF EXISTS ck_zonas_capacidad_total;
ALTER TABLE zonas_azules ADD CONSTRAINT ck_zonas_capacidad_total CHECK (capacidad_total >= 0);
