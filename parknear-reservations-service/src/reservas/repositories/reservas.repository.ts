import { Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DrizzleService } from 'src/database/drizzle.service';
import * as schema from 'src/database/schema';
import { EstadoReserva, ReservaRecord } from '../interfaces/reserva.interface';

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

  async findByUserId(userId: string): Promise<ReservaRecord[]> {
    return this.db
      .select()
      .from(schema.reservas)
      .where(eq(schema.reservas.id_conductor, userId))
      .orderBy(desc(schema.reservas.id));
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

  async findCompleteByZonaId(zonaId: number) {
    return this.db
      .select({
        reserva: schema.reservas,
        conductor: schema.usuarios,
        vehiculo: schema.vehiculos,
      })
      .from(schema.reservas)
      .leftJoin(schema.usuarios, eq(schema.reservas.id_conductor, schema.usuarios.id))
      .leftJoin(schema.vehiculos, eq(schema.reservas.id_vehiculo, schema.vehiculos.placa))
      .where(eq(schema.reservas.id_zona, zonaId))
      .orderBy(desc(schema.reservas.id));
  }
}
