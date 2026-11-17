import { Module } from '@nestjs/common';
import { DispositivosController } from './dispositivos.controller';
import { DispositivosRepository } from './dispositivos.repository';
import { DispositivosService } from './dispositivos.service';

/**
 * Teléfonos que reciben avisos push (PUT/DELETE /auth/token-push). Usa el `JwtAuthGuard`
 * de auth: la estrategia `jwt` la registra AuthModule para toda la aplicación.
 */
@Module({
  controllers: [DispositivosController],
  providers: [DispositivosService, DispositivosRepository],
})
export class DispositivosModule {}
