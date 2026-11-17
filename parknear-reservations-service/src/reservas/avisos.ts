/**
 * Textos de los avisos push de una reserva (catálogo completo en el repositorio de la app:
 * docs/plan-notificaciones.md §4).
 *
 * Funciones puras: reciben la reserva con su zona y "ahora", y devuelven el aviso listo para
 * enviar. Quién lo recibe y cuándo lo decide AvisosService.
 *
 * Las horas se escriben en la hora de Colombia: el servidor corre en UTC, y sin la zona
 * horaria el conductor leería "8:15 p. m." en lugar de "3:15 p. m.".
 */

import type { Aviso } from 'src/notificaciones/notificador';
import type {
  ReservaConZona,
  ReservaRecord,
  ZonaDeReserva,
} from './interfaces/reserva.interface';
import { CARGO_RESERVA, MINUTOS_DE_AVISO, MINUTOS_PARA_LLEGAR } from './reglas';

/** Qué aviso es. Viaja en `datos.tipo`. */
export type TipoAviso =
  | 'recordatorio_llegada'
  | 'recordatorio_fin'
  | 'nueva_reserva'
  | 'aceptada'
  | 'llegada_confirmada'
  | 'no_llego'
  | 'cancelada_por_conductor';

/** Para quién es el aviso. La app solo lo abre si coincide con el rol en sesión. */
type Destinatario = 'conductor' | 'controlador';

/** Arma el aviso de una reserva. */
export type ArmarAviso = (datos: ReservaConZona, ahora: Date) => Aviso;

const MS_POR_MINUTO = 60 * 1000;
/** Avisos de algo que ya pasó: después de una hora ya no vale la pena entregarlos. */
const UNA_HORA_EN_SEGUNDOS = 60 * 60;

const formatoHora = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  hour: 'numeric',
  minute: '2-digit',
});
const formatoPesos = new Intl.NumberFormat('es-CO', {
  maximumFractionDigits: 0,
});

/** "3:15 p. m.", en la hora de Colombia. */
export function hora(fecha: Date): string {
  return formatoHora.format(fecha);
}

/** 5000 -> "$5.000". */
export function pesos(valor: number): string {
  return `$${formatoPesos.format(valor)}`;
}

/** La primera línea de las indicaciones o "Zona #id": la misma regla que `tituloZona` de la app. */
export function tituloZona(
  zona: ZonaDeReserva | null,
  idZona: number | null,
): string {
  const linea = zona?.indicaciones?.trim().split('\n')[0]?.trim();
  if (linea) return linea;
  return idZona === null ? 'tu zona' : `Zona #${idZona}`;
}

/** Hasta cuándo tiene el conductor para que le verifiquen la placa. */
export function limiteDeLlegada(reserva: ReservaRecord): Date {
  return new Date(
    reserva.fecha_creacion.getTime() + MINUTOS_PARA_LLEGAR * MS_POR_MINUTO,
  );
}

/** Minutos que faltan (redondeados hacia arriba), para el título de los recordatorios. */
function minutosHasta(fecha: Date, ahora: Date): number {
  return Math.max(
    1,
    Math.ceil((fecha.getTime() - ahora.getTime()) / MS_POR_MINUTO),
  );
}

/** "1 minuto", "5 minutos". */
function minutos(cantidad: number): string {
  return cantidad === 1 ? '1 minuto' : `${cantidad} minutos`;
}

/** TTL del aviso: los segundos que faltan para `fecha` (al menos 1). */
function segundosHasta(fecha: Date, ahora: Date): number {
  return Math.max(1, Math.floor((fecha.getTime() - ahora.getTime()) / 1000));
}

function placa(reserva: ReservaRecord): string {
  return reserva.id_vehiculo ?? 'sin registrar';
}

/** "a las 5:00 p. m.", o un texto genérico si la reserva no tiene fin (datos viejos rotos). */
function aLaHoraFin(reserva: ReservaRecord): string {
  return reserva.fecha_fin ? `a las ${hora(reserva.fecha_fin)}` : 'pronto';
}

/**
 * Une oraciones con un solo punto final cada una. Hace falta porque una oración puede
 * terminar en una hora, y "p. m." ya trae su punto: sin esto quedaría "p. m.." en el aviso.
 */
function oraciones(...partes: string[]): string {
  return partes
    .map((parte) => (parte.endsWith('.') ? parte : `${parte}.`))
    .join(' ');
}

/** Los datos ocultos y la etiqueta son iguales en todos los avisos de una reserva. */
function avisoDe(
  reserva: ReservaRecord,
  tipo: TipoAviso,
  para: Destinatario,
  contenido: Pick<Aviso, 'titulo' | 'cuerpo' | 'canal' | 'ttlSegundos'>,
): Aviso {
  return {
    ...contenido,
    datos: { tipo, reservaId: String(reserva.id), para },
    // Un aviso nuevo de la misma reserva reemplaza al anterior en la bandeja (Android).
    etiqueta: `reserva-${reserva.id}`,
  };
}

