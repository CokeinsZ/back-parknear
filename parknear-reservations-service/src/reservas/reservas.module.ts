import { Module } from '@nestjs/common';
import { ReservasController } from './reservas.controller';
import { ReservasService } from './reservas.service';
import { DatabaseModule } from 'src/database/database.module';
import { NotificacionesModule } from 'src/notificaciones/notificaciones.module';
import { AvisosService } from './avisos.service';
import { ReservasRepository } from './repositories/reservas.repository';
import { VencimientoService } from './vencimiento.service';

@Module({
  imports: [DatabaseModule, NotificacionesModule],
  controllers: [ReservasController],
  providers: [
    ReservasService,
    ReservasRepository,
    VencimientoService,
    AvisosService,
  ],
  exports: [ReservasService],
})
export class ReservasModule {}
