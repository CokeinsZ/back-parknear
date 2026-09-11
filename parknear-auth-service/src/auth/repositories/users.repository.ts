import { Injectable } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DrizzleService } from 'src/database/drizzle.service';
import { EstadoUsuario, admin, conductores, controladores, usuarios } from 'src/database/schema';

export type TipoUsuario = 'conductor' | 'controlador' | 'admin' | null;

export interface AuthUserRecord {
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

interface CreateAuthUserInput {
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

@Injectable()
export class UsersRepository {
  constructor(private readonly drizzleService: DrizzleService) {}

  async create(input: CreateAuthUserInput): Promise<AuthUserRecord> {
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
      // Check if it's a unique constraint violation
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

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
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

  private async resolveTipoUsuario(userId: string): Promise<TipoUsuario> {
    const [conductor] = await this.drizzleService.db
      .select({ id: conductores.id })
      .from(conductores)
      .where(eq(conductores.id, userId));

    if (conductor) {
      return 'conductor';
    }

    const [controlador] = await this.drizzleService.db
      .select({ id: controladores.id })
      .from(controladores)
      .where(eq(controladores.id, userId));

    if (controlador) {
      return 'controlador';
    }

    const [adminUser] = await this.drizzleService.db
      .select({ id: admin.id })
      .from(admin)
      .where(eq(admin.id, userId));

    if (adminUser) {
      return 'admin';
    }

    return null;
  }
}
