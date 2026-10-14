import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { patronContiene, sinTildes, type Paginacion } from 'src/common/busqueda';
import { DrizzleService } from 'src/database/drizzle.service';
import * as schema from 'src/database/schema';
import {
  EstadoReserva,
  ReservaRecord,
  ResumenReservas,
} from '../interfaces/reserva.interface';

/** Columnas del conductor que se devuelven con la reserva: sin la contraseña. */
const columnasConductor = {
  id: schema.usuarios.id,
  documento_identidad: schema.usuarios.documento_identidad,
  primer_nombre: schema.usuarios.primer_nombre,
  segundo_nombre: schema.usuarios.segundo_nombre,
  primer_apellido: schema.usuarios.primer_apellido,
  segundo_apellido: schema.usuarios.segundo_apellido,
  email: schema.usuarios.email,
  celular: schema.usuarios.celular,
};

const columnasZona = {
  id: schema.zonasAzules.id,
  indicaciones: schema.zonasAzules.indicaciones,
};

/** Primero lo que necesita atención del encargado: pendientes, luego activas, luego el resto. */
const prioridadEstado = sql`case ${schema.reservas.estado} when 'pendiente' then 0 when 'activa' then 1 else 2 end`;

function conteoPorEstado(estado: EstadoReserva) {
  return sql<number>`count(*) filter (where ${schema.reservas.estado} = ${estado})`.mapWith(Number);
}

interface CreateReservaInput {
  id_conductor: string;
  id_zona: number;
  id_vehiculo: string;
  fecha_real_inicio: Date;
  fecha_fin: Date | null;
  precio: string;
  estado: EstadoReserva;
}

@Injectable()
export class ReservasRepository {
  constructor(private readonly drizzleService: DrizzleService) {}

  private get db() {
    return this.drizzleService.db;
  }

  async create(input: CreateReservaInput): Promise<ReservaRecord | null> {
    const [reserva] = await this.db.insert(schema.reservas).values(input).returning();
    return reserva ?? null;
  }

  async findById(id: number): Promise<ReservaRecord | null> {
    const reserva = await this.db.query.reservas.findFirst({
      where: eq(schema.reservas.id, id),
    });

    return reserva ?? null;
  }

