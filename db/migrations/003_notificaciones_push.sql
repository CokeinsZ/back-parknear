-- 003: notificaciones push.
--
-- Diseño completo en el repositorio de la app: docs/plan-notificaciones.md (§4 y §5). Resumen:
--   * dispositivos_push: el token de Expo de cada teléfono y de quién es. Un teléfono es de UNA
--     persona (el token es la llave: si otra cuenta inicia sesión en él, pasa a esa cuenta) y una
--     persona puede tener varios teléfonos. Lo escribe auth-service (PUT/DELETE /auth/token-push)
--     y lo lee reservations-service para enviar los avisos.
--   * avisos_reserva: los avisos programados que el job de reservations-service ya envió
--     (recordatorio de llegada, recordatorio de fin, "no llegaste"). La llave impide enviar dos
--     veces el mismo aviso; como incluye la fecha de referencia, extender una reserva (otra
--     fecha_fin) genera un recordatorio de fin nuevo.
--
-- Idempotente: se puede correr más de una vez. Solo agrega tablas, así que el backend actual
-- sigue funcionando. Aplícala ANTES de desplegar auth-service y reservations-service.

BEGIN;

-- a) Teléfonos que reciben avisos push.
CREATE TABLE IF NOT EXISTS dispositivos_push (
  -- ExponentPushToken[...]: identifica el teléfono (la instalación de la app), no a la persona.
  token VARCHAR(255) PRIMARY KEY,
  id_usuario UUID NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE ON UPDATE CASCADE,
  fecha_actualizacion TIMESTAMP NOT NULL DEFAULT (now() at time zone 'utc')
);

-- Para buscar los teléfonos de un usuario al enviarle un aviso.
CREATE INDEX IF NOT EXISTS ix_dispositivos_push_usuario ON dispositivos_push (id_usuario);

-- b) Avisos programados que ya salieron.
CREATE TABLE IF NOT EXISTS avisos_reserva (
  id_reserva INTEGER NOT NULL REFERENCES reservas (id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- 'recordatorio_llegada' | 'recordatorio_fin' | 'no_llego'
  tipo VARCHAR(32) NOT NULL,
  -- La fecha que originó el aviso (límite de llegada o fecha_fin), en UTC como el resto de reservas.
  referencia TIMESTAMP NOT NULL,
  enviado_en TIMESTAMP NOT NULL DEFAULT (now() at time zone 'utc'),
  PRIMARY KEY (id_reserva, tipo, referencia)
);

COMMIT;
