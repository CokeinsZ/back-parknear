import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MercadopagoModule } from './mercadopago/mercadopago.module';
import { PagosModule } from './pagos/pagos.module';
import { DatabaseModule } from './database/database.module';
import { JwtStrategy } from './auth/strategies/jwt.strategy';
import { RolesGuard } from './auth/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    MercadopagoModule,
    PagosModule,
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
