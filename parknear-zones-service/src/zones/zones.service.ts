import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateZonaDto } from './dto/create-zone.dto';
import { UpdateZonaDto } from './dto/update-zone.dto';
import { DrizzleService } from 'src/database/drizzle.service';
import { zonas_azules } from 'src/database/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class ZonasService {
  constructor(private readonly drizzleService: DrizzleService) {}

  async create(createZonaDto: CreateZonaDto) {
    const payload: any = { ...createZonaDto };
    if (payload.id) {
      delete payload.id;
    }
    const latitud = typeof payload.latitud === 'number' ? payload.latitud.toString() : payload.latitud;
    const longitud = typeof payload.longitud === 'number' ? payload.longitud.toString() : payload.longitud;

    const [zona] = await this.drizzleService.db.insert(zonas_azules).values({
      latitud: latitud,
      longitud: longitud,
      indicaciones: payload.indicaciones,
      capacidad: payload.capacidad,
      capacidad_total: payload.capacidad_total,
    }).returning();
    return zona;
  }

  async findAll() {
    return this.drizzleService.db.select().from(zonas_azules);
  }

  async findOne(id: number) {
    const [zona] = await this.drizzleService.db.select().from(zonas_azules).where(eq(zonas_azules.id, id));
    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return zona;
  }

  async update(id: number, updateZonaDto: UpdateZonaDto) {
    const payload: any = { ...updateZonaDto };
    if (payload.latitud && typeof payload.latitud === 'number') {
      payload.latitud = payload.latitud.toString();
    }
    if (payload.longitud && typeof payload.longitud === 'number') {
      payload.longitud = payload.longitud.toString();
    }

    const [zona] = await this.drizzleService.db.update(zonas_azules)
      .set(payload)
      .where(eq(zonas_azules.id, id))
      .returning();

    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return zona;
  }

  async remove(id: number) {
    const [zona] = await this.drizzleService.db.delete(zonas_azules)
      .where(eq(zonas_azules.id, id))
      .returning();

    if (!zona) {
      throw new NotFoundException('Zona no encontrada');
    }
    return { message: 'Zona eliminada' };
  }
}