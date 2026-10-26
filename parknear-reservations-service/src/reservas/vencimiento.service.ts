import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReservasRepository } from './repositories/reservas.repository';

/** JOB_VENCIMIENTO=off apaga el job (por ejemplo, en una réplica de solo lectura o en pruebas). */
const apagado = process.env.JOB_VENCIMIENTO === 'off';

/**
 * Cada minuto cancela las reservas cuyo conductor no llegó en 15 minutos y completa las
 * parqueadas cuyo tiempo terminó. Los cupos NO dependen de este job (los calcula la vista
 * `reservas_en_curso` con la hora real): solo deja los estados al día. Es idempotente y,
 * con varias réplicas, corre una sola a la vez (candado en la BD).
 */
@Injectable()
export class VencimientoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VencimientoService.name);

  constructor(private readonly reservasRepository: ReservasRepository) {}

  /** Al arrancar pone al día lo que venció mientras el servicio estaba apagado. */
  onApplicationBootstrap() {
    if (!apagado) void this.vencer();
  }

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'vencer-reservas',
    waitForCompletion: true,
    disabled: apagado,
  })
  async vencer() {
    try {
      const resultado = await this.reservasRepository.vencerConCandado();
      if (resultado && (resultado.canceladas || resultado.completadas)) {
        this.logger.log(
          `Vencidas: ${resultado.canceladas} canceladas, ${resultado.completadas} completadas`,
        );
      }
    } catch (error) {
      this.logger.error(
        'No se pudieron vencer las reservas',
        (error as Error)?.stack,
      );
    }
  }
}
