import { Logger } from '@nestjs/common';
import type { Aviso, Notificador } from './notificador';

/**
 * Escribe los avisos en el log en vez de enviarlos. Sirve para desarrollar y probar el
 * flujo sin teléfono ni credenciales (NOTIFICACIONES=consola).
 */
export class NotificadorConsola implements Notificador {
  private readonly logger = new Logger(NotificadorConsola.name);

  avisar(idUsuario: string, aviso: Aviso): Promise<void> {
    this.logger.log(
      `[${aviso.datos.tipo} → ${idUsuario}] ${aviso.titulo}: ${aviso.cuerpo}`,
    );
    return Promise.resolve();
  }
}
