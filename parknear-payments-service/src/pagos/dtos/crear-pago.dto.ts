import type { ProcesarPagoDto } from '../../mercadopago/dtos/procesar-pago.dto';

export interface CrearPagoDto {
  idReserva: number;
  datosPago: ProcesarPagoDto

}
