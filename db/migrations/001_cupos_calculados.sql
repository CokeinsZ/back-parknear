-- 001: cupos calculados, llegada en fecha_real_inicio y vencimiento de reservas.
--
-- Diseño completo en docs/plan-cupos-reservas.md (§4 y §5). Resumen:
--   * fecha_real_inicio pasa a ser la LLEGADA confirmada por el encargado (NULL = no ha llegado).
--     La ventana de la reserva va de fecha_creacion a fecha_fin.
--   * Los cupos disponibles se calculan (vista zonas_con_disponibilidad); el contador
--     zonas_azules.capacidad queda sin uso.
--   * Una sola reserva en curso por vehículo (índice único parcial).
--
-- Idempotente: se puede correr más de una vez. La conversión de datos del paso b solo
-- corre la primera vez (mientras fecha_real_inicio siga NOT NULL) y no se puede deshacer.
-- Despliega reservations-service, zones-service y payments-service justo después.

BEGIN;

-- a) Fechas por defecto en UTC, igual que las que escribe el backend.
ALTER TABLE reservas ALTER COLUMN fecha_creacion      SET DEFAULT (now() at time zone 'utc');
ALTER TABLE reservas ALTER COLUMN fecha_actualizacion SET DEFAULT (now() at time zone 'utc');

-- b) fecha_real_inicio pasa a ser la LLEGADA (NULL = no ha llegado), y la ventana va desde la creación.
--    Conversión de los datos del modelo viejo, UNA sola vez: solo corre mientras la columna sigue NOT NULL.
--    En el modelo viejo, aceptar movía la ventana (inicio = aceptación, fin = aceptación + duración)
--    y confirmar la llegada completaba la reserva. Los precios históricos no se tocan.
DO $$
BEGIN
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'reservas'
         AND column_name = 'fecha_real_inicio') = 'NO' THEN

    ALTER TABLE reservas ALTER COLUMN fecha_real_inicio DROP NOT NULL;

    -- 'activa' vieja = aceptada, sin llegada: ventana desde la creación (misma duración), sin llegada.
    UPDATE reservas
       SET fecha_fin = fecha_creacion + (fecha_fin - fecha_real_inicio),
           fecha_real_inicio = NULL
     WHERE estado = 'activa';

    -- 'pendiente' y 'cancelada' viejas nunca llegaron (en el modelo viejo, llegar = completar).
    UPDATE reservas SET fecha_real_inicio = NULL WHERE estado IN ('pendiente', 'cancelada');

    -- 'completada' vieja = se confirmó la placa, y fecha_actualizacion guarda ese momento (la llegada).
    -- Si su tiempo (desde la creación) no ha terminado, el carro sigue parqueado: vuelve a 'activa'.
    -- Postgres evalúa todo el SET con los valores viejos.
    UPDATE reservas
       SET fecha_fin = fecha_creacion + (fecha_fin - fecha_real_inicio),
           fecha_real_inicio = fecha_actualizacion,
           estado = CASE WHEN fecha_creacion + (fecha_fin - fecha_real_inicio) > (now() at time zone 'utc')
                         THEN 'activa'::estado_reserva ELSE 'completada'::estado_reserva END
     WHERE estado = 'completada' AND fecha_fin IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN reservas.fecha_real_inicio IS
  'Llegada confirmada por el encargado (placa verificada). NULL = no ha llegado.';

-- c) Lo que ya debió vencer (lo mismo que hace el job; las dos sentencias son idempotentes).
UPDATE reservas SET estado = 'cancelada', precio = 5000, fecha_actualizacion = (now() at time zone 'utc')
 WHERE estado IN ('pendiente','activa') AND fecha_real_inicio IS NULL
   AND fecha_creacion <= (now() at time zone 'utc') - interval '15 minutes';
UPDATE reservas SET estado = 'completada', fecha_actualizacion = (now() at time zone 'utc')
 WHERE estado = 'activa' AND fecha_real_inicio IS NOT NULL AND fecha_fin <= (now() at time zone 'utc');
--    En curso sin fecha_fin: datos rotos.
UPDATE reservas SET estado = 'cancelada', fecha_actualizacion = (now() at time zone 'utc')
 WHERE estado IN ('pendiente','activa') AND fecha_fin IS NULL;
--    Vehículo con más de una en curso: se deja la más reciente.
UPDATE reservas r SET estado = 'cancelada', fecha_actualizacion = (now() at time zone 'utc')
 WHERE r.estado IN ('pendiente','activa') AND r.id_vehiculo IS NOT NULL
   AND EXISTS (SELECT 1 FROM reservas o
                WHERE o.id_vehiculo = r.id_vehiculo AND o.estado IN ('pendiente','activa') AND o.id > r.id);

-- d) Qué ocupa un cupo. ÚNICA definición. Los 15 minutos también están en reglas.ts (MINUTOS_PARA_LLEGAR).
CREATE OR REPLACE VIEW reservas_en_curso AS
SELECT r.id, r.id_zona, r.id_vehiculo, r.id_conductor, r.estado,
       r.fecha_creacion, r.fecha_real_inicio, r.fecha_fin
  FROM reservas r
 WHERE (r.estado IN ('pendiente','activa') AND r.fecha_real_inicio IS NULL          -- en camino
        AND r.fecha_creacion > (now() at time zone 'utc') - interval '15 minutes')
    OR (r.estado = 'activa' AND r.fecha_real_inicio IS NOT NULL                     -- parqueada
        AND r.fecha_fin > (now() at time zone 'utc'));

-- e) Zonas con los cupos disponibles calculados. `capacidad` conserva el nombre que ya usa la app.
CREATE OR REPLACE VIEW zonas_con_disponibilidad AS
SELECT z.id, z.latitud, z.longitud, z.indicaciones, z.capacidad_total,
       greatest(z.capacidad_total - coalesce(o.ocupados, 0), 0)::int AS capacidad
  FROM zonas_azules z
  LEFT JOIN (SELECT id_zona, count(*)::int AS ocupados FROM reservas_en_curso GROUP BY id_zona) o
         ON o.id_zona = z.id;

-- f) Índices. El parcial por zona también le sirve al job (su WHERE implica el predicado).
CREATE INDEX IF NOT EXISTS ix_reservas_en_curso_zona
    ON reservas (id_zona) WHERE estado IN ('pendiente','activa');
--    Garantía final de "una reserva en curso por vehículo" (los NULL no chocan).
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservas_vehiculo_en_curso
    ON reservas (id_vehiculo) WHERE estado IN ('pendiente','activa');

-- g) Capacidad total válida.
ALTER TABLE zonas_azules DROP CONSTRAINT IF EXISTS ck_zonas_capacidad_total;
ALTER TABLE zonas_azules ADD CONSTRAINT ck_zonas_capacidad_total CHECK (capacidad_total >= 0);

COMMIT;
