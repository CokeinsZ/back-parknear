import * as avisos from './avisos';
import type {
  ReservaConZona,
  ReservaRecord,
} from './interfaces/reserva.interface';

/** Reserva hecha a las 3:00 p. m. de Colombia (20:00 UTC), por 2 horas. */
function reserva(cambios: Partial<ReservaRecord> = {}): ReservaRecord {
  return {
    id: 12,
    id_conductor: 'conductor-1',
    id_zona: 3,
    id_vehiculo: 'ABC123',
    fecha_real_inicio: null,
    fecha_fin: new Date('2026-11-16T22:00:00Z'),
    precio: '12000.00',
    estado: 'pendiente',
    fecha_creacion: new Date('2026-11-16T20:00:00Z'),
    fecha_actualizacion: new Date('2026-11-16T20:00:00Z'),
    ...cambios,
  };
}

const zona = { id: 3, indicaciones: 'Cra 23 con Calle 65\nFrente al parque' };

function conZona(cambios?: Partial<ReservaRecord>): ReservaConZona {
  return { reserva: reserva(cambios), zona };
}

/** Intl separa "p. m." con espacios especiales: se normalizan para comparar. */
function plano(texto: string): string {
  return texto.replace(/\s/g, ' ');
}

describe('formato', () => {
  it('escribe la hora de Colombia aunque el servidor corra en UTC', () => {
    expect(plano(avisos.hora(new Date('2026-11-16T20:15:00Z')))).toBe(
      '3:15 p. m.',
    );
  });

  it('escribe pesos con separador de miles', () => {
    expect(avisos.pesos(5000)).toBe('$5.000');
  });

  it('nombra la zona con la primera línea de sus indicaciones, o con su número', () => {
    expect(avisos.tituloZona(zona, 3)).toBe('Cra 23 con Calle 65');
    expect(avisos.tituloZona({ id: 3, indicaciones: '  ' }, 3)).toBe('Zona #3');
    expect(avisos.tituloZona(null, null)).toBe('tu zona');
  });
});

describe('A1 recordatorio de llegada', () => {
  it('dice cuánto falta, hasta qué hora y cuánto se cobra si no llega', () => {
    const aviso = avisos.recordatorioLlegada(
      conZona(),
      new Date('2026-11-16T20:10:00Z'),
    );

    expect(aviso.titulo).toBe('Te quedan 5 minutos para llegar');
    expect(plano(aviso.cuerpo)).toBe(
      'Cra 23 con Calle 65 · placa ABC123. Si a las 3:15 p. m. el encargado no ha ' +
        'verificado tu placa, la reserva se cancela y se cobran $5.000.',
    );
    expect(aviso.canal).toBe('recordatorios');
    expect(aviso.datos).toEqual({
      tipo: 'recordatorio_llegada',
      reservaId: '12',
      para: 'conductor',
    });
    expect(aviso.etiqueta).toBe('reserva-12');
  });

  it('caduca en el límite de llegada: después ya no sirve', () => {
    const aviso = avisos.recordatorioLlegada(
      conZona(),
      new Date('2026-11-16T20:10:00Z'),
    );
    expect(aviso.ttlSegundos).toBe(5 * 60);
  });

  it('cuenta los minutos reales si sale tarde', () => {
    expect(
      avisos.recordatorioLlegada(conZona(), new Date('2026-11-16T20:11:30Z'))
        .titulo,
    ).toBe('Te quedan 4 minutos para llegar');
    expect(
      avisos.recordatorioLlegada(conZona(), new Date('2026-11-16T20:14:30Z'))
        .titulo,
    ).toBe('Te quedan 1 minuto para llegar');
  });
});

describe('A2 recordatorio de fin', () => {
  it('dice a qué hora termina y ofrece extender', () => {
    const aviso = avisos.recordatorioFin(
      conZona({ estado: 'activa' }),
      new Date('2026-11-16T21:55:00Z'),
    );

    expect(aviso.titulo).toBe('Tu parqueo termina en 5 minutos');
    expect(plano(aviso.cuerpo)).toBe(
      'Cra 23 con Calle 65 · placa ABC123 · termina a las 5:00 p. m. ' +
        'Si necesitas más tiempo, extiéndelo desde la app.',
    );
    expect(aviso.canal).toBe('recordatorios');
    expect(aviso.ttlSegundos).toBe(5 * 60);
  });
});

describe('avisos de eventos', () => {
  const ahora = new Date('2026-11-16T20:02:00Z');

  it('B1 le pide al encargado aceptar o rechazar antes del límite', () => {
    const aviso = avisos.nuevaReserva(conZona(), ahora);

    expect(aviso.titulo).toBe('Nueva reserva en Cra 23 con Calle 65');
    expect(plano(aviso.cuerpo)).toBe(
      'Placa ABC123. Acéptala o recházala: el conductor tiene hasta las 3:15 p. m. para llegar.',
    );
    expect(aviso.datos.para).toBe('controlador');
    expect(aviso.canal).toBe('solicitudes');
  });

  it('B2 le dice al conductor hasta qué hora tiene para llegar', () => {
    const aviso = avisos.aceptada(conZona({ estado: 'activa' }), ahora);

    expect(aviso.titulo).toBe('El encargado aceptó tu reserva');
    expect(plano(aviso.cuerpo)).toContain('antes de las 3:15 p. m.');
    expect(aviso.datos.para).toBe('conductor');
  });

  it('B3 dice a qué hora termina el parqueo', () => {
    const aviso = avisos.llegadaConfirmada(
      conZona({ estado: 'activa', fecha_real_inicio: ahora }),
      ahora,
    );

    expect(plano(aviso.cuerpo)).toBe(
      'Tu parqueo en Cra 23 con Calle 65 termina a las 5:00 p. m. Te avisaremos 5 minutos antes.',
    );
  });

  it('B5 explica por qué se canceló y cuánto se cobra', () => {
    const aviso = avisos.noLlego(conZona({ estado: 'cancelada' }), ahora);

    expect(aviso.titulo).toBe('Tu reserva se canceló');
    expect(plano(aviso.cuerpo)).toBe(
      'No se verificó tu placa en Cra 23 con Calle 65 antes de las 3:15 p. m. ' +
        'Se cobra el cargo de reserva ($5.000).',
    );
  });

  it('ningún aviso queda con doble punto ("p. m..")', () => {
    const datos = conZona({ estado: 'activa', fecha_real_inicio: ahora });
    const todos = [
      avisos.recordatorioLlegada,
      avisos.recordatorioFin,
      avisos.nuevaReserva,
      avisos.aceptada,
      avisos.llegadaConfirmada,
      avisos.noLlego,
      avisos.canceladaPorConductor,
    ].map((armar) => armar(datos, ahora).cuerpo);

    for (const cuerpo of todos) expect(cuerpo).not.toContain('..');
  });

  it('C2 reemplaza en la bandeja del encargado al aviso de la reserva nueva', () => {
    const nueva = avisos.nuevaReserva(conZona(), ahora);
    const cancelada = avisos.canceladaPorConductor(
      conZona({ estado: 'cancelada' }),
      ahora,
    );

    expect(cancelada.titulo).toBe('El conductor canceló la reserva #12');
    expect(cancelada.datos.para).toBe('controlador');
    expect(cancelada.etiqueta).toBe(nueva.etiqueta);
  });
});
