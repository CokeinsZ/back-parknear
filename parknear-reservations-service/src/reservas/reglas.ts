import { sql } from 'drizzle-orm';

/** Tarifa por hora de parqueo (COP). */
export const TARIFA_HORA = 3500;
/** Cargo fijo por reservar (COP). Se cobra siempre, aunque la reserva se cancele. */
export const CARGO_RESERVA = 5000;
/** Minutos que tiene el conductor para llegar desde que reserva. OJO: también está en la vista `reservas_en_curso`. */
export const MINUTOS_PARA_LLEGAR = 15;
export const HORAS_MIN = 1;
/** Con 24 h el precio máximo es 89.000, dentro de decimal(7,2) (máx. 99.999,99). */
export const HORAS_MAX = 24;

/** "Ahora" en UTC, como se guardan las columnas `timestamp` (sin zona) de reservas. */
export const ahoraUtc = sql`(now() at time zone 'utc')`;

export function precioPorHoras(horas: number): string {
  return (CARGO_RESERVA + horas * TARIFA_HORA).toFixed(2);
}
