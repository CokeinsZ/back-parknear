import { Body, Controller, Headers, Post, UnauthorizedException, Res, HttpStatus } from '@nestjs/common';
import { MercadopagoService } from './mercadopago.service';
import type { Response } from 'express';
import { PagosService } from '../pagos/pagos.service';
import type { ProcesarPagoDto } from './dtos/procesar-pago.dto';
import type { WebhookHeaders } from './dtos/webhook-headers.type';
import type { WebhookNotificationDto } from './dtos/webhook-notificacion.dto';

@Controller('mercadopago')
export class MercadopagoController {
  constructor(
    private readonly mercadopagoService: MercadopagoService,
    private readonly pagosService: PagosService,
  ) {}

  // Endpoint llamado desde tu frontend
  @Post('procesar-pago')
  async crearPago(
    @Body() cuerpoPago: ProcesarPagoDto,
    @Res() res: Response
  ) {
    try {
      const resultado = await this.mercadopagoService.procesarPago(cuerpoPago);
      
      return res.status(HttpStatus.CREATED).json({
        status: resultado.status,
        status_detail: resultado.status_detail,
        id: resultado.id,
      });
    } catch (error) {
      return res.status(HttpStatus.BAD_REQUEST).json({ 
        error: 'No se pudo procesar el pago',
      });
    }
  }

  // Endpoint llamado por los servidores de Mercado Pago
  @Post('notificacion')
  async notificacion(
    @Body() cuerpo: WebhookNotificationDto,
    @Headers() headers: WebhookHeaders,
    @Res() res: Response
  ) {
    const esValida = this.mercadopagoService.validarNotificacion(headers, cuerpo);
    if (!esValida) {
      throw new UnauthorizedException('Firma de webhook de Mercado Pago invalida');
    }

    // Responder 200 OK inmediatamente para evitar timeouts
    res.status(HttpStatus.OK).send('OK');

    try {
      if (cuerpo.type === 'payment' && cuerpo.data?.id) {
        // Consultamos el estado real en Mercado Pago
        const paymentInfo = await this.mercadopagoService.obtenerPagoPorId(cuerpo.data.id);

        if (!paymentInfo.id || !paymentInfo.status) {
          return;
        }
        
        // Pasamos la responsabilidad a tu módulo de negocio (Drizzle)
        await this.pagosService.procesarActualizacionMercadoPago(
          paymentInfo.id.toString(), 
          paymentInfo.status, 
          paymentInfo // El payload completo para el campo JSONB
        );
      }
    } catch (error) {
      console.error('Error procesando la notificación:', error);
    }
  }
}