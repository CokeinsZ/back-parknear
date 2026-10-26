import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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

/*
 * Los errores propios responden { statusCode, error, codigo, message }; la app usa `codigo`
 * para distinguir el caso y muestra `message` tal cual.
 */
@Controller('reservas')
export class ReservasController {
  constructor(private readonly reservasService: ReservasService) {}

  /**
   * POST /reservas { id_zona, id_vehiculo, horas } -> reserva `pendiente`.
   * El conductor sale del token; fecha_fin = ahora + horas y precio = 5000 + horas × 3500.
   * 403 VEHICULO_AJENO | 409 VEHICULO_CON_RESERVA | 404 ZONA_NO_EXISTE | 409 ZONA_SIN_CUPO
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CONDUCTOR')
  @Post()
  async create(
    @Body() createReservaDto: CreateReservaDto,
    @Request() req: { user: Solicitante },
  ): Promise<ReservaRecord> {
    return this.reservasService.create(createReservaDto, req.user);
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
    return this.reservasService.search(
      q,
      estado,
      leerPaginacion(limit, offset),
    );
  }

  /** GET /reservas/resumen -> { total, pendiente, activa, completada, cancelada }. Va antes de `:id`. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CONTROLADOR')
  @Get('resumen')
  async resumen() {
    return this.reservasService.resumen();
  }

  /** GET /reservas/:id -> una reserva | 404 RESERVA_NO_EXISTE | 403 RESERVA_AJENA (conductor) */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CONDUCTOR')
  @Get(':id')
  async findById(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: Solicitante },
  ): Promise<ReservaRecord> {
    return this.reservasService.findById(id, req.user);
  }

  /**
   * GET /reservas/user/:id?limit=20&offset=0&en_curso=true -> { items: [{ reserva, zona }], total, limit, offset }
   * Con `en_curso=true` (o `1`), solo las que ocupan un cupo ahora mismo.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CONDUCTOR')
  @Get('user/:id')
  async findByUserId(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Request() req: { user: Solicitante },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('en_curso') enCurso?: string,
  ) {
    return this.reservasService.findByUserId(
      id,
      req.user,
      leerPaginacion(limit, offset),
      enCurso === 'true' || enCurso === '1',
    );
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

  /**
   * PUT /reservas/:id/state { estado: 'activa' | 'cancelada' } -> reserva.
   * `activa` = aceptar una `pendiente`; `cancelada` = rechazar o cancelar una en curso
   * (sin llegada, el precio queda en el cargo de reserva). No toca fechas.
   * 404 RESERVA_NO_EXISTE | 409 LLEGADA_VENCIDA | 409 TRANSICION_INVALIDA
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CONTROLADOR')
  @Put(':id/state')
  async updateState(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateReservaStateDto: UpdateReservaStateDto,
  ): Promise<ReservaRecord> {
    return this.reservasService.updateState(id, updateReservaStateDto.estado);
  }

  /**
   * POST /reservas/:id/llegada (sin cuerpo) -> reserva con `fecha_real_inicio` = ahora.
   * El encargado verificó la placa; la reserva sigue `activa` hasta `fecha_fin`.
   * 404 RESERVA_NO_EXISTE | 409 RESERVA_NO_ACEPTADA | 409 LLEGADA_YA_CONFIRMADA
   * | 409 LLEGADA_VENCIDA | 409 TRANSICION_INVALIDA
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'CONTROLADOR')
  @Post(':id/llegada')
  @HttpCode(HttpStatus.OK)
  async confirmarLlegada(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReservaRecord> {
    return this.reservasService.confirmarLlegada(id);
  }

  /**
   * PATCH /reservas/:id/extend { horas } -> reserva con `fecha_fin` + horas y precio + horas × 3500.
   * 404 RESERVA_NO_EXISTE | 403 RESERVA_AJENA | 409 RESERVA_TERMINADA | 400 DURACION_MAXIMA
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CONDUCTOR')
  @Patch(':id/extend')
  async extendReserva(
    @Param('id', ParseIntPipe) id: number,
    @Body() extendReservaDto: ExtendReservaDto,
    @Request() req: { user: Solicitante },
  ): Promise<ReservaRecord> {
    return this.reservasService.extendReserva(
      id,
      req.user.sub,
      extendReservaDto.horas,
    );
  }
}
