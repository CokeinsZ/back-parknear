import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { leerPaginacion } from 'src/common/busqueda';
import { ZonasService } from './zones.service';
import { CreateZonaDto } from './dto/create-zone.dto';
import { UpdateZonaDto } from './dto/update-zone.dto';
import { UpdateEstadoZonaDto } from './dto/update-zone-estado.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('zonas')
export class ZonasController {
  constructor(private zonasService: ZonasService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post()
  create(@Body() createZonaDto: CreateZonaDto) {
    return this.zonasService.create(createZonaDto);
  }

  /** GET /zonas?q=texto&orden=disponibles&limit=20&offset=0 -> { items, total, limit, offset } */
  @Get()
  search(
    @Query('q') q?: string,
    @Query('orden') orden?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.zonasService.search(
      q,
      orden === 'disponibles' ? 'disponibles' : 'id',
      leerPaginacion(limit, offset),
    );
  }

  /** GET /zonas/resumen -> { total, con_cupo, cupos_disponibles }. Va antes de `:id`. */
  @Get('resumen')
  resumen() {
    return this.zonasService.resumen();
  }

  /**
   * GET /zonas/controlador/:idControlador?q=texto&limit=20&offset=0
   * -> { items: [zona + asignada], total, limit, offset, total_asignadas }
   * Todas las zonas, primero las asignadas a ese controlador. 404 CONTROLADOR_NO_EXISTE
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Get('controlador/:idControlador')
  zonasDeControlador(
    @Param('idControlador', new ParseUUIDPipe()) idControlador: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.zonasService.zonasDeControlador(
      idControlador,
      q,
      leerPaginacion(limit, offset),
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.zonasService.findOne(Number(id));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateZonaDto: UpdateZonaDto) {
    return this.zonasService.update(Number(id), updateZonaDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.zonasService.remove(Number(id));
  }

  /** PATCH /zonas/:id/estado { estado } -> la zona | 404 | 400 ESTADO_ZONA_INVALIDO */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Patch(':id/estado')
  updateEstado(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateEstadoZonaDto: UpdateEstadoZonaDto,
  ) {
    return this.zonasService.updateEstado(id, updateEstadoZonaDto);
  }

  /** PUT /zonas/:id/controladores/:idControlador -> asigna la zona (idempotente). 404 si zona o controlador no existen. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Put(':id/controladores/:idControlador')
  asignarControlador(
    @Param('id', ParseIntPipe) id: number,
    @Param('idControlador', new ParseUUIDPipe()) idControlador: string,
  ) {
    return this.zonasService.asignarControlador(id, idControlador);
  }

  /** DELETE /zonas/:id/controladores/:idControlador -> quita la zona (idempotente). */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Delete(':id/controladores/:idControlador')
  desasignarControlador(
    @Param('id', ParseIntPipe) id: number,
    @Param('idControlador', new ParseUUIDPipe()) idControlador: string,
  ) {
    return this.zonasService.desasignarControlador(id, idControlador);
  }
}