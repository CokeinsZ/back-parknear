import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { normalizarBusqueda, type Paginacion } from 'src/common/busqueda';
import { estadoReservaEnum } from 'src/database/schema';
import { CreateReservaDto } from './dtos/create-reserva.dto';
import { UpdateReservaStateDto } from './dtos/update-reserva-state.dto';
import { EstadoReserva, ReservaRecord } from './interfaces/reserva.interface';
import { ReservasRepository } from './repositories/reservas.repository';

/** Quién hace la petición, según su token (ver JwtStrategy). */
export interface Solicitante {
	sub: string;
	tipo_usuario: string | null;
}

@Injectable()
export class ReservasService {
	constructor(private readonly reservasRepository: ReservasRepository) {}

	private calcularPrecio(fechaInicio: Date, fechaFin: Date): number {
		const diffMs = fechaFin.getTime() - fechaInicio.getTime();
		const diffHours = Math.max(0, diffMs / (1000 * 60 * 60));
		return Number((diffHours * 3500).toFixed(2)) + 5000; // Tarifa base de 5000 + 3500 por hora
	}

	async create(createReservaDto: CreateReservaDto): Promise<ReservaRecord> {
		try {
			const fechaInicio = new Date();
			const fechaFin = new Date(createReservaDto.fecha_fin);
			const precio = this.calcularPrecio(fechaInicio, fechaFin);

			const reserva = await this.reservasRepository.create({
					id_conductor: createReservaDto.id_conductor,
					id_zona: createReservaDto.id_zona,
					id_vehiculo: createReservaDto.id_vehiculo.toUpperCase(),
					fecha_real_inicio: fechaInicio,
					fecha_fin: fechaFin,
					precio: precio.toString(),
					estado: 'pendiente',
				});

			if (!reserva) {
				throw new BadRequestException('No se pudo crear la reserva');
			}

			await this.reservasRepository.decrementCapacity(createReservaDto.id_zona);

			return reserva;
		} catch (error: unknown) {
			this.handleDbError(error);
		}
	}

	async findById(id: number): Promise<ReservaRecord> {
		const reserva = await this.reservasRepository.findById(id);

		if (!reserva) {
			throw new NotFoundException('Reserva no encontrada');
		}

		return reserva;
	}

	/** Historial paginado de un conductor. Un conductor solo puede ver el suyo. */
	async findByUserId(userId: string, solicitante: Solicitante, paginacion: Paginacion) {
		this.validarDueno(userId, solicitante);
		const { items, total } = await this.reservasRepository.findByUserId(userId, paginacion);
		return { items, total, ...paginacion };
	}

	async resumenDeConductor(userId: string, solicitante: Solicitante) {
		this.validarDueno(userId, solicitante);
		return this.reservasRepository.resumen(userId);
	}

	async resumen() {
		return this.reservasRepository.resumen();
	}

	/** Búsqueda paginada sobre las reservas de todas las zonas (para el encargado). */
	async search(q: string | undefined, estado: string | undefined, paginacion: Paginacion) {
		if (estado && !estadoReservaEnum.enumValues.includes(estado as EstadoReserva)) {
			throw new BadRequestException(
				`Estado inválido. Usa: ${estadoReservaEnum.enumValues.join(', ')}`,
			);
		}

		const { items, total } = await this.reservasRepository.search(
			normalizarBusqueda(q),
			(estado as EstadoReserva | undefined) ?? null,
			paginacion,
		);
		return { items, total, ...paginacion };
	}

	async findCompleteByZonaId(zonaId: number) {
		return this.reservasRepository.findCompleteByZonaId(zonaId);
	}

	async findCompleteById(id: number) {
		const fila = await this.reservasRepository.findCompleteById(id);

		if (!fila) {
			throw new NotFoundException('Reserva no encontrada');
		}

		return fila;
	}

