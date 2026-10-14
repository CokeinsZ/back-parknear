import { Controller, Get, Post, Body, Param, Patch, Delete, Query, UseGuards } from '@nestjs/common';
import { leerPaginacion } from 'src/common/busqueda';
import { ZonasService } from './zones.service';
import { CreateZonaDto } from './dto/create-zone.dto';
import { UpdateZonaDto } from './dto/update-zone.dto';
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
}