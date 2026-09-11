import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';
import { AddVehiculoDto } from './dto/add-vehiculo.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  UpdateUsuarioFields,
  UserRecord,
  UsersRepository,
} from './repositories/users.repository';

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

  async findAll() {
    const users = await this.usersRepository.findAll();
    return users.map((user) => this.sanitizeUser(user));
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

  async update(documento: string, updateDto: UpdateUserDto) {
    const existing = await this.usersRepository.findByDocumento(documento);

    if (!existing) {
      throw new NotFoundException('Usuario no encontrado');
    }

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
