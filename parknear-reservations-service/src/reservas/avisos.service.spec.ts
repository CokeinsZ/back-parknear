import { Logger } from '@nestjs/common';
import type { Aviso, Notificador } from 'src/notificaciones/notificador';
import { AvisosService } from './avisos.service';
import type {
  ReservaConZona,
  ReservaRecord,
} from './interfaces/reserva.interface';
import type { ReservasRepository } from './repositories/reservas.repository';

/** Guarda lo que se habría enviado, en vez de enviarlo. */
class NotificadorEnMemoria implements Notificador {
  readonly enviados: { idUsuario: string; aviso: Aviso }[] = [];

  avisar(idUsuario: string, aviso: Aviso): Promise<void> {
    this.enviados.push({ idUsuario, aviso });
    return Promise.resolve();
  }

  tipos(): string[] {
    return this.enviados.map(({ aviso }) => aviso.datos.tipo);
  }
}

function reserva(cambios: Partial<ReservaRecord> = {}): ReservaRecord {
  return {
    id: 12,
    id_conductor: 'conductor-1',
    id_zona: 3,
    id_vehiculo: 'ABC123',
    fecha_real_inicio: null,
    fecha_fin: new Date(Date.now() + 2 * 60 * 60 * 1000),
    precio: '12000.00',
    estado: 'pendiente',
    fecha_creacion: new Date(),
    fecha_actualizacion: new Date(),
    ...cambios,
  };
}

function crear(encargados: string[] = ['encargado-1', 'encargado-2']) {
  const notificador = new NotificadorEnMemoria();
  const reservasConZona = jest.fn(
    (ids: number[]): Promise<ReservaConZona[]> =>
      Promise.resolve(
        ids.map((id) => ({
          reserva: reserva({ id }),
          zona: { id: 3, indicaciones: 'Cra 23 con Calle 65' },
        })),
      ),
  );
  const controladoresDeZona = jest.fn(() => Promise.resolve(encargados));
  const repositorio = {
    reservasConZona,
    controladoresDeZona,
  } as unknown as ReservasRepository;

  return {
    avisos: new AvisosService(notificador, repositorio),
    notificador,
    reservasConZona,
  };
}

describe('AvisosService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('B1: avisa de una reserva nueva a cada encargado de la zona', async () => {
    const { avisos, notificador } = crear();

    await avisos.nuevaReserva(reserva());

    expect(notificador.enviados.map(({ idUsuario }) => idUsuario)).toEqual([
      'encargado-1',
      'encargado-2',
    ]);
    expect(notificador.tipos()).toEqual(['nueva_reserva', 'nueva_reserva']);
  });

  it('B1: si la zona no tiene encargados, no avisa a nadie', async () => {
    const { avisos, notificador } = crear([]);

    await avisos.nuevaReserva(reserva());

    expect(notificador.enviados).toHaveLength(0);
  });

  it('B2 y B3: avisan al conductor de la reserva', async () => {
    const { avisos, notificador } = crear();

    await avisos.aceptada(reserva({ estado: 'activa' }));
    await avisos.llegadaConfirmada(
      reserva({ estado: 'activa', fecha_real_inicio: new Date() }),
    );

    expect(notificador.enviados.map(({ idUsuario }) => idUsuario)).toEqual([
      'conductor-1',
      'conductor-1',
    ]);
    expect(notificador.tipos()).toEqual(['aceptada', 'llegada_confirmada']);
  });

  it('C2: avisa a los encargados que el conductor canceló', async () => {
    const { avisos, notificador } = crear(['encargado-1']);

    await avisos.canceladaPorConductor(reserva({ estado: 'cancelada' }));

    expect(notificador.enviados).toEqual([
      expect.objectContaining({ idUsuario: 'encargado-1' }),
    ]);
    expect(notificador.tipos()).toEqual(['cancelada_por_conductor']);
  });

  it('A1, A2 y B5: envía al conductor cada aviso que el job reclamó', async () => {
    const { avisos, notificador, reservasConZona } = crear();

    await avisos.programados({
      recordatorioLlegada: [1],
      recordatorioFin: [2],
      noLlego: [3],
    });

    expect(reservasConZona).toHaveBeenCalledTimes(3);
    expect(notificador.tipos().sort()).toEqual([
      'no_llego',
      'recordatorio_fin',
      'recordatorio_llegada',
    ]);
    expect(
      notificador.enviados.every(
        ({ idUsuario }) => idUsuario === 'conductor-1',
      ),
    ).toBe(true);
  });

  it('nunca lanza: si falla la base de datos, el aviso se pierde y la reserva sigue', async () => {
    const { avisos, notificador, reservasConZona } = crear();
    reservasConZona.mockRejectedValue(new Error('sin conexión'));

    await expect(avisos.aceptada(reserva())).resolves.toBeUndefined();
    await expect(
      avisos.programados({
        recordatorioLlegada: [1],
        recordatorioFin: [],
        noLlego: [],
      }),
    ).resolves.toBeUndefined();
    expect(notificador.enviados).toHaveLength(0);
  });
});
