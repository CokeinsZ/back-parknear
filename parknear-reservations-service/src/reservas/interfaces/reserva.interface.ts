import { estadoReservaEnum } from 'src/database/schema';

export type EstadoReserva = (typeof estadoReservaEnum.enumValues)[number];

/** Lo que el encargado ve del conductor. Nunca incluye la contraseña. */
export interface ConductorDeReserva {
  id: string;
  documento_identidad: string;
  primer_nombre: string;
  segundo_nombre: string | null;
  primer_apellido: string;
  segundo_apellido: string | null;
  email: string;
  celular: string;
}

/** Lo justo de la zona para mostrar su nombre junto a la reserva. */
export interface ZonaDeReserva {
  id: number;
  indicaciones: string | null;
}

/** Conteo de reservas por estado. */
export interface ResumenReservas {
  total: number;
  pendiente: number;
  activa: number;
  completada: number;
  cancelada: number;
}

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
