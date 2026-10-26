import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateZonaDto } from './dto/create-zone.dto';
import { UpdateZonaDto } from './dto/update-zone.dto';
import { DrizzleService } from 'src/database/drizzle.service';
import {
  reservasEnCurso,
  zonas_azules,
  zonasConDisponibilidad,
} from 'src/database/schema';
import { asc, count, eq, or, sql, type SQL } from 'drizzle-orm';
import {
  normalizarBusqueda,
  patronContiene,
  sinTildes,
  type Pagina,
  type Paginacion,
} from 'src/common/busqueda';

/** La zona como la ve la app: `capacidad` = cupos disponibles ahora, calculados por la vista. */
type Zona = typeof zonasConDisponibilidad.$inferSelect;

/** `id`: por número de zona. `disponibles`: primero las que tienen cupo (para reservar). */
export type OrdenZonas = 'id' | 'disponibles';

/** Lo que el admin puede cambiar de una zona. */
interface CambiosZona {
  latitud?: string;
  longitud?: string;
  indicaciones?: string;
  capacidad_total?: number;
}

/** Máximo de un `integer` de Postgres. */
const ENTERO_MAXIMO = 2_147_483_647;

/** `capacidad_total` como entero ≥ 0 (acepta número o texto numérico); si no, 400. */
function leerCapacidadTotal(valor: unknown): number {
  const numero =
    typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  if (
    typeof numero !== 'number' ||
    !Number.isInteger(numero) ||
    numero < 0 ||
    numero > ENTERO_MAXIMO
  ) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      codigo: 'CAPACIDAD_TOTAL_INVALIDA',
      message:
        'La capacidad total debe ser un número entero mayor o igual a 0.',
    });
  }
  return numero;
}

const comoTexto = (valor: number | string) =>
  typeof valor === 'number' ? valor.toString() : valor;

@Injectable()
export class ZonasService {
  constructor(private readonly drizzleService: DrizzleService) {}

  /** Crea la zona. `capacidad` (los disponibles) se ignora: la calcula la vista. */
  async create(createZonaDto: CreateZonaDto) {
    const capacidadTotal = leerCapacidadTotal(createZonaDto.capacidad_total);

    const [zona] = await this.drizzleService.db
      .insert(zonas_azules)
      .values({
        latitud: comoTexto(createZonaDto.latitud),
        longitud: comoTexto(createZonaDto.longitud),
        indicaciones: createZonaDto.indicaciones,
        capacidad_total: capacidadTotal,
      })
      .returning({ id: zonas_azules.id });
    return this.findOne(zona.id);
  }

  /**
   * Una página de zonas. `q` busca en las indicaciones sin distinguir tildes ni
   * mayúsculas; si es un número ("12", "#12" o "zona 12") también trae esa zona.
   */
  async search(
    q: string | undefined,
    orden: OrdenZonas,
    { limit, offset }: Paginacion,
  ): Promise<Pagina<Zona>> {
    const busqueda = normalizarBusqueda(q);
    const filtro = busqueda ? this.filtroBusqueda(busqueda) : undefined;
    const ordenamiento =
      orden === 'disponibles'
        ? [
            sql`(${zonasConDisponibilidad.capacidad} > 0) desc`,
            asc(zonasConDisponibilidad.id),
          ]
        : [asc(zonasConDisponibilidad.id)];

    const [items, [conteo]] = await Promise.all([
      this.drizzleService.db
        .select()
        .from(zonasConDisponibilidad)
        .where(filtro)
        .orderBy(...ordenamiento)
        .limit(limit)
        .offset(offset),
      this.drizzleService.db
        .select({ total: count() })
        .from(zonasConDisponibilidad)
        .where(filtro),
    ]);

    return { items, total: conteo?.total ?? 0, limit, offset };
  }

  private filtroBusqueda(busqueda: string): SQL | undefined {
    const porIndicaciones = sql`${sinTildes(zonasConDisponibilidad.indicaciones)} like ${patronContiene(busqueda)}`;
    const numero = /^(?:zona\s*)?#?\s*(\d{1,9})$/.exec(busqueda)?.[1];

    return numero
      ? or(eq(zonasConDisponibilidad.id, Number(numero)), porIndicaciones)
      : porIndicaciones;
  }

  /** Totales para las tarjetas de las pantallas, calculados en la base de datos. */
  async resumen(): Promise<{
    total: number;
    con_cupo: number;
    cupos_disponibles: number;
  }> {
    const [fila] = await this.drizzleService.db
      .select({
        total: count(),
        con_cupo:
          sql<number>`count(*) filter (where ${zonasConDisponibilidad.capacidad} > 0)`.mapWith(
            Number,
          ),
        cupos_disponibles:
          sql<number>`coalesce(sum(${zonasConDisponibilidad.capacidad}), 0)`.mapWith(
            Number,
          ),
      })
      .from(zonasConDisponibilidad);

    return fila ?? { total: 0, con_cupo: 0, cupos_disponibles: 0 };
  }

  async findOne(id: number): Promise<Zona> {
    const [zona] = await this.drizzleService.db
      .select()
      .from(zonasConDisponibilidad)
      .where(eq(zonasConDisponibilidad.id, id));
    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return zona;
  }

  /**
   * Edita los campos de la zona que llegan. `capacidad` se ignora. La capacidad total no
   * puede quedar por debajo de las reservas en curso: se revisa con la zona bloqueada, el
   * mismo bloqueo que toma reservations al crear una reserva.
   */
  async update(id: number, updateZonaDto: UpdateZonaDto) {
    const cambios: CambiosZona = {};
    if (updateZonaDto.latitud !== undefined) {
      cambios.latitud = comoTexto(updateZonaDto.latitud);
    }
    if (updateZonaDto.longitud !== undefined) {
      cambios.longitud = comoTexto(updateZonaDto.longitud);
    }
    if (updateZonaDto.indicaciones !== undefined) {
      cambios.indicaciones = updateZonaDto.indicaciones;
    }
    if (updateZonaDto.capacidad_total !== undefined) {
      cambios.capacidad_total = leerCapacidadTotal(
        updateZonaDto.capacidad_total,
      );
    }

    await this.drizzleService.db.transaction(async (tx) => {
      const [zona] = await tx
        .select({ id: zonas_azules.id })
        .from(zonas_azules)
        .where(eq(zonas_azules.id, id))
        .for('update');
      if (!zona) throw new NotFoundException('Zona no encontrada');

      if (cambios.capacidad_total !== undefined) {
        const [{ ocupados }] = await tx
          .select({ ocupados: count() })
          .from(reservasEnCurso)
          .where(eq(reservasEnCurso.id_zona, id));
        if (cambios.capacidad_total < ocupados) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            codigo: 'CAPACIDAD_MENOR_A_OCUPADOS',
            message: `La zona tiene ${ocupados} reservas en curso; la capacidad total no puede ser menor.`,
          });
        }
      }

      if (Object.keys(cambios).length > 0) {
        await tx
          .update(zonas_azules)
          .set(cambios)
          .where(eq(zonas_azules.id, id));
      }
    });
    return this.findOne(id);
  }

  async remove(id: number) {
    const [zona] = await this.drizzleService.db
      .delete(zonas_azules)
      .where(eq(zonas_azules.id, id))
      .returning();

    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return { message: 'Zona eliminada' };
  }
}
