import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { DispositivosService } from './dispositivos.service';
import { TokenPushDto } from './dto/token-push.dto';

/** Lo que deja `JwtStrategy` en `req.user`. */
interface UsuarioDeSesion {
  id: string;
}

/*
 * El usuario sale SIEMPRE del token de sesión, nunca del cuerpo: si no, cualquiera podría
 * registrar su teléfono a nombre de otra persona y recibir sus avisos.
 */
@Controller('auth/token-push')
@UseGuards(JwtAuthGuard)
export class DispositivosController {
  constructor(private readonly dispositivosService: DispositivosService) {}

  /** PUT /auth/token-push { token } -> 204. Este teléfono recibe los avisos del usuario en sesión. | 400 */
  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  async registrar(
    @Body() dto: TokenPushDto,
    @Request() req: { user: UsuarioDeSesion },
  ): Promise<void> {
    await this.dispositivosService.registrar(req.user.id, dto);
  }

  /** DELETE /auth/token-push { token } -> 204. El teléfono deja de recibir avisos (al cerrar sesión). | 400 */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async quitar(
    @Body() dto: TokenPushDto,
    @Request() req: { user: UsuarioDeSesion },
  ): Promise<void> {
    await this.dispositivosService.quitar(req.user.id, dto);
  }
}
