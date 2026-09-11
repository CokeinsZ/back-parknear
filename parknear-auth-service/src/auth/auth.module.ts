import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { StringValue } from 'ms';
import { DatabaseModule } from 'src/database/database.module';
import { UsersRepository } from './repositories/users.repository';

@Module({
  imports: [
    DatabaseModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // Keep support for values like "1h" from env.
        // Nest types require ms.StringValue instead of generic string.
        const expiresIn = (configService.get<string>('JWT_EXPIRES_IN') ??
          '1h') as StringValue;

        return {
          secret: configService.get<string>('JWT_SECRET', 'secretKey'),
          signOptions: {
            expiresIn,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, UsersRepository],
})
export class AuthModule {}