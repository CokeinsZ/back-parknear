import { Inject, Injectable, Logger } from '@nestjs/common';
import { NOTIFICADOR, type Notificador } from 'src/notificaciones/notificador';
import * as textos from './avisos';
import type { ArmarAviso } from './avisos';
import type { ReservaRecord } from './interfaces/reserva.interface';
import {
  ReservasRepository,
  type AvisosReclamados,
} from './repositories/reservas.repository';

/**
 * Decide a quién avisar en cada momento de una reserva; los textos están en `./avisos`.
 *
 * - Avisos inmediatos: ReservasService los pide justo después de que el cambio se guardó.
 * - Avisos programados: el job los reclama en `avisos_reserva` y los pide aquí.
 *
 * Ningún método lanza: la reserva ya cambió, y que un aviso falle (sin red, Expo caído, la
 * zona se borró) no puede convertir la petición en un error ni detener el job.
 *
 * Por decisión del plan, rechazar o cancelar como encargado NO avisa al conductor.
 */
@Injectable()
export class AvisosService {
  private readonly logger = new Logger(AvisosService.name);

  constructor(
    @Inject(NOTIFICADOR) private readonly notificador: Notificador,
    private readonly reservasRepository: ReservasRepository,
  ) {}

  /** B1. Llegó una reserva nueva: se avisa a cada encargado de la zona. */
  nuevaReserva(reserva: ReservaRecord): Promise<void> {
    return this.avisarEncargados(reserva, textos.nuevaReserva);
  }

  /** B2. El encargado aceptó la reserva. */
  aceptada(reserva: ReservaRecord): Promise<void> {
    return this.avisarConductor(reserva, textos.aceptada);
  }

  /** B3. El encargado verificó la placa. */
  llegadaConfirmada(reserva: ReservaRecord): Promise<void> {
    return this.avisarConductor(reserva, textos.llegadaConfirmada);
  }

  /** C2. El conductor canceló: los encargados de la zona ya no tienen que atenderla. */
  canceladaPorConductor(reserva: ReservaRecord): Promise<void> {
    return this.avisarEncargados(reserva, textos.canceladaPorConductor);
  }

  /** A1, A2 y B5: los avisos que el job ya reclamó. Todos son para el conductor. */
  async programados(reclamados: AvisosReclamados): Promise<void> {
    const lotes: [number[], ArmarAviso][] = [
      [reclamados.recordatorioLlegada, textos.recordatorioLlegada],
      [reclamados.recordatorioFin, textos.recordatorioFin],
      [reclamados.noLlego, textos.noLlego],
    ];

    await Promise.all(
      lotes.map(([ids, armar]) =>
        this.sinFallar('los avisos programados', async () => {
          const ahora = new Date();
          const reservas = await this.reservasRepository.reservasConZona(ids);
          await Promise.all(
            reservas.map(async (datos) => {
              const { id_conductor } = datos.reserva;
              if (id_conductor) {
                await this.notificador.avisar(
                  id_conductor,
                  armar(datos, ahora),
                );
              }
            }),
          );
        }),
      ),
    );
  }

  private avisarConductor(
    reserva: ReservaRecord,
    armar: ArmarAviso,
  ): Promise<void> {
    return this.sinFallar(`la reserva #${reserva.id}`, async () => {
      if (!reserva.id_conductor) return;

      const [datos] = await this.reservasRepository.reservasConZona([
        reserva.id,
      ]);
      if (datos) {
        await this.notificador.avisar(
          reserva.id_conductor,
          armar(datos, new Date()),
        );
      }
    });
  }

  private avisarEncargados(
    reserva: ReservaRecord,
    armar: ArmarAviso,
  ): Promise<void> {
    return this.sinFallar(`la reserva #${reserva.id}`, async () => {
      if (reserva.id_zona === null) return;

      const [encargados, [datos]] = await Promise.all([
        this.reservasRepository.controladoresDeZona(reserva.id_zona),
        this.reservasRepository.reservasConZona([reserva.id]),
      ]);
      if (!datos || encargados.length === 0) return;

      const aviso = armar(datos, new Date());
      await Promise.all(
        encargados.map((id) => this.notificador.avisar(id, aviso)),
      );
    });
  }

  /** Corre `envio` sin dejar que un error llegue a quien pidió el aviso. */
  private async sinFallar(
    sobre: string,
    envio: () => Promise<void>,
  ): Promise<void> {
    try {
      await envio();
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar sobre ${sobre}: ${(error as Error).message}`,
      );
    }
  }
}
