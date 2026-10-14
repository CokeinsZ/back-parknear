import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import {
  normalizarBusqueda,
  type Pagina,
  type Paginacion,
} from 'src/common/busqueda';
import { estadoUsuarioEnum } from 'src/database/schema';
import { CreateUserDto } from './dto/create-user.dto';
import {
  AddVehiculoDto,
  UpdateVehiculoDto,
} from './dto/add-vehiculo.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  TipoAsignable,
  UpdateUsuarioFields,
  UserRecord,
  UsersRepository,
} from './repositories/users.repository';

const TIPOS_ASIGNABLES: readonly TipoAsignable[] = ['conductor', 'controlador', 'admin'];

/** Quién hace la petición, según su token (ver JwtStrategy). */
export interface Solicitante {
  id: string;
  tipo_usuario: string | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async create(createUserDto: CreateUserDto) {
    this.validateRequiredFields(createUserDto);
    const hashedPassword = await hash(createUserDto.contrasena, 10);

    try {
      const user = await this.usersRepository.create({
        ...createUserDto,
        contrasena: hashedPassword,
      });

      return this.sanitizeUser(user);
    } catch (error: unknown) {
      if (error instanceof ConflictException) {
        throw error;
      }

      throw new InternalServerErrorException('Error al crear usuario');
    }
  }

  /** Búsqueda paginada en la base de datos: nunca devuelve la tabla completa. */
  async search(
    q: string | undefined,
    paginacion: Paginacion,
  ): Promise<Pagina<ReturnType<UsersService['sanitizeUser']>>> {
    const { items, total } = await this.usersRepository.search(
      normalizarBusqueda(q),
      paginacion,
    );

    return { items: items.map((user) => this.sanitizeUser(user)), total, ...paginacion };
  }

  resumen() {
    return this.usersRepository.resumen();
  }

  async findByEmail(email: string) {
    const user = await this.usersRepository.findByEmail(email);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return this.sanitizeUser(user);
  }

  async addVehiculo(documento: string, vehiculoDto: AddVehiculoDto) {
    const user = await this.usersRepository.findByDocumento(documento);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.tipo_usuario !== 'conductor') {
      throw new BadRequestException(
        'Solo los conductores pueden registrar vehículos',
      );
    }

    await this.usersRepository.insertVehiculoForConductor(user.id, {
      placa: vehiculoDto.placa,
      marca: vehiculoDto.marca,
      color: vehiculoDto.color,
    });

    const vehiculos =
      await this.usersRepository.findVehiculosByConductorId(user.id);

    return {
      ...this.sanitizeUser(user),
      vehiculos,
    };
  }

  async getVehiculos(documento: string) {
    const user = await this.usersRepository.findByDocumento(documento);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return this.usersRepository.findVehiculosByConductorId(user.id);
  }

  async updateVehiculo(
    documento: string,
    placa: string,
    vehiculoDto: UpdateVehiculoDto,
  ) {
    const user = await this.usersRepository.findByDocumento(documento);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const updated = await this.usersRepository.updateVehiculo(
      user.id,
      placa,
      vehiculoDto,
    );

    if (!updated) {
      throw new NotFoundException('Vehículo no encontrado');
    }

    return updated;
  }

  async deleteVehiculo(documento: string, placa: string) {
    const user = await this.usersRepository.findByDocumento(documento);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.tipo_usuario !== 'conductor') {
      throw new BadRequestException(
        'Solo los conductores pueden eliminar vehículos',
      );
    }

    const deleted = await this.usersRepository.deleteVehiculo(user.id, placa);

    if (!deleted) {
      throw new NotFoundException('Vehículo no encontrado');
    }

    return { message: 'Vehículo eliminado correctamente' };
  }

  async update(documento: string, updateDto: UpdateUserDto, solicitante: Solicitante) {
    const existing = await this.usersRepository.findByDocumento(documento);

    if (!existing) {
      throw new NotFoundException('Usuario no encontrado');
    }

    this.validarPermisosDeEdicion(existing, updateDto, solicitante);

    const fields = await this.buildUpdateFields(updateDto);

    const updated = await this.usersRepository.updateByDocumento(
      documento,
      fields,
    );

    if (!updated) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return this.sanitizeUser(updated);
  }

  /**
   * Un conductor solo edita su propia cuenta y nunca su tipo ni su estado:
   * antes cualquiera con token de conductor podía volverse admin.
   * Un admin puede cambiar el tipo de cualquiera menos el suyo, para no
   * quedarse sin acceso al panel por error.
   */
  private validarPermisosDeEdicion(
    existing: UserRecord,
    updateDto: UpdateUserDto,
    solicitante: Solicitante,
  ) {
    const esAdmin = solicitante.tipo_usuario === 'admin';
    const cambiaTipo = updateDto.tipo_usuario !== undefined;
    const cambiaEstado = updateDto.estado !== undefined;

    if (!esAdmin && existing.id !== solicitante.id) {
      throw new ForbiddenException('Solo puedes modificar tu propia cuenta');
    }
    if (!esAdmin && (cambiaTipo || cambiaEstado)) {
      throw new ForbiddenException(
        'Solo un administrador puede cambiar el tipo o el estado de una cuenta',
      );
    }
    if (cambiaTipo && !TIPOS_ASIGNABLES.includes(updateDto.tipo_usuario as TipoAsignable)) {
      throw new BadRequestException(
        `Tipo de usuario inválido. Usa: ${TIPOS_ASIGNABLES.join(', ')}`,
      );
    }
    if (cambiaTipo && existing.id === solicitante.id && updateDto.tipo_usuario !== existing.tipo_usuario) {
      throw new BadRequestException('No puedes cambiar tu propio tipo de usuario');
    }
    if (cambiaEstado && !estadoUsuarioEnum.enumValues.includes(updateDto.estado!)) {
      throw new BadRequestException(
        `Estado inválido. Usa: ${estadoUsuarioEnum.enumValues.join(', ')}`,
      );
    }
  }

  private async buildUpdateFields(
    updateDto: UpdateUserDto,
  ): Promise<UpdateUsuarioFields> {
    const { contrasena, ...rest } = updateDto;
    const fields: UpdateUsuarioFields = { ...rest };

    if (typeof contrasena === 'string' && contrasena.trim().length > 0) {
      fields.contrasena = await hash(contrasena, 10);
    }

    return fields;
  }

  private sanitizeUser(user: UserRecord) {
    return {
      id: user.id,
      documento_identidad: user.documento_identidad,
      primer_nombre: user.primer_nombre,
      segundo_nombre: user.segundo_nombre,
      primer_apellido: user.primer_apellido,
      segundo_apellido: user.segundo_apellido,
      email: user.email,
      celular: user.celular,
      estado: user.estado,
      tipo_usuario: user.tipo_usuario,
      fecha_creacion: user.fecha_creacion,
      fecha_actualizacion: user.fecha_actualizacion,
    };
  }

  private validateRequiredFields(createUserDto: CreateUserDto) {
    const requiredFields: Array<keyof CreateUserDto> = [
      'documento_identidad',
      'primer_nombre',
      'primer_apellido',
      'email',
      'contrasena',
      'celular',
    ];

    const missingFields = requiredFields.filter((field) => {
      const value = createUserDto[field];
      return typeof value !== 'string' || value.trim().length === 0;
    });

    if (missingFields.length > 0) {
      throw new BadRequestException(
        `Faltan campos requeridos: ${missingFields.join(', ')}`,
      );
    }
  }
}
