import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateZonaDto } from './dto/create-zone.dto';
import { UpdateZonaDto } from './dto/update-zone.dto';
import { DrizzleService } from 'src/database/drizzle.service';
import { zonas_azules } from 'src/database/schema';
import { asc, count, eq, or, sql, type SQL } from 'drizzle-orm';
import {
  normalizarBusqueda,
  patronContiene,
  sinTildes,
  type Pagina,
  type Paginacion,
} from 'src/common/busqueda';

type Zona = typeof zonas_azules.$inferSelect;

/** `id`: por número de zona. `disponibles`: primero las que tienen cupo (para reservar). */
export type OrdenZonas = 'id' | 'disponibles';

@Injectable()
export class ZonasService {
  constructor(private readonly drizzleService: DrizzleService) {}

  async create(createZonaDto: CreateZonaDto) {
    const payload: any = { ...createZonaDto };
    if (payload.id) {
      delete payload.id;
    }
    const latitud = typeof payload.latitud === 'number' ? payload.latitud.toString() : payload.latitud;
    const longitud = typeof payload.longitud === 'number' ? payload.longitud.toString() : payload.longitud;

    const [zona] = await this.drizzleService.db.insert(zonas_azules).values({
      latitud: latitud,
      longitud: longitud,
      indicaciones: payload.indicaciones,
      capacidad: payload.capacidad,
      capacidad_total: payload.capacidad_total,
    }).returning();
    return zona;
  }

  /**
   * Una página de zonas. `q` busca en las indicaciones sin distinguir tildes ni
   * mayúsculas; si es un número ("12", "#12" o "zona 12") también trae esa zona.
   */
  async search(q: string | undefined, orden: OrdenZonas, { limit, offset }: Paginacion): Promise<Pagina<Zona>> {
    const busqueda = normalizarBusqueda(q);
    const filtro = busqueda ? this.filtroBusqueda(busqueda) : undefined;
    const ordenamiento =
      orden === 'disponibles'
        ? [sql`(${zonas_azules.capacidad} > 0) desc`, asc(zonas_azules.id)]
        : [asc(zonas_azules.id)];

    const [items, [conteo]] = await Promise.all([
      this.drizzleService.db
        .select()
        .from(zonas_azules)
        .where(filtro)
        .orderBy(...ordenamiento)
        .limit(limit)
        .offset(offset),
      this.drizzleService.db.select({ total: count() }).from(zonas_azules).where(filtro),
    ]);

    return { items, total: conteo?.total ?? 0, limit, offset };
  }

  private filtroBusqueda(busqueda: string): SQL | undefined {
    const porIndicaciones = sql`${sinTildes(zonas_azules.indicaciones)} like ${patronContiene(busqueda)}`;
    const numero = /^(?:zona\s*)?#?\s*(\d{1,9})$/.exec(busqueda)?.[1];

    return numero ? or(eq(zonas_azules.id, Number(numero)), porIndicaciones) : porIndicaciones;
  }

  /** Totales para las tarjetas de las pantallas, calculados en la base de datos. */
  async resumen(): Promise<{ total: number; con_cupo: number; cupos_disponibles: number }> {
    const [fila] = await this.drizzleService.db
      .select({
        total: count(),
        con_cupo: sql<number>`count(*) filter (where ${zonas_azules.capacidad} > 0)`.mapWith(Number),
        cupos_disponibles: sql<number>`coalesce(sum(greatest(${zonas_azules.capacidad}, 0)), 0)`.mapWith(Number),
      })
      .from(zonas_azules);

    return fila ?? { total: 0, con_cupo: 0, cupos_disponibles: 0 };
  }

  async findOne(id: number) {
    const [zona] = await this.drizzleService.db.select().from(zonas_azules).where(eq(zonas_azules.id, id));
    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return zona;
  }

  async update(id: number, updateZonaDto: UpdateZonaDto) {
    const payload: any = { ...updateZonaDto };
    if (payload.latitud && typeof payload.latitud === 'number') {
      payload.latitud = payload.latitud.toString();
    }
    if (payload.longitud && typeof payload.longitud === 'number') {
      payload.longitud = payload.longitud.toString();
    }

    const [zona] = await this.drizzleService.db.update(zonas_azules)
      .set(payload)
      .where(eq(zonas_azules.id, id))
      .returning();

    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return zona;
  }

  async remove(id: number) {
    const [zona] = await this.drizzleService.db.delete(zonas_azules)
      .where(eq(zonas_azules.id, id))
      .returning();

    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return { message: 'Zona eliminada' };
  }
}