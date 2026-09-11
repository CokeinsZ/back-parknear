import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { StringValue } from 'ms';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RolesGuard } from './guards/roles.guard';
import { DatabaseModule } from 'src/database/database.module';
import { UsersRepository } from './repositories/users.repository';

@Module({
  imports: [
    DatabaseModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
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
  controllers: [UsersController],
  providers: [UsersService, JwtStrategy, RolesGuard, UsersRepository],
})
export class UsersModule {}