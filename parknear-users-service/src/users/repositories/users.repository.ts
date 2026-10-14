import { ConflictException, Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  patronContiene,
  sinTildes,
  type Paginacion,
} from 'src/common/busqueda';
import { DrizzleService } from 'src/database/drizzle.service';
import {
  EstadoUsuario,
  admin,
  conductores,
  controladores,
  usuarios,
  vehiculos,
} from 'src/database/schema';

export type TipoUsuario = 'conductor' | 'controlador' | 'admin' | null;
export type TipoAsignable = Exclude<TipoUsuario, null>;

type Db = DrizzleService['db'];

/**
 * Un usuario es de un tipo si tiene fila en esa tabla (`conductores`,
 * `controladores` o `admin`) y la fila no está marcada 'eliminado'.
 *
 * Al cambiar el tipo, la fila del tipo anterior NO se borra: vehículos,
 * reservas y pagos apuntan a `conductores` con ON DELETE RESTRICT y se
 * perdería el historial. Se marca 'eliminado' y deja de contar.
 * auth-service usa exactamente el mismo criterio al iniciar sesión.
 */
function tipoVigente(estado: AnyColumn): SQL {
  return sql`${estado} is distinct from 'eliminado'`;
}

/** Si por datos viejos quedara más de un tipo vigente, gana el mismo orden que siempre. */
const tipoUsuarioSql = sql<TipoUsuario>`case
  when ${conductores.id} is not null then 'conductor'
  when ${controladores.id} is not null then 'controlador'
  when ${admin.id} is not null then 'admin'
end`;

export interface UserRecord {
  id: string;
  documento_identidad: string;
  primer_nombre: string;
  segundo_nombre: string | null;
  primer_apellido: string;
  segundo_apellido: string | null;
  email: string;
  contrasena: string;
  celular: string;
  estado: EstadoUsuario;
  fecha_creacion: Date;
  fecha_actualizacion: Date;
  tipo_usuario: TipoUsuario;
}

export interface VehiculoRecord {
  placa: string;
  id_conductor: string | null;
  marca: string | null;
  color: string | null;
}

interface CreateUserInput {
  documento_identidad: string;
  primer_nombre: string;
  segundo_nombre?: string;
  primer_apellido: string;
  segundo_apellido?: string;
  email: string;
  contrasena: string;
  celular: string;
  estado?: EstadoUsuario;
  tipo_usuario?: Exclude<TipoUsuario, null>;
}

