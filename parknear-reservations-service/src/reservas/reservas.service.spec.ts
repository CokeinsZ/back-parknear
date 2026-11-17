import { ConflictException } from '@nestjs/common';
import type { AvisosService } from './avisos.service';
import type { CreateReservaDto } from './dtos/create-reserva.dto';
import type { ReservaRecord } from './interfaces/reserva.interface';
import type { ReservasRepository } from './repositories/reservas.repository';
import { ReservasService, type Solicitante } from './reservas.service';

/** El admin no está limitado a zonas asignadas: así las pruebas no dependen de esa regla. */
const admin: Solicitante = { sub: 'admin-1', tipo_usuario: 'admin' };
const conductor: Solicitante = {
  sub: 'conductor-1',
  tipo_usuario: 'conductor',
};

function reserva(cambios: Partial<ReservaRecord> = {}): ReservaRecord {
  return {
    id: 12,
    id_conductor: conductor.sub,
    id_zona: 3,
    id_vehiculo: 'ABC123',
    fecha_real_inicio: null,
    fecha_fin: new Date(),
    precio: '12000.00',
    estado: 'pendiente',
    fecha_creacion: new Date(),
    fecha_actualizacion: new Date(),
    ...cambios,
  };
}

function crear() {
  const avisos = {
    nuevaReserva: jest.fn(() => Promise.resolve()),
    aceptada: jest.fn(() => Promise.resolve()),
    llegadaConfirmada: jest.fn(() => Promise.resolve()),
    canceladaPorConductor: jest.fn(() => Promise.resolve()),
  };
  const repositorio = {
    crearConCupo: jest.fn(),
    cambiarEstado: jest.fn(),
    confirmarLlegada: jest.fn(),
    cancelarPorConductor: jest.fn(),
  };
  const servicio = new ReservasService(
    repositorio as unknown as ReservasRepository,
    avisos as unknown as AvisosService,
  );

  /** Cuántos avisos se pidieron en total, de cualquier tipo. */
  const avisosPedidos = () =>
    Object.values(avisos).reduce(
      (total, aviso) => total + aviso.mock.calls.length,
      0,
    );

  return { servicio, repositorio, avisos, avisosPedidos };
}

describe('ReservasService: avisos push', () => {
  const dto: CreateReservaDto = { id_zona: 3, id_vehiculo: 'abc123', horas: 2 };

  it('B1: crear una reserva avisa a los encargados', async () => {
    const { servicio, repositorio, avisos } = crear();
    const creada = reserva();
    repositorio.crearConCupo.mockResolvedValue({ reserva: creada });

    await servicio.create(dto, conductor);

    expect(avisos.nuevaReserva).toHaveBeenCalledWith(creada);
  });

  it('si no se pudo crear la reserva, no avisa', async () => {
    const { servicio, repositorio, avisosPedidos } = crear();
    repositorio.crearConCupo.mockResolvedValue({ error: 'ZONA_SIN_CUPO' });

    await expect(servicio.create(dto, conductor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(avisosPedidos()).toBe(0);
  });

  it('B2: aceptar avisa al conductor', async () => {
    const { servicio, repositorio, avisos } = crear();
    const aceptada = reserva({ estado: 'activa' });
    repositorio.cambiarEstado.mockResolvedValue({ reserva: aceptada });

    await servicio.updateState(12, 'activa', admin);

    expect(avisos.aceptada).toHaveBeenCalledWith(aceptada);
  });

  it('sin B4: rechazar o cancelar como encargado no avisa a nadie', async () => {
    const { servicio, repositorio, avisosPedidos } = crear();
    repositorio.cambiarEstado.mockResolvedValue({
      reserva: reserva({ estado: 'cancelada' }),
    });

    await servicio.updateState(12, 'cancelada', admin);

    expect(avisosPedidos()).toBe(0);
  });

  it('una transición rechazada (409) no avisa', async () => {
    const { servicio, repositorio, avisosPedidos } = crear();
    repositorio.cambiarEstado.mockResolvedValue({
      actual: reserva({ estado: 'completada' }),
    });

    await expect(
      servicio.updateState(12, 'activa', admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(avisosPedidos()).toBe(0);
  });

  it('B3: confirmar la llegada avisa al conductor', async () => {
    const { servicio, repositorio, avisos } = crear();
    const parqueada = reserva({
      estado: 'activa',
      fecha_real_inicio: new Date(),
    });
    repositorio.confirmarLlegada.mockResolvedValue({ reserva: parqueada });

    await servicio.confirmarLlegada(12, admin);

    expect(avisos.llegadaConfirmada).toHaveBeenCalledWith(parqueada);
  });

  it('C2: que el conductor cancele avisa a los encargados', async () => {
    const { servicio, repositorio, avisos } = crear();
    const cancelada = reserva({ estado: 'cancelada' });
    repositorio.cancelarPorConductor.mockResolvedValue({ reserva: cancelada });

    await servicio.cancelarPorConductor(12, conductor.sub);

    expect(avisos.canceladaPorConductor).toHaveBeenCalledWith(cancelada);
  });
});
