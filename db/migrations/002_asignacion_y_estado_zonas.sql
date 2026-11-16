-- 002: zonas asignadas a cada controlador y estado de las zonas azules.
--
--   * zonas_controladores: qué zonas atiende cada controlador (muchos a muchos). Un controlador
--     solo ve y gestiona las reservas de sus zonas. horario_zona (asignación por fecha y hora)
--     queda sin uso.
--   * estado_zona y zonas_azules.estado: solo se puede reservar en las zonas 'operativa'.
--     Las zonas existentes quedan 'operativa'.
--
-- Idempotente: se puede correr más de una vez.
-- Aplícala ANTES de desplegar zones-service, reservations-service y users-service: el código
-- viejo funciona con este esquema, pero el nuevo necesita la columna y la tabla.
-- OJO: la tabla nace vacía, así que los controladores no verán reservas hasta que el
-- administrador les asigne zonas.

BEGIN;

-- a) Estado de la zona.
DO $$ BEGIN
  CREATE TYPE estado_zona AS ENUM ('operativa', 'mantenimiento', 'inactiva');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE zonas_azules ADD COLUMN IF NOT EXISTS estado estado_zona NOT NULL DEFAULT 'operativa';

-- b) Zonas asignadas a cada controlador.
CREATE TABLE IF NOT EXISTS zonas_controladores (
  id_zona INTEGER NOT NULL REFERENCES zonas_azules (id) ON DELETE CASCADE ON UPDATE CASCADE,
  id_controlador UUID NOT NULL REFERENCES controladores (id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (id_zona, id_controlador)
);

-- La llave primaria empieza por id_zona; esto cubre la búsqueda por controlador.
CREATE INDEX IF NOT EXISTS ix_zonas_controladores_controlador
    ON zonas_controladores (id_controlador);

-- c) La vista también devuelve el estado. CREATE OR REPLACE VIEW solo admite columnas nuevas al final.
CREATE OR REPLACE VIEW zonas_con_disponibilidad AS
SELECT z.id, z.latitud, z.longitud, z.indicaciones, z.capacidad_total,
       greatest(z.capacidad_total - coalesce(o.ocupados, 0), 0)::int AS capacidad,
       z.estado
  FROM zonas_azules z
  LEFT JOIN (SELECT id_zona, count(*)::int AS ocupados FROM reservas_en_curso GROUP BY id_zona) o
         ON o.id_zona = z.id;

COMMIT;
