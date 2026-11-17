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
  type SQLWrapper,
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
  MINUTOS_DE_AVISO,
  MINUTOS_PARA_LLEGAR,
  TARIFA_HORA,
  ahoraUtc,
  precioPorHoras,
} from '../reglas';
import type { TipoAviso } from '../avisos';
import {
  EstadoReserva,
  ReservaConZona,
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
const minutosDeAviso = sql`make_interval(mins => ${MINUTOS_DE_AVISO}::int)`;
/** Hasta cuándo tiene el conductor para que le verifiquen la placa. */
const limiteDeLlegada = sql`${schema.reservas.fecha_creacion} + ${minutosParaLlegar}`;
/** "No llegaste" solo se avisa de cancelaciones recientes: al desplegar no salen avisos de las viejas. */
const ventanaAvisoNoLlego = sql`make_interval(mins => 30)`;
/** Número fijo del candado del job (pg_try_advisory_xact_lock). */
const CANDADO_VENCIMIENTO = 72_100_415;
/** Reintentos de una transacción que falló por deadlock o serialización. */
const REINTENTOS = 2;

/** Por qué no se pudo crear la reserva (el servicio lo traduce a la respuesta HTTP). */
export type ErrorAlCrear =
  | 'VEHICULO_AJENO'
  | 'VEHICULO_CON_RESERVA'
  | 'ZONA_NO_EXISTE'
  | 'ZONA_NO_OPERATIVA'
  | 'ZONA_SIN_CUPO';

/**
 * Resultado de una transición con guarda: la reserva cambiada o, si la guarda no
 * dejó cambiarla, cómo quedó (`null` si no existe) para que el servicio explique por qué.
 */
export type ResultadoTransicion =
  | { reserva: ReservaRecord; actual?: undefined }
  | { reserva?: undefined; actual: ReservaRecord | null };

/** Los avisos que programa el job (los demás salen en el momento del cambio). */
type TipoAvisoProgramado = Extract<
  TipoAviso,
  'recordatorio_llegada' | 'recordatorio_fin' | 'no_llego'
>;

/** Ids de las reservas cuyos avisos programados ya tocan: el job los reclamó y hay que enviarlos. */
export interface AvisosReclamados {
  recordatorioLlegada: number[];
  recordatorioFin: number[];
  noLlego: number[];
}

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

  /**
   * Lo que corre el job: vence lo vencido y reclama los avisos programados que ya tocan, en
   * la misma transacción. Si otra réplica ya está en eso, no hace nada y devuelve null.
   */
  async vencerConCandado() {
    return this.db.transaction(async (tx) => {
      const [fila] = await tx.execute<{ libre: boolean }>(
        sql`select pg_try_advisory_xact_lock(${CANDADO_VENCIMIENTO}::bigint) as libre`,
      );
      if (!fila?.libre) return null;

      const vencidas = await this.vencer(tx);
      // Después de vencer: una reserva que se acaba de cancelar ya no recibe recordatorios.
      const avisos = await this.reclamarAvisos(tx);
      return { ...vencidas, avisos };
    });
  }

  /**
   * Reclama los avisos programados que ya toca enviar: los anota en `avisos_reserva` y
   * devuelve los ids de sus reservas. Lo ya anotado no se repite, así que correrlo cada
   * minuto, o en dos réplicas, nunca envía un aviso dos veces. Si la reserva cambió (llegó,
   * se canceló, terminó), la condición deja de cumplirse y el aviso no sale; si se extendió,
   * la referencia (`fecha_fin`) es otra y el recordatorio de fin sale a la nueva hora.
   */
  private async reclamarAvisos(tx: Transaccion): Promise<AvisosReclamados> {
    const { reservas } = schema;

    // A1: faltan 5 minutos o menos para el límite de llegada y nadie ha verificado la placa.
    const recordatorioLlegada = await this.reclamar(
      tx,
      'recordatorio_llegada',
      limiteDeLlegada,
      [
        inArray(reservas.estado, ['pendiente', 'activa']),
        isNull(reservas.fecha_real_inicio),
        sql`${ahoraUtc} >= ${limiteDeLlegada} - ${minutosDeAviso}`,
        sql`${ahoraUtc} < ${limiteDeLlegada}`,
      ],
    );

    // A2: el vehículo está parqueado y faltan 5 minutos o menos para su `fecha_fin` actual.
    const recordatorioFin = await this.reclamar(
      tx,
      'recordatorio_fin',
      reservas.fecha_fin,
      [
        eq(reservas.estado, 'activa'),
        isNotNull(reservas.fecha_real_inicio),
        sql`${ahoraUtc} >= ${reservas.fecha_fin} - ${minutosDeAviso}`,
        sql`${ahoraUtc} < ${reservas.fecha_fin}`,
      ],
    );

    // B5: se canceló sin llegada cuando el plazo ya había vencido. La pudo cancelar este job
    // o una acción tardía (cada transición vence primero), por eso se mira el estado y no quién.
    const noLlego = await this.reclamar(tx, 'no_llego', limiteDeLlegada, [
      eq(reservas.estado, 'cancelada'),
      isNull(reservas.fecha_real_inicio),
      sql`${reservas.fecha_actualizacion} >= ${limiteDeLlegada}`,
      sql`${reservas.fecha_actualizacion} > ${ahoraUtc} - ${ventanaAvisoNoLlego}`,
    ]);

    return { recordatorioLlegada, recordatorioFin, noLlego };
  }

  /**
   * Anota en `avisos_reserva` un aviso `tipo` para cada reserva que cumple `condiciones`, con
   * `referencia` como la fecha que lo originó, y devuelve los ids de las que se anotaron ahora.
   */
  private async reclamar(
    tx: Transaccion,
    tipo: TipoAvisoProgramado,
    referencia: SQLWrapper,
    condiciones: SQL[],
  ): Promise<number[]> {
    const filas = await tx.execute<{ id_reserva: number }>(sql`
      insert into ${schema.avisosReserva} (id_reserva, tipo, referencia)
      select ${schema.reservas.id}, ${tipo}, ${referencia}
        from ${schema.reservas}
       where ${sql.join(condiciones, sql` and `)}
      on conflict do nothing
      returning id_reserva`);

    return filas.map((fila) => fila.id_reserva);
  }

  /** Las reservas con su zona, para armar los textos de los avisos. */
  async reservasConZona(ids: number[]): Promise<ReservaConZona[]> {
    if (ids.length === 0) return [];

    return this.db
      .select({ reserva: schema.reservas, zona: columnasZona })
      .from(schema.reservas)
      .leftJoin(
        schema.zonasAzules,
        eq(schema.reservas.id_zona, schema.zonasAzules.id),
      )
      .where(inArray(schema.reservas.id, ids));
  }

  /**
   * Crea la reserva solo si el vehículo es del conductor, no tiene otra en curso y la
   * zona está operativa y con cupo, todo en una transacción. Orden de bloqueo fijo: vehículo y luego
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
        .select({
          total: schema.zonasAzules.capacidad_total,
          estado: schema.zonasAzules.estado,
        })
        .from(schema.zonasAzules)
        .where(eq(schema.zonasAzules.id, input.idZona))
        .for('update');
      if (!zona) return { error: 'ZONA_NO_EXISTE' as const };
      if (zona.estado !== 'operativa') {
        return { error: 'ZONA_NO_OPERATIVA' as const };
      }

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

  /** Cambio que pide el conductor dueño, con guarda. Primero vence lo vencido. No toca las fechas de la reserva. */
  private transicionDelConductor(
    id: number,
    idConductor: string,
    cambios: Partial<typeof schema.reservas.$inferInsert>,
    guarda: SQL | undefined,
  ): Promise<ResultadoTransicion> {
    return this.transaccion(async (tx) => {
      const deEsta = eq(schema.reservas.id, id);
      await this.vencer(tx, deEsta);

      const [reserva] = await tx
        .update(schema.reservas)
        .set({ ...cambios, fecha_actualizacion: ahoraUtc })
        .where(
          and(deEsta, eq(schema.reservas.id_conductor, idConductor), guarda),
        )
        .returning();

      if (reserva) return { reserva };
      return {
        actual: (await tx.query.reservas.findFirst({ where: deEsta })) ?? null,
      };
    });
  }

  /** El conductor cancela su reserva mientras no le hayan verificado la placa: solo se cobra el cargo de reserva. */
  cancelarPorConductor(
    id: number,
    idConductor: string,
  ): Promise<ResultadoTransicion> {
    return this.transicionDelConductor(
      id,
      idConductor,
      { estado: 'cancelada', precio: CARGO_RESERVA.toFixed(2) },
      and(
        inArray(schema.reservas.estado, ['pendiente', 'activa']),
        isNull(schema.reservas.fecha_real_inicio),
      ),
    );
  }

  /**
   * El conductor termina su reserva con la placa ya verificada (`fecha_real_inicio`):
   * libera el cupo y conserva el precio completo. `fecha_fin` sigue siendo el fin reservado;
   * cuándo terminó de verdad queda en `fecha_actualizacion`.
   */
  terminarPorConductor(
    id: number,
    idConductor: string,
  ): Promise<ResultadoTransicion> {
    return this.transicionDelConductor(
      id,
      idConductor,
      { estado: 'completada' },
      and(
        eq(schema.reservas.estado, 'activa'),
        isNotNull(schema.reservas.fecha_real_inicio),
      ),
    );
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

  /** Filtro: las reservas de las zonas asignadas a un controlador. */
  private deZonasAsignadas(idControlador: string): SQL {
    return inArray(
      schema.reservas.id_zona,
      this.db
        .select({ id: schema.zonasControladores.id_zona })
        .from(schema.zonasControladores)
        .where(eq(schema.zonasControladores.id_controlador, idControlador)),
    );
  }

  /** Si la zona está asignada al controlador. */
  async tieneZonaAsignada(
    idControlador: string,
    idZona: number,
  ): Promise<boolean> {
    const [asignacion] = await this.db
      .select({ id: schema.zonasControladores.id_zona })
      .from(schema.zonasControladores)
      .where(
        and(
          eq(schema.zonasControladores.id_controlador, idControlador),
          eq(schema.zonasControladores.id_zona, idZona),
        ),
      )
      .limit(1);

    return asignacion !== undefined;
  }

  /** Los encargados que atienden la zona: a ellos les llegan sus reservas. Puede no haber ninguno. */
  async controladoresDeZona(idZona: number): Promise<string[]> {
    const filas = await this.db
      .select({ id: schema.zonasControladores.id_controlador })
      .from(schema.zonasControladores)
      .where(eq(schema.zonasControladores.id_zona, idZona));

    return filas.map((fila) => fila.id);
  }

  /** Cuántas reservas hay en cada estado: todas, las de un conductor o las de las zonas de un controlador. */
  async resumen({
    idConductor,
    idControlador,
  }: {
    idConductor?: string;
    idControlador?: string;
  } = {}): Promise<ResumenReservas> {
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
        and(
          idConductor
            ? eq(schema.reservas.id_conductor, idConductor)
            : undefined,
          idControlador ? this.deZonasAsignadas(idControlador) : undefined,
        ),
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
   * Una página de reservas, primero las que necesitan atención. Con
   * `idControlador`, solo las de sus zonas asignadas. `busqueda` (ya normalizada)
   * se compara con la placa, el nombre y documento del conductor, las
   * indicaciones de la zona, "#12" (número de reserva) y "zona 3".
   */
  async search(
    busqueda: string | null,
    estado: EstadoReserva | null,
    { limit, offset }: Paginacion,
    idControlador?: string,
  ) {
    const filtro = and(
      estado ? eq(schema.reservas.estado, estado) : undefined,
      busqueda ? this.filtroBusqueda(busqueda) : undefined,
      idControlador ? this.deZonasAsignadas(idControlador) : undefined,
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
