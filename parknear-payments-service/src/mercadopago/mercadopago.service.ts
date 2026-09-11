import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import type { MercadoPagoPayment } from './dtos/mercadopago-payment.interface';
import type { ProcesarPagoDto } from './dtos/procesar-pago.dto';
import type { WebhookHeaders } from './dtos/webhook-headers.type';
import type { WebhookNotificationDto } from './dtos/webhook-notificacion.dto';

@Injectable()
export class MercadopagoService {
  private mpClient: MercadoPagoConfig;
  private mpSecret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.mpSecret = this.configService.get<string>('MERCADOPAGO_WEBHOOK_SECRET');
    
    // Aquí usas el ACCESS TOKEN (mantén esto en secreto en tu servidor)
    const accessToken = this.configService.get<string>('MERCADOPAGO_ACCESS_TOKEN');
    this.mpClient = new MercadoPagoConfig({ 
      accessToken: accessToken || '', 
      options: { timeout: 5000 } 
    });
  }

  // Crea el pago en Mercado Pago usando el token recibido
  async procesarPago(datosPago: ProcesarPagoDto): Promise<MercadoPagoPayment> {
    const payment = new Payment(this.mpClient);
    
    try {
      const response = await payment.create({
        body: {
          transaction_amount: datosPago.transaction_amount,
          token: datosPago.token, // Usamos el token generado en el frontend
          description: 'Reserva en ParkNear', // Puedes hacerlo dinámico
          installments: datosPago.installments || 1,
          payment_method_id: datosPago.payment_method_id,
          payer: {
            email: datosPago.payer.email,
          },
        }
      });
      return response as unknown as MercadoPagoPayment;
    } catch (error) {
      console.error('Error al procesar el pago en Mercado Pago:', error);
      throw error;
    }
  }

  async obtenerPagoPorId(id: string | number) {
    const payment = new Payment(this.mpClient);
    return (await payment.get({ id }));
  }

  validarNotificacion(headers: WebhookHeaders, cuerpo: WebhookNotificationDto): boolean {
    if (!this.mpSecret) return false;

    const signatureHeader = this.headerValue(headers, 'x-signature');
    const requestId = this.headerValue(headers, 'x-request-id');
    const dataId = cuerpo.data?.id;

    if (!signatureHeader || !requestId || dataId === undefined) return false;

    const { ts, v1 } = this.parseSignatureHeader(signatureHeader);
    if (!ts || !v1) return false;

    const manifest = `id:${String(dataId)};request-id:${requestId};ts:${ts};`;
    const expected = createHmac('sha256', this.mpSecret).update(manifest).digest('hex');

    return this.safeCompare(expected, v1);
  }

  private parseSignatureHeader(signatureHeader: string): { ts?: string; v1?: string } {
    const parts = signatureHeader.split(',');
    let ts: string | undefined;
    let v1: string | undefined;

    for (const part of parts) {
      const [rawKey, rawValue] = part.split('=');
      if (!rawKey || !rawValue) continue;
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (key === 'ts') ts = value;
      if (key === 'v1') v1 = value;
    }
    return { ts, v1 };
  }

  private headerValue(headers: WebhookHeaders, key: string): string | undefined {
    const value = headers[key] ?? headers[key.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private safeCompare(expected: string, received: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'hex');
    const receivedBuffer = Buffer.from(received, 'hex');
    if (expectedBuffer.length !== receivedBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }
}