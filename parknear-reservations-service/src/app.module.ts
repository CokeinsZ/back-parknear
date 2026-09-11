import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { DatabaseModule } from './database/database.module';
import { ReservasModule } from './reservas/reservas.module';
import { JwtStrategy } from './auth/strategies/jwt.strategy';
import { RolesGuard } from './auth/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    ReservasModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'secretKey',
      signOptions: { expiresIn: '1h' },
    }),
    PassportModule,
  ],
  controllers: [],
  providers: [JwtStrategy, RolesGuard],
})
export class AppModule {}
