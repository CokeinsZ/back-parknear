import { estadoReservaEnum } from 'src/database/schema';

export type EstadoReserva = (typeof estadoReservaEnum.enumValues)[number];

export interface ReservaRecord {
  id: number;
  id_conductor: string | null;
  id_zona: number | null;
  id_vehiculo: string | null;
  fecha_real_inicio: Date;
  fecha_fin: Date | null;
  precio: string;
  estado: EstadoReserva;
  fecha_creacion: Date;
  fecha_actualizacion: Date;
}
