/**
 * Búsqueda y paginación de los listados.
 *
 * Los listados nunca devuelven la tabla completa: devuelven una página
 * (`limit`/`offset`) y el total que coincide con la búsqueda. La búsqueda se
 * hace en la base de datos, sin distinguir mayúsculas ni tildes.
 *
 * Copia idéntica en users, zones y reservations: los servicios no comparten código.
 */

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/** Respuesta de un listado: los elementos de la página y el total de coincidencias. */
export interface Pagina<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Paginacion {
  limit: number;
  offset: number;
}

const LIMITE_POR_DEFECTO = 20;
const LIMITE_MAXIMO = 50;

/** Lee `limit` y `offset` del query string. Lo que no sea un número válido toma el valor por defecto. */
export function leerPaginacion(limit?: string, offset?: string): Paginacion {
  const limite = Number.parseInt(limit ?? '', 10);
  const desde = Number.parseInt(offset ?? '', 10);

  return {
    limit: limite > 0 ? Math.min(limite, LIMITE_MAXIMO) : LIMITE_POR_DEFECTO,
    offset: desde > 0 ? desde : 0,
  };
}

/** El texto buscado sin tildes, en minúsculas y sin espacios de sobra. null si quedó vacío. */
export function normalizarBusqueda(q?: string): string | null {
  const limpio = (q ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  return limpio === '' ? null : limpio;
}

/** Patrón de `LIKE` que encuentra el texto en cualquier parte, con `%`, `_` y `\` escapados. */
export function patronContiene(texto: string): string {
  return `%${texto.replace(/[\\%_]/g, (caracter) => `\\${caracter}`)}%`;
}

/**
 * La columna (o expresión) sin tildes y en minúsculas, para compararla con
 * `normalizarBusqueda`. Las mayúsculas con tilde se traducen aparte porque
 * `lower()` solo baja las letras ASCII si la base usa la configuración regional C.
 */
export function sinTildes(valor: SQL | AnyColumn): SQL {
  return sql`lower(translate(${valor}, 'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc'))`;
}
