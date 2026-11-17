import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DrizzleService } from 'src/database/drizzle.service';
import { dispositivosPush } from 'src/database/schema';

/** Los teléfonos de cada usuario. Los registra auth-service (PUT /auth/token-push). */
@Injectable()
export class DispositivosRepository {
  constructor(private readonly drizzleService: DrizzleService) {}

  /** Los tokens de Expo de los teléfonos del usuario (puede no tener ninguno). */
  async tokensDe(idUsuario: string): Promise<string[]> {
    const filas = await this.drizzleService.db
      .select({ token: dispositivosPush.token })
      .from(dispositivosPush)
      .where(eq(dispositivosPush.id_usuario, idUsuario));

    return filas.map((fila) => fila.token);
  }

  /** Olvida un teléfono que ya no puede recibir avisos (desinstalaron la app o quitaron el permiso). */
  async borrar(token: string): Promise<void> {
    await this.drizzleService.db
      .delete(dispositivosPush)
      .where(eq(dispositivosPush.token, token));
  }
}
