import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizarBusqueda, type Paginacion } from 'src/common/busqueda';
import { errorDePostgres } from 'src/database/errores';
import { estadoReservaEnum } from 'src/database/schema';
import { CreateReservaDto } from './dtos/create-reserva.dto';
import type { EstadoDelEncargado } from './dtos/update-reserva-state.dto';
import { EstadoReserva, ReservaRecord } from './interfaces/reserva.interface';
import {
  ReservasRepository,
  type ErrorAlCrear,
  type ResultadoTransicion,
} from './repositories/reservas.repository';
import { HORAS_MAX, MINUTOS_PARA_LLEGAR } from './reglas';

/** Quién hace la petición, según su token (ver JwtStrategy). */
export interface Solicitante {
  sub: string;
  tipo_usuario: string | null;
}

/*
 * Errores con `codigo`, para que la app distinga el caso además de mostrar el mensaje.
 * Todos responden { statusCode, error, codigo, message }.
 */
function conflicto(codigo: string, message: string) {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    codigo,
    message,
  });
}

function prohibido(codigo: string, message: string) {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    codigo,
    message,
  });
}

function noEncontrado(codigo: string, message: string) {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    codigo,
    message,
  });
}

function invalido(codigo: string, message: string) {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    codigo,
    message,
  });
}

const reservaNoExiste = () =>
  noEncontrado('RESERVA_NO_EXISTE', 'Reserva no encontrada');

const MS_PARA_LLEGAR = MINUTOS_PARA_LLEGAR * 60 * 1000;

/**
 * La reserva se canceló porque el conductor no llegó a tiempo: sin llegada y cancelada
 * cuando ya habían pasado los 15 minutos (antes de eso, solo el encargado pudo cancelarla).
 * Solo elige el mensaje de error.
 */
function vencioSinLlegar(reserva: ReservaRecord): boolean {
  return (
    reserva.estado === 'cancelada' &&
    reserva.fecha_real_inicio === null &&
    reserva.fecha_actualizacion.getTime() >=
      reserva.fecha_creacion.getTime() + MS_PARA_LLEGAR
  );
}

@Injectable()
export class ReservasService {
  constructor(private readonly reservasRepository: ReservasRepository) {}

  /**
   * Crea una reserva `pendiente` para el conductor del token. En una transacción revisa que
   * el vehículo sea suyo, que no tenga otra reserva en curso y que la zona tenga cupo.
   */
  async create(
    dto: CreateReservaDto,
    solicitante: Solicitante,
  ): Promise<ReservaRecord> {
    const placa = dto.id_vehiculo.trim().toUpperCase();
    const resultado = await this.reservasRepository
      .crearConCupo({
        idConductor: solicitante.sub,
        idZona: dto.id_zona,
        placa,
        horas: dto.horas,
      })
      .catch((error: unknown) => this.handleDbError(error, placa));

    if (resultado.error) throw this.errorAlCrear(resultado.error, placa);
    return resultado.reserva;
  }

  private errorAlCrear(error: ErrorAlCrear, placa: string) {
    switch (error) {
      case 'VEHICULO_AJENO':
        return prohibido(
          error,
          `El vehículo ${placa} no está registrado a tu nombre.`,
        );
      case 'VEHICULO_CON_RESERVA':
        return conflicto(
          error,
          `El vehículo ${placa} ya tiene una reserva en curso.`,
        );
      case 'ZONA_NO_EXISTE':
        return noEncontrado(error, 'La zona no existe.');
      case 'ZONA_SIN_CUPO':
        return conflicto(error, 'La zona ya no tiene cupos disponibles.');
    }
  }

  /** Una reserva. Un conductor solo puede ver las suyas. */
  async findById(id: number, solicitante: Solicitante): Promise<ReservaRecord> {
    const reserva = await this.reservasRepository.findById(id);

    if (!reserva) {
      throw reservaNoExiste();
    }

    this.validarDueno(reserva.id_conductor, solicitante);
    return reserva;
  }

