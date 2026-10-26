import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  patronContiene,
  sinTildes,
  type Paginacion,
} from 'src/common/busqueda';
import { DrizzleService } from 'src/database/drizzle.service';
import { esReintentable } from 'src/database/errores';
import * as schema from 'src/database/schema';
import {
  CARGO_RESERVA,
  HORAS_MAX,
  MINUTOS_PARA_LLEGAR,
  TARIFA_HORA,
  ahoraUtc,
  precioPorHoras,
} from '../reglas';
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
  return sql<number>`count(*) filter (where ${schema.reservas.estado} = ${estado})`.mapWith(
    Number,
  );
}

type Db = DrizzleService['db'];
type Transaccion = Parameters<Parameters<Db['transaction']>[0]>[0];
/** La conexión normal o una transacción en curso. */
type Ejecutor = Db | Transaccion;

const minutosParaLlegar = sql`make_interval(mins => ${MINUTOS_PARA_LLEGAR}::int)`;
/** Número fijo del candado del job (pg_try_advisory_xact_lock). */
const CANDADO_VENCIMIENTO = 72_100_415;
/** Reintentos de una transacción que falló por deadlock o serialización. */
const REINTENTOS = 2;

/** Por qué no se pudo crear la reserva (el servicio lo traduce a la respuesta HTTP). */
export type ErrorAlCrear =
  | 'VEHICULO_AJENO'
  | 'VEHICULO_CON_RESERVA'
  | 'ZONA_NO_EXISTE'
  | 'ZONA_SIN_CUPO';

/**
 * Resultado de una transición con guarda: la reserva cambiada o, si la guarda no
 * dejó cambiarla, cómo quedó (`null` si no existe) para que el servicio explique por qué.
 */
export type ResultadoTransicion =
  | { reserva: ReservaRecord; actual?: undefined }
  | { reserva?: undefined; actual: ReservaRecord | null };

@Injectable()
export class ReservasRepository {
  constructor(private readonly drizzleService: DrizzleService) {}

  private get db() {
    return this.drizzleService.db;
  }

  /** Corre `fn` en una transacción; si choca por deadlock o serialización, la reintenta. */
  private async transaccion<T>(
    fn: (tx: Transaccion) => Promise<T>,
  ): Promise<T> {
    for (let intento = 0; ; intento++) {
      try {
        return await this.db.transaction(fn);
      } catch (error) {
        if (intento >= REINTENTOS || !esReintentable(error)) throw error;
      }
    }
  }

  /**
   * Cancela las reservas cuyo conductor no llegó en 15 minutos (solo cobra el cargo) y
   * completa las parqueadas cuyo tiempo terminó. No toca fechas. Idempotente: con la guarda
   * en el WHERE, correrlo dos veces o a la vez que otro cambio no hace nada dos veces.
   * `filtro` lo limita a una reserva o a un vehículo.
   */
  async vencer(ejecutor: Ejecutor = this.db, filtro?: SQL) {
    const canceladas = await ejecutor
      .update(schema.reservas)
      .set({
        estado: 'cancelada',
        precio: CARGO_RESERVA.toFixed(2),
        fecha_actualizacion: ahoraUtc,
      })
      .where(
        and(
          inArray(schema.reservas.estado, ['pendiente', 'activa']),
          isNull(schema.reservas.fecha_real_inicio),
          sql`${schema.reservas.fecha_creacion} <= ${ahoraUtc} - ${minutosParaLlegar}`,
          filtro,
        ),
      )
      .returning({ id: schema.reservas.id });

    const completadas = await ejecutor
      .update(schema.reservas)
      .set({ estado: 'completada', fecha_actualizacion: ahoraUtc })
      .where(
        and(
          eq(schema.reservas.estado, 'activa'),
          isNotNull(schema.reservas.fecha_real_inicio),
          sql`${schema.reservas.fecha_fin} <= ${ahoraUtc}`,
          filtro,
        ),
      )
      .returning({ id: schema.reservas.id });

    return { canceladas: canceladas.length, completadas: completadas.length };
  }

  /** Lo que corre el job. Si otra réplica ya está venciendo, no hace nada y devuelve null. */
  async vencerConCandado() {
    return this.db.transaction(async (tx) => {
      const [fila] = await tx.execute<{ libre: boolean }>(
        sql`select pg_try_advisory_xact_lock(${CANDADO_VENCIMIENTO}::bigint) as libre`,
      );
      return fila?.libre ? this.vencer(tx) : null;
    });
  }

