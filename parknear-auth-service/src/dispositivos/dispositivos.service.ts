import { BadRequestException, Injectable } from '@nestjs/common';
import { DispositivosRepository } from './dispositivos.repository';
import { TokenPushDto } from './dto/token-push.dto';

/** Formato del token que entrega `getExpoPushTokenAsync` en la app. */
const TOKEN_EXPO = /^Expo(nent)?PushToken\[[^\]]+\]$/;
/** Tamaño de la columna `dispositivos_push.token`. */
const LARGO_MAXIMO = 255;

/**
 * Qué teléfonos reciben los avisos push de cada usuario. La app registra el teléfono al
 * iniciar sesión (si el usuario dio permiso) y lo quita al cerrarla. Quién envía los
 * avisos y cuándo lo decide reservations-service.
 */
@Injectable()
export class DispositivosService {
  constructor(
    private readonly dispositivosRepository: DispositivosRepository,
  ) {}

  async registrar(idUsuario: string, dto: TokenPushDto): Promise<void> {
    await this.dispositivosRepository.registrar(
      idUsuario,
      this.validarToken(dto),
    );
  }

  async quitar(idUsuario: string, dto: TokenPushDto): Promise<void> {
    await this.dispositivosRepository.quitar(idUsuario, this.validarToken(dto));
  }

  /** El token del cuerpo, o 400 si no tiene el formato de Expo. */
  private validarToken(dto: TokenPushDto | undefined): string {
    const token: unknown = dto?.token;

    if (
      typeof token !== 'string' ||
      token.length > LARGO_MAXIMO ||
      !TOKEN_EXPO.test(token)
    ) {
      throw new BadRequestException(
        'Token push inválido: se espera ExponentPushToken[...]',
      );
    }

    return token;
  }
}
