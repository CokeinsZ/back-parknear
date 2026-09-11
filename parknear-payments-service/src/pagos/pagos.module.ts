import { forwardRef, Module } from '@nestjs/common';
import { PagosController } from './pagos.controller';
import { PagosService } from './pagos.service';
import { DatabaseModule } from '../database/database.module';
import { MercadopagoModule } from '../mercadopago/mercadopago.module';

@Module({
  imports: [DatabaseModule, forwardRef(() => MercadopagoModule)],
  controllers: [PagosController],
  providers: [PagosService],
  exports: [PagosService],
})
export class PagosModule {}