  /**
   * Crea la reserva solo si el vehículo es del conductor, no tiene otra en curso y la
   * zona tiene cupo, todo en una transacción. Orden de bloqueo fijo: vehículo y luego
   * zona (nadie bloquea en orden inverso, así que no hay deadlocks).
   */
  async crearConCupo(input: {
    idConductor: string;
    idZona: number;
    placa: string;
    horas: number;
  }): Promise<
    | { reserva: ReservaRecord; error?: undefined }
    | { reserva?: undefined; error: ErrorAlCrear }
  > {
    return this.transaccion(async (tx) => {
      // 1. El vehículo es del conductor. Bloquearlo pone en fila las reservas del mismo vehículo.
      const [vehiculo] = await tx
        .select({ placa: schema.vehiculos.placa })
        .from(schema.vehiculos)
        .where(
          and(
            eq(schema.vehiculos.placa, input.placa),
            eq(schema.vehiculos.id_conductor, input.idConductor),
          ),
        )
        .for('update');
      if (!vehiculo) return { error: 'VEHICULO_AJENO' as const };

      // 2. Vence lo que ya debió vencer de este vehículo (el job puede no haber pasado aún).
      await this.vencer(tx, eq(schema.reservas.id_vehiculo, input.placa));

      // 3. Una reserva en curso por vehículo.
      const [enCurso] = await tx
        .select({ id: schema.reservas.id })
        .from(schema.reservas)
        .where(
          and(
            eq(schema.reservas.id_vehiculo, input.placa),
            inArray(schema.reservas.estado, ['pendiente', 'activa']),
          ),
        )
        .limit(1);
      if (enCurso) return { error: 'VEHICULO_CON_RESERVA' as const };

      // 4. Bloquea la zona: quien llegue después espera aquí, y su conteo ya incluye esta reserva.
      const [zona] = await tx
        .select({ total: schema.zonasAzules.capacidad_total })
        .from(schema.zonasAzules)
        .where(eq(schema.zonasAzules.id, input.idZona))
        .for('update');
      if (!zona) return { error: 'ZONA_NO_EXISTE' as const };

      const [{ ocupados }] = await tx
        .select({ ocupados: count() })
        .from(schema.reservasEnCurso)
        .where(eq(schema.reservasEnCurso.id_zona, input.idZona));
      if (ocupados >= zona.total) return { error: 'ZONA_SIN_CUPO' as const };

      // 5. Crea la reserva con el reloj de la base de datos. fecha_real_inicio queda NULL hasta la llegada.
      const [reserva] = await tx
        .insert(schema.reservas)
        .values({
          id_conductor: input.idConductor,
          id_zona: input.idZona,
          id_vehiculo: input.placa,
          fecha_creacion: ahoraUtc,
          fecha_actualizacion: ahoraUtc,
          fecha_fin: sql`${ahoraUtc} + make_interval(hours => ${input.horas}::int)`,
          precio: precioPorHoras(input.horas),
          estado: 'pendiente',
        })
        .returning();
      return { reserva };
    });
  }

  /** Aceptar (pendiente → activa) o cancelar, con guarda. No toca fechas. Primero vence lo vencido. */
  async cambiarEstado(
    id: number,
    estado: 'activa' | 'cancelada',
  ): Promise<ResultadoTransicion> {
    return this.transaccion(async (tx) => {
      const deEsta = eq(schema.reservas.id, id);
      // Así una aceptación tardía no revive una reserva que ya venció.
      await this.vencer(tx, deEsta);

      const [reserva] =
        estado === 'activa'
          ? await tx
              .update(schema.reservas)
              .set({ estado: 'activa', fecha_actualizacion: ahoraUtc })
              .where(and(deEsta, eq(schema.reservas.estado, 'pendiente')))
              .returning()
          : await tx
              .update(schema.reservas)
              .set({
                estado: 'cancelada',
                // Sin llegada solo se cobra el cargo de reserva; con llegada, lo reservado.
                precio: sql`case when ${schema.reservas.fecha_real_inicio} is null
                             then ${CARGO_RESERVA.toFixed(2)}::numeric else ${schema.reservas.precio} end`,
                fecha_actualizacion: ahoraUtc,
              })
              .where(
                and(
                  deEsta,
                  inArray(schema.reservas.estado, ['pendiente', 'activa']),
                ),
              )
              .returning();

      if (reserva) return { reserva };
      return {
        actual: (await tx.query.reservas.findFirst({ where: deEsta })) ?? null,
      };
    });
  }

