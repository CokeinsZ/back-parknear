import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DrizzleService } from 'src/database/drizzle.service';
import { dispositivosPush } from 'src/database/schema';

/** "Ahora" en UTC, como se guardan las columnas `timestamp` (sin zona). */
const ahoraUtc = sql`(now() at time zone 'utc')`;

@Injectable()
export class DispositivosRepository {
  constructor(private readonly drizzleService: DrizzleService) {}

  /**
   * Deja el teléfono a nombre de `idUsuario`. Si estaba a nombre de otra cuenta (un
   * teléfono compartido), pasa a esta: así nadie recibe los avisos de otra persona.
   */
  async registrar(idUsuario: string, token: string): Promise<void> {
    await this.drizzleService.db
      .insert(dispositivosPush)
      .values({ token, id_usuario: idUsuario, fecha_actualizacion: ahoraUtc })
      .onConflictDoUpdate({
        target: dispositivosPush.token,
        set: { id_usuario: idUsuario, fecha_actualizacion: ahoraUtc },
      });
  }

  /** Quita el teléfono, solo si está a nombre de `idUsuario`. */
  async quitar(idUsuario: string, token: string): Promise<void> {
    await this.drizzleService.db
      .delete(dispositivosPush)
      .where(
        and(
          eq(dispositivosPush.token, token),
          eq(dispositivosPush.id_usuario, idUsuario),
        ),
      );
  }
}
