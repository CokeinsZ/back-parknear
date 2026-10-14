import {
	Body,
	Controller,
	Get,
	Param,
	ParseIntPipe,
	ParseUUIDPipe,
	Post,
	Patch,
	Put,
	Query,
	Request,
	UseGuards,
} from '@nestjs/common';
import { leerPaginacion } from 'src/common/busqueda';
import { CreateReservaDto } from './dtos/create-reserva.dto';
import { UpdateReservaStateDto } from './dtos/update-reserva-state.dto';
import { ExtendReservaDto } from './dtos/extend-reserva.dto';
import { ReservasService, type Solicitante } from './reservas.service';
import { ReservaRecord } from './interfaces/reserva.interface';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('reservas')
export class ReservasController {
	constructor(private readonly reservasService: ReservasService) {}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('CONDUCTOR')
	@Post()
	async create(@Body() createReservaDto: CreateReservaDto): Promise<ReservaRecord> {
		return this.reservasService.create(createReservaDto);
	}

	/**
	 * GET /reservas?q=texto&estado=pendiente&limit=20&offset=0 -> { items, total, limit, offset }
	 * Reservas de todas las zonas, cada una con su conductor, vehículo y zona.
	 */
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONTROLADOR')
	@Get()
	async search(
		@Query('q') q?: string,
		@Query('estado') estado?: string,
		@Query('limit') limit?: string,
		@Query('offset') offset?: string,
	) {
		return this.reservasService.search(q, estado, leerPaginacion(limit, offset));
	}

	/** GET /reservas/resumen -> { total, pendiente, activa, completada, cancelada }. Va antes de `:id`. */
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONTROLADOR')
	@Get('resumen')
	async resumen() {
		return this.reservasService.resumen();
	}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONDUCTOR')
	@Get(':id')
	async findById(@Param('id', ParseIntPipe) id: number): Promise<ReservaRecord> {
		return this.reservasService.findById(id);
	}

	/** GET /reservas/user/:id?limit=20&offset=0 -> { items: [{ reserva, zona }], total, limit, offset } */
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONDUCTOR')
	@Get('user/:id')
	async findByUserId(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Request() req: { user: Solicitante },
		@Query('limit') limit?: string,
		@Query('offset') offset?: string,
	) {
		return this.reservasService.findByUserId(id, req.user, leerPaginacion(limit, offset));
	}

	/** GET /reservas/user/:id/resumen -> conteo por estado de las reservas del conductor. */
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONDUCTOR')
	@Get('user/:id/resumen')
	async resumenDeConductor(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Request() req: { user: Solicitante },
	) {
		return this.reservasService.resumenDeConductor(id, req.user);
	}

	/** GET /reservas/:id/completa -> { reserva, conductor, vehiculo, zona } (detalle del encargado). */
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONTROLADOR')
	@Get(':id/completa')
	async findCompleteById(@Param('id', ParseIntPipe) id: number) {
		return this.reservasService.findCompleteById(id);
	}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONTROLADOR')
	@Get('zona/:idZona')
	async findByZonaId(@Param('idZona', ParseIntPipe) idZona: number) {
		return this.reservasService.findCompleteByZonaId(idZona);
	}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONTROLADOR')
	@Put(':id/state')
	async updateState(
		@Param('id', ParseIntPipe) id: number,
		@Body() updateReservaStateDto: UpdateReservaStateDto,
	): Promise<ReservaRecord> {
		return this.reservasService.updateState(id, updateReservaStateDto);
	}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('CONDUCTOR')
	@Patch(':id/extend')
	async extendReserva(
		@Param('id', ParseIntPipe) id: number,
		@Body() extendReservaDto: ExtendReservaDto,
		@Request() req: any,
	): Promise<ReservaRecord> {
		return this.reservasService.extendReserva(id, req.user.sub, extendReservaDto.fecha_fin);
	}
}