  /** El encargado verificó la placa: registra la llegada. La reserva sigue activa y fecha_fin no cambia. */
  async confirmarLlegada(id: number): Promise<ResultadoTransicion> {
    return this.transaccion(async (tx) => {
      const deEsta = eq(schema.reservas.id, id);
      await this.vencer(tx, deEsta);

      const [reserva] = await tx
        .update(schema.reservas)
        .set({ fecha_real_inicio: ahoraUtc, fecha_actualizacion: ahoraUtc })
        .where(
          and(
            deEsta,
            eq(schema.reservas.estado, 'activa'),
            isNull(schema.reservas.fecha_real_inicio),
          ),
        )
        .returning();

      if (reserva) return { reserva };
      return {
        actual: (await tx.query.reservas.findFirst({ where: deEsta })) ?? null,
      };
    });
  }

  /** Suma horas a una reserva en curso del conductor, sin pasar de HORAS_MAX desde la creación. */
  async extender(
    id: number,
    idConductor: string,
    horas: number,
  ): Promise<ResultadoTransicion> {
    return this.transaccion(async (tx) => {
      const deEsta = eq(schema.reservas.id, id);
      await this.vencer(tx, deEsta);
      const extra = sql`make_interval(hours => ${horas}::int)`;

      const [reserva] = await tx
        .update(schema.reservas)
        .set({
          fecha_fin: sql`${schema.reservas.fecha_fin} + ${extra}`,
          precio: sql`${schema.reservas.precio} + ${(horas * TARIFA_HORA).toFixed(2)}::numeric`,
          fecha_actualizacion: ahoraUtc,
        })
        .where(
          and(
            deEsta,
            eq(schema.reservas.id_conductor, idConductor),
            inArray(schema.reservas.estado, ['pendiente', 'activa']),
            sql`${schema.reservas.fecha_fin} + ${extra}
                <= ${schema.reservas.fecha_creacion} + make_interval(hours => ${HORAS_MAX}::int)`,
          ),
        )
        .returning();

      if (reserva) return { reserva };
      return {
        actual: (await tx.query.reservas.findFirst({ where: deEsta })) ?? null,
      };
    });
  }

  async findById(id: number): Promise<ReservaRecord | null> {
    const reserva = await this.db.query.reservas.findFirst({
      where: eq(schema.reservas.id, id),
    });

    return reserva ?? null;
  }

  /**
   * Una página de reservas del conductor, la más reciente primero, con el nombre de su zona.
   * Con `soloEnCurso`, solo las que ocupan un cupo ahora mismo (vista `reservas_en_curso`).
   */
  async findByUserId(
    userId: string,
    { limit, offset }: Paginacion,
    soloEnCurso = false,
  ) {
    const filtro = and(
      eq(schema.reservas.id_conductor, userId),
      soloEnCurso
        ? inArray(
            schema.reservas.id,
            this.db
              .select({ id: schema.reservasEnCurso.id })
              .from(schema.reservasEnCurso),
          )
        : undefined,
    );

    const [items, [conteo]] = await Promise.all([
      this.db
        .select({ reserva: schema.reservas, zona: columnasZona })
        .from(schema.reservas)
        .leftJoin(
          schema.zonasAzules,
          eq(schema.reservas.id_zona, schema.zonasAzules.id),
        )
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
      .where(
        idConductor ? eq(schema.reservas.id_conductor, idConductor) : undefined,
      );

    return (
      fila ?? { total: 0, pendiente: 0, activa: 0, completada: 0, cancelada: 0 }
    );
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
      .leftJoin(
        schema.usuarios,
        eq(schema.reservas.id_conductor, schema.usuarios.id),
      )
      .leftJoin(
        schema.vehiculos,
        eq(schema.reservas.id_vehiculo, schema.vehiculos.placa),
      )
      .leftJoin(
        schema.zonasAzules,
        eq(schema.reservas.id_zona, schema.zonasAzules.id),
      )
      .$dynamic();
  }

  async findCompleteByZonaId(zonaId: number) {
    return this.consultaCompleta()
      .where(eq(schema.reservas.id_zona, zonaId))
      .orderBy(desc(schema.reservas.id));
  }

  async findCompleteById(id: number) {
    const [fila] = await this.consultaCompleta()
      .where(eq(schema.reservas.id, id))
      .limit(1);
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
        .leftJoin(
          schema.usuarios,
          eq(schema.reservas.id_conductor, schema.usuarios.id),
        )
        .leftJoin(
          schema.zonasAzules,
          eq(schema.reservas.id_zona, schema.zonasAzules.id),
        )
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
      condiciones.push(
        eq(schema.reservas.id, Number(numeroReserva[1] ?? numeroReserva[2])),
      );
    }
    const numeroZona = /^zona\s*#?\s*(\d{1,9})$/.exec(busqueda);
    if (numeroZona) {
      condiciones.push(eq(schema.reservas.id_zona, Number(numeroZona[1])));
    }

    return or(...condiciones);
  }
}
