/** `capacidad` (los disponibles) no se recibe: la calcula el servidor. */
export class UpdateZonaDto {
  latitud?: number | string;
  longitud?: number | string;
  indicaciones?: string;
  capacidad_total?: number;
}
