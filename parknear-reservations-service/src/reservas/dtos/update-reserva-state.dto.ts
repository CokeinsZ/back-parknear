import { IsIn } from 'class-validator';

/** Lo que el encargado puede pedir: aceptar (`activa`) o rechazar/cancelar (`cancelada`). */
export const ESTADOS_DEL_ENCARGADO = ['activa', 'cancelada'] as const;
export type EstadoDelEncargado = (typeof ESTADOS_DEL_ENCARGADO)[number];

/**
 * `completada` no se pide a mano: la pone el job cuando termina el tiempo. La llegada
 * tiene su propio endpoint (POST /reservas/:id/llegada).
 */
export class UpdateReservaStateDto {
  @IsIn(ESTADOS_DEL_ENCARGADO, {
    message:
      'estado debe ser activa (aceptar) o cancelada (rechazar o cancelar)',
  })
  estado!: EstadoDelEncargado;
}
