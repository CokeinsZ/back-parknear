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
	Request,
	UseGuards,
} from '@nestjs/common';
import { CreateReservaDto } from './dtos/create-reserva.dto';
import { UpdateReservaStateDto } from './dtos/update-reserva-state.dto';
import { ExtendReservaDto } from './dtos/extend-reserva.dto';
import { ReservasService } from './reservas.service';
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

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONDUCTOR')
	@Get(':id')
	async findById(@Param('id', ParseIntPipe) id: number): Promise<ReservaRecord> {
		return this.reservasService.findById(id);
	}

	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles('ADMIN', 'CONDUCTOR')
	@Get('user/:id')
	async findByUserId(
		@Param('id', new ParseUUIDPipe()) id: string,
	): Promise<ReservaRecord[]> {
		return this.reservasService.findByUserId(id);
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