/** A1. Faltan 5 minutos para el límite de llegada y nadie ha verificado la placa. */
export const recordatorioLlegada: ArmarAviso = ({ reserva, zona }, ahora) => {
  const limite = limiteDeLlegada(reserva);
  return avisoDe(reserva, 'recordatorio_llegada', 'conductor', {
    titulo: `Te quedan ${minutos(minutosHasta(limite, ahora))} para llegar`,
    cuerpo: oraciones(
      `${tituloZona(zona, reserva.id_zona)} · placa ${placa(reserva)}`,
      `Si a las ${hora(limite)} el encargado no ha verificado tu placa, ` +
        `la reserva se cancela y se cobran ${pesos(CARGO_RESERVA)}`,
    ),
    canal: 'recordatorios',
    ttlSegundos: segundosHasta(limite, ahora),
  });
};

/** A2. El vehículo está parqueado y faltan 5 minutos para el fin de la reserva. */
export const recordatorioFin: ArmarAviso = ({ reserva, zona }, ahora) => {
  const fin = reserva.fecha_fin;
  const restantes = fin ? minutosHasta(fin, ahora) : MINUTOS_DE_AVISO;
  return avisoDe(reserva, 'recordatorio_fin', 'conductor', {
    titulo: `Tu parqueo termina en ${minutos(restantes)}`,
    cuerpo: oraciones(
      `${tituloZona(zona, reserva.id_zona)} · placa ${placa(reserva)} · ` +
        `termina ${aLaHoraFin(reserva)}`,
      'Si necesitas más tiempo, extiéndelo desde la app',
    ),
    canal: 'recordatorios',
    ttlSegundos: fin ? segundosHasta(fin, ahora) : UNA_HORA_EN_SEGUNDOS,
  });
};

/** B1. Llegó una reserva nueva a una zona del encargado. */
export const nuevaReserva: ArmarAviso = ({ reserva, zona }, ahora) => {
  const limite = limiteDeLlegada(reserva);
  return avisoDe(reserva, 'nueva_reserva', 'controlador', {
    titulo: `Nueva reserva en ${tituloZona(zona, reserva.id_zona)}`,
    cuerpo: oraciones(
      `Placa ${placa(reserva)}`,
      `Acéptala o recházala: el conductor tiene hasta las ${hora(limite)} para llegar`,
    ),
    canal: 'solicitudes',
    ttlSegundos: segundosHasta(limite, ahora),
  });
};

/** B2. El encargado aceptó la reserva. */
export const aceptada: ArmarAviso = ({ reserva, zona }, ahora) => {
  const limite = limiteDeLlegada(reserva);
  return avisoDe(reserva, 'aceptada', 'conductor', {
    titulo: 'El encargado aceptó tu reserva',
    cuerpo: oraciones(
      `${tituloZona(zona, reserva.id_zona)} · placa ${placa(reserva)}`,
      `Llega antes de las ${hora(limite)} para que verifique tu placa`,
    ),
    canal: 'reservas',
    ttlSegundos: segundosHasta(limite, ahora),
  });
};

/** B3. El encargado verificó la placa: el vehículo quedó parqueado. */
export const llegadaConfirmada: ArmarAviso = ({ reserva, zona }) =>
  avisoDe(reserva, 'llegada_confirmada', 'conductor', {
    titulo: 'Llegada confirmada',
    cuerpo: oraciones(
      `Tu parqueo en ${tituloZona(zona, reserva.id_zona)} termina ${aLaHoraFin(reserva)}`,
      `Te avisaremos ${minutos(MINUTOS_DE_AVISO)} antes`,
    ),
    canal: 'reservas',
    ttlSegundos: UNA_HORA_EN_SEGUNDOS,
  });

/** B5. La reserva se canceló porque nadie verificó la placa a tiempo. */
export const noLlego: ArmarAviso = ({ reserva, zona }) =>
  avisoDe(reserva, 'no_llego', 'conductor', {
    titulo: 'Tu reserva se canceló',
    cuerpo: oraciones(
      `No se verificó tu placa en ${tituloZona(zona, reserva.id_zona)} ` +
        `antes de las ${hora(limiteDeLlegada(reserva))}`,
      `Se cobra el cargo de reserva (${pesos(CARGO_RESERVA)})`,
    ),
    canal: 'reservas',
    ttlSegundos: UNA_HORA_EN_SEGUNDOS,
  });

/** C2. El conductor canceló una reserva de una zona del encargado. */
export const canceladaPorConductor: ArmarAviso = ({ reserva, zona }) =>
  avisoDe(reserva, 'cancelada_por_conductor', 'controlador', {
    titulo: `El conductor canceló la reserva #${reserva.id}`,
    cuerpo: oraciones(
      `Placa ${placa(reserva)} en ${tituloZona(zona, reserva.id_zona)}`,
      'El cupo quedó libre',
    ),
    canal: 'solicitudes',
    ttlSegundos: UNA_HORA_EN_SEGUNDOS,
  });
