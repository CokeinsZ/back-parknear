export class ZonaAzul {
  id!: number;
  latitud!: number;
  longitud!: number;
  indicaciones!: string;
  /** Cupos disponibles ahora, calculados (capacidad_total − reservas en curso). Solo lectura. */
  capacidad!: number;
  capacidad_total!: number;
}
