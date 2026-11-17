import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DispositivosRepository } from './dispositivos.repository';
import { NOTIFICADOR, type Notificador } from './notificador';
import { NotificadorConsola } from './notificador-consola';
import { NotificadorExpo } from './notificador-expo';

/**
 * Provee el `Notificador`. Es el único lugar que decide CÓMO se avisa:
 * - NOTIFICACIONES=consola: los avisos se escriben en el log (desarrollo y pruebas).
 * - cualquier otro valor (por defecto): Expo Push. EXPO_ACCESS_TOKEN solo hace falta si en
 *   expo.dev se activa "Enhanced push security".
 */
@Module({
  providers: [
    DispositivosRepository,
    {
      provide: NOTIFICADOR,
      inject: [DispositivosRepository, ConfigService],
      useFactory: (
        dispositivos: DispositivosRepository,
        config: ConfigService,
      ): Notificador =>
        config.get<string>('NOTIFICACIONES') === 'consola'
          ? new NotificadorConsola()
          : new NotificadorExpo(
              dispositivos,
              config.get<string>('EXPO_ACCESS_TOKEN') || undefined,
            ),
    },
  ],
  exports: [NOTIFICADOR],
})
export class NotificacionesModule {}
