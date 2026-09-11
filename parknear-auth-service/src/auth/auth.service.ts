import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthUserRecord, UsersRepository } from './repositories/users.repository';

interface JwtPayload {
  sub: string;
  email: string;
  tipo_usuario: 'conductor' | 'controlador' | 'admin' | null;
  estado: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersRepository: UsersRepository,
  ) {}

  async register(registerDto: RegisterDto) {
    this.validateRequiredFields(registerDto);
    const hashedPassword = await hash(registerDto.contrasena, 10);

    try {
      const user = await this.usersRepository.create({
        ...registerDto,
        contrasena: hashedPassword,
      });

      const payload = this.createTokenPayload(user);

      return {
        user: this.sanitizeUser(user),
        access_token: this.jwtService.sign(payload),
      };

    } catch (error: unknown) {
      if (error instanceof ConflictException) {
        throw new ConflictException('El usuario ya existe');
      }

      throw new InternalServerErrorException('Error al registrar usuario');
    }
  }

  async login(loginDto: LoginDto) {
    const user = await this.usersRepository.findByEmail(loginDto.email);

    if (!user) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    const isPasswordValid = await compare(loginDto.contrasena, user.contrasena);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    const payload = this.createTokenPayload(user);

    return {
      user: this.sanitizeUser(user),
      access_token: this.jwtService.sign(payload),
    };
  }

  private createTokenPayload(user: AuthUserRecord): JwtPayload {
    return {
      sub: user.id,
      email: user.email,
      tipo_usuario: user.tipo_usuario,
      estado: user.estado,
    };
  }

  private sanitizeUser(user: AuthUserRecord) {
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

  private validateRequiredFields(registerDto: RegisterDto) {
    const requiredFields: Array<keyof RegisterDto> = [
      'documento_identidad',
      'primer_nombre',
      'primer_apellido',
      'email',
      'contrasena',
      'celular',
    ];

    const missingFields = requiredFields.filter((field) => {
      const value = registerDto[field];
      return typeof value !== 'string' || value.trim().length === 0;
    });

    if (missingFields.length > 0) {
      throw new BadRequestException(
        `Faltan campos requeridos: ${missingFields.join(', ')}`,
      );
    }
  }
}