export interface UpdateUsuarioFields {
  primer_nombre?: string;
  segundo_nombre?: string | null;
  primer_apellido?: string;
  segundo_apellido?: string | null;
  email?: string;
  contrasena?: string;
  celular?: string;
  estado?: EstadoUsuario;
  tipo_usuario?: TipoAsignable;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly drizzleService: DrizzleService) {}

  private get db(): Db {
    return this.drizzleService.db;
  }

  /** `usuarios` con su `tipo_usuario` resuelto en la misma consulta (sin una consulta por usuario). */
  private consultaUsuarios(db: Db = this.db) {
    return db
      .select({ ...getTableColumns(usuarios), tipo_usuario: tipoUsuarioSql })
      .from(usuarios)
      .leftJoin(
        conductores,
        and(eq(conductores.id, usuarios.id), tipoVigente(conductores.estado)),
      )
      .leftJoin(
        controladores,
        and(eq(controladores.id, usuarios.id), tipoVigente(controladores.estado)),
      )
      .leftJoin(admin, and(eq(admin.id, usuarios.id), tipoVigente(admin.estado)))
      .$dynamic();
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const estado = input.estado ?? 'inactivo';

    try {
      return await this.drizzleService.db.transaction(async (tx) => {
        const [usuario] = await tx
          .insert(usuarios)
          .values({
            documento_identidad: input.documento_identidad,
            primer_nombre: input.primer_nombre,
            segundo_nombre: input.segundo_nombre ?? null,
            primer_apellido: input.primer_apellido,
            segundo_apellido: input.segundo_apellido ?? null,
            email: input.email,
            contrasena: input.contrasena,
            celular: input.celular,
            estado,
          })
          .returning();

        if (!usuario) {
          throw new Error('No se pudo crear el usuario');
        }

        if (input.tipo_usuario === 'conductor') {
          await tx.insert(conductores).values({
            id: usuario.id,
            estado,
          });
        }

        if (input.tipo_usuario === 'controlador') {
          await tx.insert(controladores).values({
            id: usuario.id,
            estado,
          });
        }

        if (input.tipo_usuario === 'admin') {
          await tx.insert(admin).values({
            id: usuario.id,
            estado: 'activo',
          });
        }

        return {
          ...usuario,
          tipo_usuario: input.tipo_usuario ?? null,
        };
      });
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('El usuario ya existe');
      }
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    const pending: unknown[] = [error];

    while (pending.length > 0) {
      const current = pending.shift();
      if (typeof current !== 'object' || current === null) {
        continue;
      }

      const err = current as Record<string, unknown>;
      const code = String(err.code ?? '');
      const message = String(err.message ?? '').toLowerCase();
      const detail = String(err.detail ?? '').toLowerCase();
      const constraint = String(err.constraint ?? '').toLowerCase();

      if (
        code === '23505' ||
        message.includes('duplicate key value') ||
        message.includes('unique constraint') ||
        detail.includes('unique') ||
        constraint.includes('usuarios_')
      ) {
        return true;
      }

      if ('cause' in err) pending.push(err.cause);
      if ('originalError' in err) pending.push(err.originalError);
      if ('error' in err) pending.push(err.error);
    }

    return false;
  }

  /**
   * Una página de usuarios, los más recientes primero. `busqueda` (ya
   * normalizada) se compara con el nombre completo, el correo y el documento.
   */
  async search(
    busqueda: string | null,
    { limit, offset }: Paginacion,
  ): Promise<{ items: UserRecord[]; total: number }> {
    const filtro = busqueda ? this.filtroBusqueda(busqueda) : undefined;

    const [items, [conteo]] = await Promise.all([
      this.consultaUsuarios()
        .where(filtro)
        .orderBy(desc(usuarios.fecha_creacion), desc(usuarios.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(usuarios).where(filtro),
    ]);

    return { items, total: conteo?.total ?? 0 };
  }

  private filtroBusqueda(busqueda: string): SQL | undefined {
    const patron = patronContiene(busqueda);
    const nombreCompleto = sql`concat_ws(' ', ${usuarios.primer_nombre}, ${usuarios.segundo_nombre}, ${usuarios.primer_apellido}, ${usuarios.segundo_apellido})`;

    return or(
      sql`${sinTildes(nombreCompleto)} like ${patron}`,
      sql`${sinTildes(usuarios.email)} like ${patron}`,
      sql`${usuarios.documento_identidad} like ${patron}`,
    );
  }

  /** Totales para las tarjetas del panel, calculados en la base de datos. */
  async resumen(): Promise<{ total: number; activos: number }> {
    const [fila] = await this.db
      .select({
        total: count(),
        activos: sql<number>`count(*) filter (where ${usuarios.estado} = 'activo')`.mapWith(
          Number,
        ),
      })
      .from(usuarios);

    return fila ?? { total: 0, activos: 0 };
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [usuario] = await this.consultaUsuarios()
      .where(eq(usuarios.email, email))
      .limit(1);

    return usuario ?? null;
  }

  async findByDocumento(documento: string): Promise<UserRecord | null> {
    const [usuario] = await this.consultaUsuarios()
      .where(eq(usuarios.documento_identidad, documento))
      .limit(1);

    return usuario ?? null;
  }

  async insertVehiculoForConductor(
    conductorId: string,
    input: { placa: string; marca?: string | null; color?: string | null },
  ): Promise<VehiculoRecord> {
    const placa = input.placa.trim().slice(0, 10);
    const marca =
      input.marca != null && String(input.marca).trim() !== ''
        ? String(input.marca).trim().slice(0, 32)
        : null;
    const color =
      input.color != null && String(input.color).trim() !== ''
        ? String(input.color).trim().slice(0, 32)
        : null;

    try {
      const [row] = await this.drizzleService.db
        .insert(vehiculos)
        .values({
          placa,
          id_conductor: conductorId,
          marca,
          color,
        })
        .returning({
          placa: vehiculos.placa,
          id_conductor: vehiculos.id_conductor,
          marca: vehiculos.marca,
          color: vehiculos.color,
        });

      if (!row) {
        throw new Error('No se pudo registrar el vehículo');
      }

      return row;
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Ya existe un vehículo con esa placa');
      }
      throw error;
    }
  }

  async findVehiculosByConductorId(
    conductorId: string,
  ): Promise<VehiculoRecord[]> {
    return this.drizzleService.db
      .select({
        placa: vehiculos.placa,
        id_conductor: vehiculos.id_conductor,
        marca: vehiculos.marca,
        color: vehiculos.color,
      })
      .from(vehiculos)
      .where(eq(vehiculos.id_conductor, conductorId));
  }

  async updateVehiculo(
    conductorId: string,
    placa: string,
    input: { placa?: string; marca?: string; color?: string },
  ): Promise<VehiculoRecord | null> {
    const values: Partial<typeof vehiculos.$inferInsert> = {};

    if (input.marca) {
      values.marca = input.marca.trim().slice(0, 32);
    }
    if (input.color) {
      values.color = input.color.trim().slice(0, 32);
    }

    if (Object.keys(values).length === 0) {
      const [existing] = await this.drizzleService.db
        .select({
          placa: vehiculos.placa,
          id_conductor: vehiculos.id_conductor,
          marca: vehiculos.marca,
          color: vehiculos.color,
        })
        .from(vehiculos)
        .where(
          and(
            eq(vehiculos.placa, placa),
            eq(vehiculos.id_conductor, conductorId),
          ),
        );

      return existing ?? null;
    }

    try {
      const [updated] = await this.drizzleService.db
        .update(vehiculos)
        .set(values)
        .where(
          and(
            eq(vehiculos.placa, placa),
            eq(vehiculos.id_conductor, conductorId),
          ),
        )
        .returning({
          placa: vehiculos.placa,
          id_conductor: vehiculos.id_conductor,
          marca: vehiculos.marca,
          color: vehiculos.color,
        });

      return updated ?? null;
    } catch (error: unknown) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Ya existe un vehículo con esa placa');
      }
      throw error;
    }
  }

  async deleteVehiculo(conductorId: string, placa: string): Promise<boolean> {
    const deleted = await this.drizzleService.db
      .delete(vehiculos)
      .where(
        and(
          eq(vehiculos.placa, placa),
          eq(vehiculos.id_conductor, conductorId),
        ),
      )
      .returning({ id_conductor: vehiculos.id_conductor });

    return deleted[0]?.id_conductor === conductorId;
  }

  async updateByDocumento(
    documento: string,
    fields: UpdateUsuarioFields,
  ): Promise<UserRecord | null> {
    const existing = await this.findByDocumento(documento);
    if (!existing) {
      return null;
    }

    const { tipo_usuario, ...usuarioCols } = fields;

    const usuarioUpdate = Object.fromEntries(
      Object.entries(usuarioCols).filter(([, v]) => v !== undefined),
    ) as Record<string, unknown>;

    try {
      await this.drizzleService.db.transaction(async (tx) => {
        // Cambiar solo el tipo también cuenta como actualización del usuario.
        if (Object.keys(usuarioUpdate).length > 0 || tipo_usuario !== undefined) {
          await tx
            .update(usuarios)
            .set({
              ...usuarioUpdate,
              fecha_actualizacion: new Date(),
            } as typeof usuarios.$inferInsert)
            .where(eq(usuarios.documento_identidad, documento));
        }

        if (tipo_usuario !== undefined) {
          await this.asignarTipo(tx as unknown as Db, existing.id, tipo_usuario);
        }
      });
    } catch (error: unknown) {
      if (error instanceof ConflictException) {
        throw error;
      }
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          'El email u otro campo único ya está registrado',
        );
      }
      throw error;
    }

    return this.findByDocumento(documento);
  }

  /**
   * Deja al usuario con un solo tipo vigente: marca 'eliminado' la fila de los
   * otros tipos y crea (o reactiva, si ya la tuvo) la del tipo nuevo. Asignar el
   * mismo tipo que ya tiene no cambia nada, salvo limpiar tipos duplicados de
   * datos viejos. Va dentro de la transacción de `updateByDocumento`.
   */
  private async asignarTipo(tx: Db, id: string, tipo: TipoAsignable) {
    if (tipo !== 'conductor') {
      await tx
        .update(conductores)
        .set({ estado: 'eliminado' })
        .where(and(eq(conductores.id, id), tipoVigente(conductores.estado)));
    }
    if (tipo !== 'controlador') {
      await tx
        .update(controladores)
        .set({ estado: 'eliminado' })
        .where(and(eq(controladores.id, id), tipoVigente(controladores.estado)));
    }
    if (tipo !== 'admin') {
      await tx
        .update(admin)
        .set({ estado: 'eliminado' })
        .where(and(eq(admin.id, id), tipoVigente(admin.estado)));
    }

    if (tipo === 'conductor') {
      await tx
        .insert(conductores)
        .values({ id, estado: 'activo' })
        .onConflictDoUpdate({ target: conductores.id, set: { estado: 'activo' } });
    } else if (tipo === 'controlador') {
      await tx
        .insert(controladores)
        .values({ id, estado: 'activo' })
        .onConflictDoUpdate({ target: controladores.id, set: { estado: 'activo' } });
    } else {
      await tx
        .insert(admin)
        .values({ id, estado: 'activo' })
        .onConflictDoUpdate({ target: admin.id, set: { estado: 'activo' } });
    }
  }
}
