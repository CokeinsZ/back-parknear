import { Logger } from '@nestjs/common';
import { DispositivosRepository } from './dispositivos.repository';
import type { Aviso, Notificador } from './notificador';

const URL_EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';
/** Si Expo no responde en este tiempo, el aviso se da por perdido: no se frena la petición que lo disparó. */
const ESPERA_MAXIMA_MS = 5000;

/** Un mensaje del API de Expo Push (https://docs.expo.dev/push-notifications/sending-notifications/). */
interface MensajeExpo {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  channelId: string;
  priority: 'high';
  sound: 'default';
  ttl?: number;
  tag?: string;
}

/** Respuesta de Expo: un ticket por mensaje, en el mismo orden, o `errors` si falló toda la petición. */
interface RespuestaExpo {
  data?: {
    status: 'ok' | 'error';
    message?: string;
    details?: { error?: string };
  }[];
  errors?: { code: string; message: string }[];
}

/**
 * Envía los avisos con Expo Push: un solo `fetch`, sin librerías. Expo los entrega a FCM
 * (Android) o APNs (iOS) con las credenciales que viven en EAS.
 *
 * - Nunca lanza: los errores se registran en el log y el aviso se pierde.
 * - `status: "ok"` solo dice que Expo recibió el aviso, no que llegó al teléfono (eso lo
 *   dicen los receipts, que no se consultan aquí).
 * - Nunca escribe el token en el log: identifica el teléfono de una persona.
 */
export class NotificadorExpo implements Notificador {
  private readonly logger = new Logger(NotificadorExpo.name);

  /**
   * @param tokenAccesoExpo Solo si en expo.dev se activa "Enhanced push security"
   *   (variable EXPO_ACCESS_TOKEN).
   */
  constructor(
    private readonly dispositivos: DispositivosRepository,
    private readonly tokenAccesoExpo?: string,
  ) {}

  async avisar(idUsuario: string, aviso: Aviso): Promise<void> {
    try {
      const tokens = await this.dispositivos.tokensDe(idUsuario);
      if (tokens.length === 0) return; // no dio permiso o nunca inició sesión en un teléfono

      const respuesta = await fetch(URL_EXPO_PUSH, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.tokenAccesoExpo
            ? { Authorization: `Bearer ${this.tokenAccesoExpo}` }
            : {}),
        },
        body: JSON.stringify(tokens.map((token) => mensaje(token, aviso))),
        signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
      });

      const { data: tickets = [], errors = [] } =
        (await respuesta.json()) as RespuestaExpo;

      if (!respuesta.ok || errors.length > 0) {
        this.logger.warn(
          `Expo rechazó el aviso "${aviso.datos.tipo}" (HTTP ${respuesta.status}): ${errors[0]?.message ?? 'sin detalle'}`,
        );
        return;
      }

      await Promise.all(
        tickets.map((ticket, i) =>
          this.revisarTicket(ticket, tokens[i], aviso),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar el aviso "${aviso.datos.tipo}" a Expo: ${(error as Error).message}`,
      );
    }
  }

  /** DeviceNotRegistered = desinstalaron la app o quitaron el permiso: se olvida ese teléfono. */
  private async revisarTicket(
    ticket: NonNullable<RespuestaExpo['data']>[number],
    token: string,
    aviso: Aviso,
  ): Promise<void> {
    if (ticket.status === 'ok') return;

    if (ticket.details?.error === 'DeviceNotRegistered') {
      await this.dispositivos.borrar(token);
      return;
    }

    this.logger.warn(
      `Expo no aceptó el aviso "${aviso.datos.tipo}": ${ticket.details?.error ?? ticket.message ?? 'sin detalle'}`,
    );
  }
}

function mensaje(token: string, aviso: Aviso): MensajeExpo {
  return {
    to: token,
    title: aviso.titulo,
    body: aviso.cuerpo,
    data: aviso.datos,
    channelId: aviso.canal,
    // Alta prioridad: los avisos de una reserva son de tiempo y pueden despertar el teléfono.
    priority: 'high',
    sound: 'default',
    ttl: aviso.ttlSegundos,
    tag: aviso.etiqueta,
  };
}
