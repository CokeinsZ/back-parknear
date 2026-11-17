/*
 * El puerto de los avisos: el resto del servicio dice "avisa al usuario X" sin saber cómo.
 * Hoy el adaptador es Expo Push (NotificadorExpo); en desarrollo, la consola
 * (NotificadorConsola). Cambiar de medio es un adaptador nuevo y una línea en
 * NotificacionesModule, sin tocar las reservas.
 */

/** Canal de Android donde se muestra el aviso. La app crea los tres al arrancar. */
export type CanalAviso = 'recordatorios' | 'solicitudes' | 'reservas';

export interface Aviso {
  titulo: string;
  cuerpo: string;
  /** Viaja oculto: la app lo usa para abrir la pantalla correcta ({ tipo, reservaId, para }). */
  datos: Record<string, string>;
  canal: CanalAviso;
  /**
   * Segundos que el servicio de push puede guardar el aviso si el teléfono no está disponible.
   * Pasado ese tiempo lo descarta: un recordatorio que llega tarde no sirve.
   */
  ttlSegundos?: number;
  /** `tag` de Android: un aviso con la misma etiqueta reemplaza al anterior en la bandeja. */
  etiqueta?: string;
}

export interface Notificador {
  /**
   * Envía el aviso a todos los teléfonos del usuario. NUNCA lanza: lo que disparó el aviso
   * (un cambio de la reserva) ya ocurrió, y que el aviso falle no puede volverlo un error.
   */
  avisar(idUsuario: string, aviso: Aviso): Promise<void>;
}

/** Token de inyección del puerto (las interfaces no existen en tiempo de ejecución). */
export const NOTIFICADOR = Symbol('NOTIFICADOR');
