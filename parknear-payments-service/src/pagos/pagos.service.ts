import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { DrizzleService } from '../database/drizzle.service';

@Injectable()
export class PagosService {
  constructor(private readonly drizzleService: DrizzleService) {}

  private get db() {
    return this.drizzleService.db;
  }

  async obtenerReserva(idReserva: number) {
    const reserva = await this.db.query.reservas.findFirst({
      where: eq(schema.reservas.id, idReserva),
    });
    return reserva ?? null;
  }

  async obtenerPagosPorReserva(idReserva: number) {
    return this.db.query.pagos.findMany({
      where: eq(schema.pagos.id_reserva, idReserva),
    });
  }

  /**
   * Crea un registro de pago inicial en estado pendiente antes de llamar a Mercado Pago.
   */
  async crearPagoPendiente(idReserva: number, monto: string) {
    const nuevoPago = await this.db
      .insert(schema.pagos)
      .values({
        id_reserva: idReserva,
        monto,
        metodo: 'mercadopago',
        estado: 'pendiente',
      })
      .returning();

    return nuevoPago[0];
  }

  /**
   * Guarda en DB la respuesta de Mercado Pago para un pago local ya creado.
   */
  async actualizarPagoDesdeProcesamiento(
    idPago: number,
    response: unknown,
  ) {
    const mpResponse = response as {
      id?: string | number;
      status?: string;
      status_detail?: string;
    };
    const estado = this.mapearEstadoMercadoPago(mpResponse.status);
    const actualizado = await this.db
      .update(schema.pagos)
      .set({
        estado,
        mp_id_transaccion: mpResponse.id ? String(mpResponse.id) : null,
        mp_payload: response,
        anotaciones: mpResponse.status_detail ? String(mpResponse.status_detail) : null,
        fecha_actualizacion: new Date(),
      })
      .where(eq(schema.pagos.id, idPago))
      .returning();

    return actualizado[0];
  }

  async obtenerPagoPorId(idPago: number) {
    const pago = await this.db.query.pagos.findFirst({
      where: eq(schema.pagos.id, idPago),
    });

    return pago ?? null;
  }

  async obtenerPagosPorUsuario(idUsuario: string) {
    return this.db
      .select({
        id: schema.pagos.id,
        id_reserva: schema.pagos.id_reserva,
        mp_id_transaccion: schema.pagos.mp_id_transaccion,
        monto: schema.pagos.monto,
        metodo: schema.pagos.metodo,
        estado: schema.pagos.estado,
        anotaciones: schema.pagos.anotaciones,
        fecha_creacion: schema.pagos.fecha_creacion,
        fecha_actualizacion: schema.pagos.fecha_actualizacion,
      })
      .from(schema.pagos)
      .innerJoin(schema.reservas, eq(schema.pagos.id_reserva, schema.reservas.id))
      .where(eq(schema.reservas.id_conductor, idUsuario))
      .orderBy(desc(schema.pagos.id));
  }

  /**
   * Crea un registro de pago inicial en estado 'pendiente'
   */
  async registrarIntentoDePago(idReserva: number, monto: string, mpIdTransaccion: string) {
    const nuevoPago = await this.db.insert(schema.pagos).values({
      id_reserva: idReserva,
      monto,
      metodo: 'mercadopago',
      estado: 'pendiente',
      mp_id_transaccion: mpIdTransaccion,
    }).returning();

    return nuevoPago[0];
  }

  /**
   * Actualiza el estado del pago y de la reserva basándose en la respuesta del Webhook
   */
  async procesarActualizacionMercadoPago(
    mpIdTransaccion: string,
    estadoMp: string,
    payloadCompleto: unknown,
  ) {
    const nuevoEstadoPago = this.mapearEstadoMercadoPago(estadoMp);

    // 1. Actualizamos la tabla de Pagos
    const pagoActualizado = await this.db
      .update(schema.pagos)
      .set({
        estado: nuevoEstadoPago,
        mp_payload: payloadCompleto, // Guardamos la data cruda por si hay auditorías
        fecha_actualizacion: new Date(),
      })
      .where(eq(schema.pagos.mp_id_transaccion, mpIdTransaccion))
      .returning();

    return pagoActualizado[0];
  }

  private mapearEstadoMercadoPago(
    estadoMp?: string,
  ): 'pendiente' | 'aprobado' | 'rechazado' | 'reembolzado' {
    switch (estadoMp) {
      case 'approved':
        return 'aprobado';
      case 'rejected':
      case 'cancelled':
        return 'rechazado';
      case 'refunded':
        return 'reembolzado';
      case 'in_process':
      case 'pending':
      default:
        return 'pendiente';
    }
  }
}