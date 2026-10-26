/** `capacidad` (los disponibles) no se recibe: la calcula el servidor. */
export class CreateZonaDto {
  latitud!: number | string;
  longitud!: number | string;
  indicaciones!: string;
  capacidad_total!: number;
}
