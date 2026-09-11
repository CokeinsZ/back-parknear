import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET || 'secretKey', // fallback to secretKey
    });
  }

  async validate(payload: any) {
    return {
      sub: payload.sub,
      email: payload.email,
      tipo_usuario: payload.tipo_usuario,
      estado: payload.estado,
    };
  }
}