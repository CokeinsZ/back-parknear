import { Module } from '@nestjs/common';
import { ReservasController } from './reservas.controller';
import { ReservasService } from './reservas.service';
import { DatabaseModule } from 'src/database/database.module';
import { ReservasRepository } from './repositories/reservas.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [ReservasController],
  providers: [ReservasService, ReservasRepository],
  exports: [ReservasService],
})
export class ReservasModule {}