  /**
   * Historial paginado de un conductor. Un conductor solo puede ver el suyo.
   * Con `soloEnCurso`, solo las reservas que ocupan un cupo ahora mismo.
   */
  async findByUserId(
    userId: string,
    solicitante: Solicitante,
    paginacion: Paginacion,
    soloEnCurso = false,
  ) {
    this.validarDueno(userId, solicitante);
    const { items, total } = await this.reservasRepository.findByUserId(
      userId,
      paginacion,
      soloEnCurso,
    );
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
  async search(
    q: string | undefined,
    estado: string | undefined,
    paginacion: Paginacion,
  ) {
    if (
      estado &&
      !estadoReservaEnum.enumValues.includes(estado as EstadoReserva)
    ) {
      throw invalido(
        'ESTADO_INVALIDO',
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
      throw reservaNoExiste();
    }

    return fila;
  }

  private validarDueno(idConductor: string | null, solicitante: Solicitante) {
    if (
      solicitante.tipo_usuario !== 'admin' &&
      solicitante.sub !== idConductor
    ) {
      throw prohibido('RESERVA_AJENA', 'Solo puedes ver tus propias reservas');
    }
  }

  /**
   * El encargado acepta (`pendiente` → `activa`) o rechaza/cancela (→ `cancelada`).
   * No toca fechas. Cancelar sin llegada deja el precio en el cargo de reserva.
   */
  async updateState(
    id: number,
    estado: EstadoDelEncargado,
  ): Promise<ReservaRecord> {
    const { reserva, actual } = await this.reservasRepository.cambiarEstado(
      id,
      estado,
    );
    if (reserva) return reserva;

    throw this.transicionRechazada(actual);
  }

  /** El encargado verificó la placa: registra la llegada. La reserva sigue `activa`. */
  async confirmarLlegada(id: number): Promise<ReservaRecord> {
    const { reserva, actual } =
      await this.reservasRepository.confirmarLlegada(id);
    if (reserva) return reserva;

    if (actual?.estado === 'pendiente') {
      throw conflicto(
        'RESERVA_NO_ACEPTADA',
        'Primero acepta la reserva; luego confirma la llegada.',
      );
    }
    if (actual?.estado === 'activa' && actual.fecha_real_inicio !== null) {
      throw conflicto(
        'LLEGADA_YA_CONFIRMADA',
        'La llegada de esta reserva ya se confirmó.',
      );
    }
    throw this.transicionRechazada(actual);
  }

  /** Por qué una transición con guarda no cambió la reserva (`actual` es cómo quedó). */
  private transicionRechazada(actual: ResultadoTransicion['actual']) {
    if (!actual) return reservaNoExiste();
    if (vencioSinLlegar(actual)) {
      return conflicto(
        'LLEGADA_VENCIDA',
        'El tiempo para llegar venció y la reserva se canceló.',
      );
    }
    return conflicto(
      'TRANSICION_INVALIDA',
      `La reserva ya está ${actual.estado}.`,
    );
  }

  /** El conductor dueño suma horas a su reserva en curso, sin pasar de HORAS_MAX desde la creación. */
  async extendReserva(
    id: number,
    userId: string,
    horas: number,
  ): Promise<ReservaRecord> {
    const { reserva, actual } = await this.reservasRepository.extender(
      id,
      userId,
      horas,
    );
    if (reserva) return reserva;

    if (!actual) throw reservaNoExiste();
    if (actual.id_conductor !== userId) {
      throw prohibido(
        'RESERVA_AJENA',
        'No tienes permiso para extender esta reserva',
      );
    }
    if (actual.estado === 'completada' || actual.estado === 'cancelada') {
      throw conflicto(
        'RESERVA_TERMINADA',
        'La reserva ya terminó; no se puede extender.',
      );
    }
    throw invalido(
      'DURACION_MAXIMA',
      `Una reserva no puede durar más de ${HORAS_MAX} horas.`,
    );
  }

  private handleDbError(error: unknown, placa: string): never {
    const pg = errorDePostgres(error);

    if (
      pg.code === '23505' &&
      pg.constraint_name === 'ux_reservas_vehiculo_en_curso'
    ) {
      // Red de seguridad del índice único: la transacción ya lo revisa antes de insertar.
      throw conflicto(
        'VEHICULO_CON_RESERVA',
        `El vehículo ${placa} ya tiene una reserva en curso.`,
      );
    }

    if (pg.code === '23505') {
      throw conflicto('DUPLICADO', 'Ya existe un registro con esos datos.');
    }

    if (pg.code === '23503') {
      throw invalido(
        'REFERENCIA_INVALIDA',
        'No se pudo crear la reserva: conductor, vehiculo o zona no existe',
      );
    }

    if (pg.code === '22007') {
      throw invalido('FECHA_INVALIDA', 'Formato de fecha invalido');
    }

    throw error;
  }
}
