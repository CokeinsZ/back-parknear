import { ConflictException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
  tipo_usuario?: 'conductor' | 'controlador' | 'admin';
}

@Injectable()
export class UsersRepository {
  constructor(private readonly drizzleService: DrizzleService) {}

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

  async findAll(): Promise<UserRecord[]> {
    const allUsers = await this.drizzleService.db.select().from(usuarios);

    const usersWithRole = await Promise.all(
      allUsers.map(async (usuario) => ({
        ...usuario,
        tipo_usuario: await this.resolveTipoUsuario(usuario.id),
      })),
    );

    return usersWithRole;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [usuario] = await this.drizzleService.db
      .select()
      .from(usuarios)
      .where(eq(usuarios.email, email));

    if (!usuario) {
      return null;
    }

    const tipo_usuario = await this.resolveTipoUsuario(usuario.id);

    return {
      ...usuario,
      tipo_usuario,
    };
  }

  async findByDocumento(documento: string): Promise<UserRecord | null> {
    const [usuario] = await this.drizzleService.db
      .select()
      .from(usuarios)
      .where(eq(usuarios.documento_identidad, documento));

    if (!usuario) {
      return null;
    }

    const tipo_usuario = await this.resolveTipoUsuario(usuario.id);

    return {
      ...usuario,
      tipo_usuario,
    };
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
        if (Object.keys(usuarioUpdate).length > 0) {
          await tx
            .update(usuarios)
            .set({
              ...usuarioUpdate,
              fecha_actualizacion: new Date(),
            } as typeof usuarios.$inferInsert)
            .where(eq(usuarios.documento_identidad, documento));
        }

        const [fresh] = await tx
          .select()
          .from(usuarios)
          .where(eq(usuarios.documento_identidad, documento));

        if (!fresh) {
          return;
        }

        const currentTipo = await this.resolveTipoUsuarioWithDb(
          tx as unknown as typeof this.drizzleService.db,
          fresh.id,
        );

        if (tipo_usuario !== undefined && tipo_usuario !== currentTipo) {
          if (currentTipo !== null) {
            throw new ConflictException('El tipo de usuario ya está asignado');
          }
          if (tipo_usuario === 'conductor') {
            await tx.insert(conductores).values({
              id: fresh.id,
              estado: fresh.estado,
            });
          } else if (tipo_usuario === 'controlador') {
            await tx.insert(controladores).values({
              id: fresh.id,
              estado: fresh.estado,
            });
          } else if (tipo_usuario === 'admin') {
            await tx.insert(admin).values({
              id: fresh.id,
              estado: 'activo',
            });
          }
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

  private async resolveTipoUsuario(userId: string): Promise<TipoUsuario> {
    return this.resolveTipoUsuarioWithDb(this.drizzleService.db, userId);
  }

  private async resolveTipoUsuarioWithDb(
    db: typeof this.drizzleService.db,
    userId: string,
  ): Promise<TipoUsuario> {
    const [conductor] = await db
      .select({ id: conductores.id })
      .from(conductores)
      .where(eq(conductores.id, userId));

    if (conductor) {
      return 'conductor';
    }

    const [controlador] = await db
      .select({ id: controladores.id })
      .from(controladores)
      .where(eq(controladores.id, userId));

    if (controlador) {
      return 'controlador';
    }

    const [adminUser] = await db
      .select({ id: admin.id })
      .from(admin)
      .where(eq(admin.id, userId));

    if (adminUser) {
      return 'admin';
    }

    return null;
  }
}
