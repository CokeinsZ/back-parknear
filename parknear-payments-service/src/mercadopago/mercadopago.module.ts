import { forwardRef, Module } from '@nestjs/common';
import { MercadopagoService } from './mercadopago.service';
import { MercadopagoController } from './mercadopago.controller';
import { PagosModule } from '../pagos/pagos.module';

@Module({
  imports: [forwardRef(() => PagosModule)],
  providers: [MercadopagoService],
  controllers: [MercadopagoController],
  exports: [MercadopagoService],
})
export class MercadopagoModule {}
