import type { MercadoPagoPayment } from '../../mercadopago/dtos/mercadopago-payment.interface';

export interface CrearPagoResultado {
  pago: {
    id: number;
    id_reserva: number | null;
    mp_id_transaccion: string | null;
    monto: string;
    metodo: 'efectivo' | 'mercadopago';
    estado: 'pendiente' | 'aprobado' | 'rechazado' | 'reembolzado';
    anotaciones: string | null;
    fecha_creacion: Date | null;
    fecha_actualizacion: Date | null;
    mp_payload: unknown;
  } | undefined;
  mercadopago: Pick<MercadoPagoPayment, 'id' | 'status' | 'status_detail'>;
}