	private validarDueno(userId: string, solicitante: Solicitante) {
		if (solicitante.tipo_usuario !== 'admin' && solicitante.sub !== userId) {
			throw new ForbiddenException('Solo puedes ver tus propias reservas');
		}
	}

	async updateState(id: number, updateReservaStateDto: UpdateReservaStateDto): Promise<ReservaRecord> {
		const existingReserva = await this.findById(id);

		const shouldSetEndDate =
			updateReservaStateDto.estado === 'completada' || updateReservaStateDto.estado === 'cancelada';

		let fechaInicio = existingReserva.fecha_real_inicio;
		let fechaFin = existingReserva.fecha_fin;

		if (existingReserva.estado === 'pendiente' && updateReservaStateDto.estado === 'activa') {
			const now = new Date();
			if (fechaFin) {
				const durationMs = fechaFin.getTime() - existingReserva.fecha_real_inicio.getTime();
				fechaInicio = now;
				fechaFin = new Date(now.getTime() + durationMs);
			} else {
				fechaInicio = now;
			}
		}

		if (updateReservaStateDto.fecha_fin) {
			fechaFin = new Date(updateReservaStateDto.fecha_fin);
		} else if (shouldSetEndDate) {
			fechaFin = new Date();
		}

		const calculatedPrice = this.calcularPrecio(fechaInicio, fechaFin ?? new Date());
		// Nos aseguramos que el precio DB nunca baje de lo que el conductor ya tenía reservado inicialmente
		// Esto evita conflictos donde un usuario "abandona" antes la reserva y su precio guardado cae bajo lo que ya pagó.
		const nuevoPrecio = Math.max(Number(existingReserva.precio), calculatedPrice);

		const updatedReserva = await this.reservasRepository.updateStateWithPrice(
			id,
			updateReservaStateDto.estado,
			fechaFin,
			fechaInicio,
			nuevoPrecio.toString()
		);

		if (!updatedReserva) {
			throw new NotFoundException('Reserva no encontrada');
		}

		if (
			(updateReservaStateDto.estado === 'completada' || updateReservaStateDto.estado === 'cancelada') &&
			(existingReserva.estado !== 'completada' && existingReserva.estado !== 'cancelada')
		) {
			if (existingReserva.id_zona) {
				await this.reservasRepository.incrementCapacity(existingReserva.id_zona);
			}
		}

		return updatedReserva;
	}

	async extendReserva(id: number, userId: string, fechaFinStr: string): Promise<ReservaRecord> {
		const reserva = await this.findById(id);
		
		if (reserva.id_conductor !== userId) {
			throw new BadRequestException('No tienes permiso para extender esta reserva');
		}
		if (reserva.estado === 'completada' || reserva.estado === 'cancelada') {
			throw new BadRequestException('No se puede extender una reserva que ya finalizó');
		}

		const nuevaFechaFin = new Date(fechaFinStr);
		if (reserva.fecha_fin && nuevaFechaFin <= reserva.fecha_fin) {
			throw new BadRequestException('La nueva hora fin debe ser mayor a la actual');
		}

		const nuevoPrecio = this.calcularPrecio(reserva.fecha_real_inicio, nuevaFechaFin);
		
		const updatedReserva = await this.reservasRepository.updateStateWithPrice(
			id,
			reserva.estado,
			nuevaFechaFin,
			reserva.fecha_real_inicio,
			nuevoPrecio.toString()
		);

		if (!updatedReserva) {
			throw new NotFoundException('Reserva no encontrada');
		}
		
		return updatedReserva;
	}

	private handleDbError(error: unknown): never {
		const dbError = error as {
			code?: string;
			message?: string;
		};

		if (dbError?.code === '23503') {
			throw new BadRequestException(
				'No se pudo crear la reserva: conductor, vehiculo o zona no existe',
			);
		}

		if (dbError?.code === '22007') {
			throw new BadRequestException('Formato de fecha invalido');
		}

		throw error;
	}
}
