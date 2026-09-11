import { Module } from '@nestjs/common';
import { ZonasController } from './zones.controller';
import { ZonasService } from './zones.service';
import { DatabaseModule } from 'src/database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [ZonasController],
  providers: [ZonasService],
})
export class ZonasModule {}