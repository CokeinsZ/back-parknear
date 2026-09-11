import {
	BadRequestException,
	Body,
	Controller,
	Get,
	NotFoundException,
	Param,
	ParseIntPipe,
	Post,
	UseGuards,
} from '@nestjs/common';
import { PagosService } from './pagos.service';
import { MercadopagoService } from '../mercadopago/mercadopago.service';
import type { CrearPagoDto } from './dtos/crear-pago.dto';
import type { CrearPagoResultado } from './dtos/pago-resultado.interface';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('pagos')
export class PagosController {
	constructor(
		private readonly pagosService: PagosService,
		private readonly mercadopagoService: MercadopagoService,
	) {}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('CONDUCTOR')
	@Post()
	async crearPago(@Body() body: CrearPagoDto): Promise<CrearPagoResultado> {
		if (!body?.idReserva || !body?.datosPago?.token || !body?.datosPago?.payer?.email) {
			throw new BadRequestException('Faltan campos obligatorios para crear el pago');
		}

		// Obtenemos el precio directamente desde la reserva en DB
		const reserva = await this.pagosService.obtenerReserva(body.idReserva);
		if (!reserva) {
			throw new NotFoundException('Reserva no encontrada');
		}

		// Validamos pagos anteriores en caso de que la reserva se haya extendido
		const pagosPrevios = await this.pagosService.obtenerPagosPorReserva(body.idReserva);
		const montoPagado = pagosPrevios
			.filter(p => p.estado === 'aprobado')
			.reduce((sum, p) => sum + Number(p.monto), 0);
		
		const montoTotal = Number(reserva.precio);
		const montoPendiente = montoTotal - montoPagado;

		if (montoPendiente <= 0) {
			throw new BadRequestException('La reserva ya se encuentra totalmente pagada');
		}

		const pagoPendiente = await this.pagosService.crearPagoPendiente(body.idReserva, String(montoPendiente));

		const respuestaMp = await this.mercadopagoService.procesarPago({
			...body.datosPago,
			transaction_amount: montoPendiente,
		});

		const pagoActualizado = await this.pagosService.actualizarPagoDesdeProcesamiento(
			pagoPendiente.id,
			respuestaMp,
		);

		return {
			pago: pagoActualizado,
			mercadopago: {
				id: respuestaMp.id,
				status: respuestaMp.status,
				status_detail: respuestaMp.status_detail,
			},
		};
	}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONDUCTOR')
	@Get(':idPago')
	async obtenerPago(@Param('idPago', ParseIntPipe) idPago: number) {
		const pago = await this.pagosService.obtenerPagoPorId(idPago);
		if (!pago) {
			throw new NotFoundException('Pago no encontrado');
		}

		return pago;
	}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONDUCTOR')
	@Get('usuario/:idUsuario')
	async obtenerPagosPorUsuario(@Param('idUsuario') idUsuario: string) {
		return this.pagosService.obtenerPagosPorUsuario(idUsuario);
	}
}
