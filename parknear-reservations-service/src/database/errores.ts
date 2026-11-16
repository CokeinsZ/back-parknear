/** Lo que interesa de un error de Postgres (postgres-js `PostgresError`). */
export interface ErrorPostgres {
  code?: string;
  constraint_name?: string;
}

/**
 * El error de Postgres detrás de un error de drizzle. drizzle 0.45 envuelve los errores
 * del driver en `DrizzleQueryError`, y el código queda en `error.cause`.
 */
export function errorDePostgres(error: unknown): ErrorPostgres {
  const pg = (error as { cause?: unknown } | null)?.cause ?? error;
  return (pg ?? {}) as ErrorPostgres;
}

/** Deadlock o fallo de serialización: la transacción se puede reintentar. */
export function esReintentable(error: unknown): boolean {
  const { code } = errorDePostgres(error);
  return code === '40P01' || code === '40001';
}