  /** Una página de reservas del conductor, la más reciente primero, con el nombre de su zona. */
  async findByUserId(userId: string, { limit, offset }: Paginacion) {
    const filtro = eq(schema.reservas.id_conductor, userId);

    const [items, [conteo]] = await Promise.all([
      this.db
        .select({ reserva: schema.reservas, zona: columnasZona })
        .from(schema.reservas)
        .leftJoin(schema.zonasAzules, eq(schema.reservas.id_zona, schema.zonasAzules.id))
        .where(filtro)
        .orderBy(desc(schema.reservas.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(schema.reservas).where(filtro),
    ]);

    return { items, total: conteo?.total ?? 0 };
  }

  /** Cuántas reservas hay en cada estado: todas, o solo las de un conductor. */
  async resumen(idConductor?: string): Promise<ResumenReservas> {
    const [fila] = await this.db
      .select({
        total: count(),
        pendiente: conteoPorEstado('pendiente'),
        activa: conteoPorEstado('activa'),
        completada: conteoPorEstado('completada'),
        cancelada: conteoPorEstado('cancelada'),
      })
      .from(schema.reservas)
      .where(idConductor ? eq(schema.reservas.id_conductor, idConductor) : undefined);

    return fila ?? { total: 0, pendiente: 0, activa: 0, completada: 0, cancelada: 0 };
  }

  async updateStateWithPrice(
    id: number,
    estado: EstadoReserva,
    fecha_fin: Date | null,
    fecha_real_inicio: Date,
    precio: string,
  ): Promise<ReservaRecord | null> {
    const [updatedReserva] = await this.db
      .update(schema.reservas)
      .set({
        estado,
        fecha_fin,
        fecha_real_inicio,
        precio,
        fecha_actualizacion: new Date(),
      })
      .where(eq(schema.reservas.id, id))
      .returning();

    return updatedReserva ?? null;
  }

  async decrementCapacity(idZona: number): Promise<void> {
    await this.db
      .update(schema.zonasAzules)
      .set({ capacidad: sql`${schema.zonasAzules.capacidad} - 1` })
      .where(eq(schema.zonasAzules.id, idZona));
  }

  async incrementCapacity(idZona: number): Promise<void> {
    await this.db
      .update(schema.zonasAzules)
      .set({ capacidad: sql`${schema.zonasAzules.capacidad} + 1` })
      .where(eq(schema.zonasAzules.id, idZona));
  }

  /** La reserva con su conductor, su vehículo y su zona. */
  private consultaCompleta() {
    return this.db
      .select({
        reserva: schema.reservas,
        conductor: columnasConductor,
        vehiculo: schema.vehiculos,
        zona: columnasZona,
      })
      .from(schema.reservas)
      .leftJoin(schema.usuarios, eq(schema.reservas.id_conductor, schema.usuarios.id))
      .leftJoin(schema.vehiculos, eq(schema.reservas.id_vehiculo, schema.vehiculos.placa))
      .leftJoin(schema.zonasAzules, eq(schema.reservas.id_zona, schema.zonasAzules.id))
      .$dynamic();
  }

  async findCompleteByZonaId(zonaId: number) {
    return this.consultaCompleta()
      .where(eq(schema.reservas.id_zona, zonaId))
      .orderBy(desc(schema.reservas.id));
  }

  async findCompleteById(id: number) {
    const [fila] = await this.consultaCompleta().where(eq(schema.reservas.id, id)).limit(1);
    return fila ?? null;
  }

  /**
   * Una página de reservas de todas las zonas, primero las que necesitan
   * atención. `busqueda` (ya normalizada) se compara con la placa, el nombre y
   * documento del conductor, las indicaciones de la zona, "#12" (número de
   * reserva) y "zona 3".
   */
  async search(
    busqueda: string | null,
    estado: EstadoReserva | null,
    { limit, offset }: Paginacion,
  ) {
    const filtro = and(
      estado ? eq(schema.reservas.estado, estado) : undefined,
      busqueda ? this.filtroBusqueda(busqueda) : undefined,
    );

    const [items, [conteo]] = await Promise.all([
      this.consultaCompleta()
        .where(filtro)
        .orderBy(prioridadEstado, desc(schema.reservas.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(schema.reservas)
        .leftJoin(schema.usuarios, eq(schema.reservas.id_conductor, schema.usuarios.id))
        .leftJoin(schema.zonasAzules, eq(schema.reservas.id_zona, schema.zonasAzules.id))
        .where(filtro),
    ]);

    return { items, total: conteo?.total ?? 0 };
  }

  private filtroBusqueda(busqueda: string): SQL | undefined {
    const patron = patronContiene(busqueda);
    const nombreConductor = sql`concat_ws(' ', ${schema.usuarios.primer_nombre}, ${schema.usuarios.segundo_nombre}, ${schema.usuarios.primer_apellido}, ${schema.usuarios.segundo_apellido})`;

    const condiciones: (SQL | undefined)[] = [
      sql`lower(${schema.reservas.id_vehiculo}) like ${patron}`,
      sql`${sinTildes(nombreConductor)} like ${patron}`,
      sql`${schema.usuarios.documento_identidad} like ${patron}`,
      sql`${sinTildes(schema.zonasAzules.indicaciones)} like ${patron}`,
    ];

    const numeroReserva = /^#\s*(\d{1,9})$|^(\d{1,9})$/.exec(busqueda);
    if (numeroReserva) {
      condiciones.push(eq(schema.reservas.id, Number(numeroReserva[1] ?? numeroReserva[2])));
    }
    const numeroZona = /^zona\s*#?\s*(\d{1,9})$/.exec(busqueda);
    if (numeroZona) {
      condiciones.push(eq(schema.reservas.id_zona, Number(numeroZona[1])));
    }

    return or(...condiciones);
  }
}
