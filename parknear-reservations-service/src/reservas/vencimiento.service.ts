import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AvisosService } from './avisos.service';
import { ReservasRepository } from './repositories/reservas.repository';

/** JOB_VENCIMIENTO=off apaga el job (por ejemplo, en una réplica de solo lectura o en pruebas). */
const apagado = process.env.JOB_VENCIMIENTO === 'off';

/**
 * Cada minuto cancela las reservas cuyo conductor no llegó en 15 minutos y completa las
 * parqueadas cuyo tiempo terminó. Los cupos NO dependen de este job (los calcula la vista
 * `reservas_en_curso` con la hora real): solo deja los estados al día. Es idempotente y,
 * con varias réplicas, corre una sola a la vez (candado en la BD).
 *
 * También envía los avisos programados: los recordatorios de llegada y de fin, y el de
 * "no llegaste". Como los decide aquí con el estado real, un recordatorio de una reserva
 * que ya cambió (llegó, se canceló, se extendió) no sale, o sale a la nueva hora.
 */
@Injectable()
export class VencimientoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VencimientoService.name);

  constructor(
    private readonly reservasRepository: ReservasRepository,
    private readonly avisosService: AvisosService,
  ) {}

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
      if (!resultado) return; // otra réplica está en eso

      if (resultado.canceladas || resultado.completadas) {
        this.logger.log(
          `Vencidas: ${resultado.canceladas} canceladas, ${resultado.completadas} completadas`,
        );
      }
      // Fuera de la transacción: los avisos ya quedaron reclamados y no se repiten.
      await this.avisosService.programados(resultado.avisos);
    } catch (error) {
      this.logger.error(
        'No se pudieron vencer las reservas',
        (error as Error)?.stack,
      );
    }
  }
}
