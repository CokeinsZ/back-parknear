import { Logger } from '@nestjs/common';
import type { DispositivosRepository } from './dispositivos.repository';
import type { Aviso } from './notificador';
import { NotificadorExpo } from './notificador-expo';

const aviso: Aviso = {
  titulo: 'El encargado aceptó tu reserva',
  cuerpo: 'Llega antes de las 3:15 p. m.',
  datos: { tipo: 'aceptada', reservaId: '12', para: 'conductor' },
  canal: 'reservas',
  ttlSegundos: 300,
  etiqueta: 'reserva-12',
};

const TELEFONO_A = 'ExponentPushToken[aaa]';
const TELEFONO_B = 'ExponentPushToken[bbb]';

function crear(tokens: string[]) {
  const tokensDe = jest.fn(() => Promise.resolve(tokens));
  const borrar = jest.fn(() => Promise.resolve());
  const notificador = new NotificadorExpo(
    { tokensDe, borrar } as unknown as DispositivosRepository,
    'token-de-acceso',
  );
  return { notificador, borrar };
}

function respuestaDeExpo(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('NotificadorExpo', () => {
  let enviar: jest.SpiedFunction<typeof fetch>;
  let advertir: jest.SpiedFunction<Logger['warn']>;

  beforeEach(() => {
    enviar = jest.spyOn(global, 'fetch');
    advertir = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('si el usuario no tiene teléfonos, no llama a Expo', async () => {
    const { notificador } = crear([]);

    await notificador.avisar('usuario-1', aviso);

    expect(enviar).not.toHaveBeenCalled();
  });

  it('manda un mensaje por teléfono, con canal, etiqueta, caducidad y prioridad alta', async () => {
    const { notificador } = crear([TELEFONO_A, TELEFONO_B]);
    enviar.mockResolvedValue(
      respuestaDeExpo({ data: [{ status: 'ok' }, { status: 'ok' }] }),
    );

    await notificador.avisar('usuario-1', aviso);

    const [url, opciones] = enviar.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(opciones?.headers).toMatchObject({
      Authorization: 'Bearer token-de-acceso',
    });
    // El adaptador manda el cuerpo como texto JSON (JSON.stringify).
    const cuerpo = opciones?.body as string;
    expect(JSON.parse(cuerpo)).toEqual([
      expect.objectContaining({
        to: TELEFONO_A,
        title: aviso.titulo,
        body: aviso.cuerpo,
        data: aviso.datos,
        channelId: 'reservas',
        priority: 'high',
        ttl: 300,
        tag: 'reserva-12',
      }),
      expect.objectContaining({ to: TELEFONO_B }),
    ]);
  });

  it('olvida solo el teléfono que Expo ya no reconoce (DeviceNotRegistered)', async () => {
    const { notificador, borrar } = crear([TELEFONO_A, TELEFONO_B]);
    enviar.mockResolvedValue(
      respuestaDeExpo({
        data: [
          { status: 'ok' },
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
        ],
      }),
    );

    await notificador.avisar('usuario-1', aviso);

    expect(borrar).toHaveBeenCalledTimes(1);
    expect(borrar).toHaveBeenCalledWith(TELEFONO_B);
  });

  it('nunca lanza: si Expo no responde, registra el problema y sigue', async () => {
    const { notificador, borrar } = crear([TELEFONO_A]);
    enviar.mockRejectedValue(new Error('timeout'));

    await expect(
      notificador.avisar('usuario-1', aviso),
    ).resolves.toBeUndefined();
    expect(advertir).toHaveBeenCalled();
    expect(borrar).not.toHaveBeenCalled();
  });

  it('nunca escribe el token del teléfono en el log', async () => {
    const { notificador } = crear([TELEFONO_A]);
    enviar.mockResolvedValue(
      respuestaDeExpo({
        data: [{ status: 'error', details: { error: 'MessageTooBig' } }],
      }),
    );

    await notificador.avisar('usuario-1', aviso);

    expect(advertir).toHaveBeenCalled();
    expect(JSON.stringify(advertir.mock.calls)).not.toContain('PushToken');
  });
});
