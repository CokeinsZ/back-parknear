import { Module } from '@nestjs/common';
import { ReservasController } from './reservas.controller';
import { ReservasService } from './reservas.service';
import { DatabaseModule } from 'src/database/database.module';
import { ReservasRepository } from './repositories/reservas.repository';
import { VencimientoService } from './vencimiento.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ReservasController],
  providers: [ReservasService, ReservasRepository, VencimientoService],
  exports: [ReservasService],
})
export class ReservasModule {}
