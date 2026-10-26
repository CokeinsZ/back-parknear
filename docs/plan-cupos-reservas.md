# Plan: cupos automáticos, reservas sin sobreventa y vencimiento de reservas

> Escrito el 2026-10-26 a partir del código en `cdg@bc4f6b6` (backend) y `ZoneUp-app@915a05e`
> (rama `tests`). Las rutas y líneas citadas son de esos commits. Si el código cambió, verifícalas
> antes de editar.
>
> **Este documento es autosuficiente**: la conversación en la que se diseñó se borró. El flujo de
> la reserva (§2) lo definió el usuario; no lo cambies sin preguntarle.

## Estado de la implementación (2026-10-26)

- **Hecho, sin commit**, en la rama `feat/cupos-reservas` de `cdg`: fases 1 (BD), 2 (reservations), 3 (zones) y el schema de payments. Build y lint limpios en los archivos tocados.
- **Migración aplicada solo en la branch de pruebas de Neon** (`ep-spring-king-…`), no en producción. Allí quedaron datos de prueba identificables: usuarios `cupos.*@prueba.zoneup`, vehículos `TQA001`-`TQA024` y `TQB024`, y zonas "PRUEBA cupos zona A/B/C".
- **Pruebas del §9.2**: pasan A-O contra esa branch. P (la app) queda pendiente.
- **Falta**: fase 4 (app) y fase 6 (despliegue). La app actual **no** funciona con este backend: `POST /reservas` y `PATCH /extend` responden 400 a su cuerpo viejo.
- **Diferencias con lo escrito abajo**:
  - Caso K: si aceptar (o la llegada) gana la carrera, la cancelación igual aplica después, porque cancelar una `activa` es válido, y las dos responden 200. El resultado siempre equivale a hacerlas en serie.
  - `LLEGADA_VENCIDA` se decide con `fecha_actualizacion >= fecha_creacion + 15 min` en vez del reloj. Así una reserva rechazada a tiempo no se reporta como vencida.
  - Los 404/403/400 propios también llevan `codigo`: `RESERVA_NO_EXISTE`, `RESERVA_AJENA`, `ESTADO_INVALIDO`, `DUPLICADO`, `REFERENCIA_INVALIDA`, `FECHA_INVALIDA`, y en zones `CAPACIDAD_TOTAL_INVALIDA`.
  - `POST /reservas/:id/llegada` responde 200, no 201.
  - El reintento por `40P01`/`40001` está en el repositorio (`transaccion()`), no en `handleDbError`.

## 0. Contexto y reglas de trabajo

- **Backend**: `/home/btw/code/cdg`.
  - Gateway en Rust: `Parknear-serviceBus`. Enruta por prefijo (`/reservas` → reservations-service), así que **no hay que tocarlo**.
  - Microservicios NestJS 11 con drizzle-orm 0.45 y postgres-js: `parknear-*-service`. Todos usan **la misma base de datos** Postgres (Neon en producción).
  - El esquema vive en `db/init.sql`; no hay migraciones con drizzle-kit.
- **App**: `/home/btw/code/ZoneUp-app` (Expo SDK 57, expo-router, Uniwind).
  - **Antes de escribir código de la app, lee la documentación de Expo v57**: https://docs.expo.dev/versions/v57.0.0/ (lo exige `AGENTS.md`).
  - Las alertas se muestran con `useAlerta()` de `src/components/alerta/AlertaProvider.tsx`. No uses `Alert.alert`.
  - Los listados usan `src/hooks/useListaPaginada.tsx`.
- **Reglas**:
  - **No tocar la base de datos de producción (Neon).** La migración la aplica el usuario.
  - No hacer commit sin que el usuario lo pida.
  - No matar el `npm start` del usuario (puerto 8081). Para pruebas usa otros puertos.
  - No leer `/home/btw/code/cdg/.env`.
- **Fases**: 1 base de datos → 2 reservations-service → 3 zones-service → 4 app → 5 pruebas → 6 despliegue.

## 1. Qué se pidió y qué decidió el usuario

Pedido original:
1. Cupos automáticos: al reservar se ocupa un cupo, al cancelar se libera, y no se puede reservar en una zona sin cupo.
2. Control atómico de cupos, para que no haya sobreventa si dos dispositivos reservan el último cupo al mismo tiempo.
3. Validar en el backend que no haya otra reserva en curso.
4. Un job que cancela las reservas pendientes tras 15 minutos y completa las activas al terminar su tiempo, liberando el cupo.

| # | Tema | Decisión del usuario |
|---|------|---------------------|
| 1 | Llegada | Confirmar la llegada **deja la reserva `activa`** (no la completa). El job la pasa a `completada` cuando termina su tiempo. |
| 2 | No llegó (no-show) | Si el conductor no llega en los 15 minutos desde que reservó, la reserva **se cancela**. |
| 3 | Reserva en curso | **Una por vehículo**: un conductor con dos carros puede tener dos. |
| 4 | Cupos | **Calculados**: disponibles = capacidad total − reservas que ocupan. No se usa un contador. |
| 5 | Job | **Cada minuto**. |
| 6 | Cobro | El cargo de reserva ($5.000) se cobra **siempre**, se complete o se cancele la reserva. |

Regla de cobro de la decisión 6 (**confirmada por el usuario**):
- Una reserva cancelada **sin llegada** (rechazada, anulada antes de llegar o no llegó) queda con `precio = 5000`: solo el cargo.
- Una cancelada **después** de la llegada conserva su precio.
- Una completada conserva su precio (horas × 3.500 + 5.000).
- La regla vive en la constante `CARGO_RESERVA` y en la transición a `cancelada` (§6).

## 2. El flujo de la reserva y sus fechas (definido por el usuario)

1. **El conductor reserva** → `pendiente`. Desde ese momento tiene **15 minutos para llegar** (cuentan desde `fecha_creacion`).
2. **El encargado acepta** dentro de esos 15 minutos, antes de que el conductor llegue → `activa`.
3. **El conductor llega** y el encargado confirma la llegada verificando la placa → se llena `fecha_real_inicio`. La reserva **sigue `activa`**.
4. **Termina el tiempo** (`fecha_fin`) → el job la pasa a `completada`.

Qué significa cada fecha. **Ninguna se sobrescribe**:

| Columna | Significado | Quién la escribe |
|---|---|---|
| `fecha_creacion` | Cuándo se hizo la reserva. De aquí cuentan los 15 minutos para llegar. | El INSERT |
| `fecha_real_inicio` | **Cuándo llegó el vehículo** y el encargado lo confirmó con la placa. **NULL mientras no ha llegado.** | Solo "confirmar llegada", una sola vez |
| `fecha_fin` | Fin de la reserva, calculado al crear: `fecha_creacion + horas`. | El INSERT. Solo cambia si el conductor **extiende** (lo pide y lo paga). Aceptar, llegar, cancelar y completar **no la tocan**. |
| `fecha_actualizacion` | Último cambio. En una cancelada o completada, es cuándo pasó. | Cada cambio |

**Lo que hace hoy el código y hay que corregir**:
- Al crear, llena `fecha_real_inicio` con la hora de creación (`reservas.service.ts:32-40`).
- Al aceptar, **reinicia** `fecha_real_inicio` y **corre** `fecha_fin` (`reservas.service.ts:129-138`).
- Al cancelar o completar, pone `fecha_fin = ahora` (`:140-144`).
- "Confirmar llegada" pasa la reserva a `completada` y libera el cupo con el carro parqueado. La app lo hace en `src/api/reservas.ts:249-254`.

Consecuencias:
- **No hace falta columna nueva.** `fecha_real_inicio` pasa a ser *nullable*, y que esté en NULL significa "no ha llegado".
- La ventana de la reserva, la duración y el precio se calculan siempre con `fecha_creacion → fecha_fin`.
- `activa` tiene dos momentos:
  - aceptada y en camino (`fecha_real_inicio IS NULL`);
  - parqueada (`fecha_real_inicio IS NOT NULL`).

## 3. Modelo de estados nuevo

```
 crear (POST /reservas)
        │
        ▼
 ┌─────────────┐  encargado: aceptar   ┌────────────────────┐  encargado: placa coincide   ┌─────────────────────┐  job: fecha_fin   ┌────────────┐
 │  pendiente  │ ────────────────────▶ │ activa, en camino  │ ───────────────────────────▶ │ activa, parqueada   │ ────────────────▶ │ completada │
 │ (sin llegar)│  (dentro de 15 min)   │ fecha_real_inicio  │  (dentro de 15 min;          │ fecha_real_inicio = │   <= ahora        └────────────┘
 └─────────────┘                       │ = NULL             │   llena fecha_real_inicio)   │ hora de llegada     │
    │      │                           └────────────────────┘                              └─────────────────────┘
    │      │                              │            │                                              │
    │      │ job: 15 min sin llegar       │ job: 15 min sin llegar    encargado: cancelar               │ encargado: cancelar
    ▼      ▼                              ▼            ▼                                              ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │                                                  cancelada                                                │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   (rechazar = encargado cancela una pendiente)
```

"Ahora" siempre es la hora de la base de datos en UTC (ver §4).

| Acción | Quién y endpoint | Guarda (se aplica después de vencer lo vencido) | Cambios |
|---|---|---|---|
| Crear → `pendiente` | Conductor, `POST /reservas {id_zona, id_vehiculo, horas}` | El vehículo es suyo, no tiene otra reserva en curso y la zona tiene cupo (§6.5) | `fecha_creacion` = ahora, `fecha_real_inicio` = NULL, `fecha_fin` = ahora + horas, `precio` = 5000 + horas × 3500 |
| **Aceptar**: `pendiente` → `activa` | Encargado o admin, `PUT /reservas/:id/state {estado:'activa'}` | `estado='pendiente'` (sigue dentro de los 15 minutos) | Solo `estado`. **No toca fechas.** |
| **Confirmar llegada** | Encargado o admin, **`POST /reservas/:id/llegada`** (nuevo) | `estado='activa'` y `fecha_real_inicio IS NULL` (dentro de los 15 minutos) | `fecha_real_inicio` = ahora. El estado sigue `activa` y `fecha_fin` no cambia. |
| **Rechazar o cancelar** → `cancelada` | Encargado o admin, `PUT /reservas/:id/state {estado:'cancelada'}` | `estado IN ('pendiente','activa')` | `precio` = 5000 si `fecha_real_inicio IS NULL`; si ya llegó, sin cambio. Las fechas no se tocan. |
| No llegó → `cancelada` | Job | `estado IN ('pendiente','activa')`, `fecha_real_inicio IS NULL`, `fecha_creacion <= ahora − 15 min` | `precio` = 5000 |
| Terminó → `completada` | Job | `estado='activa'`, `fecha_real_inicio IS NOT NULL`, `fecha_fin <= ahora` | Solo `estado` |
| **Extender** | Conductor dueño, `PATCH /reservas/:id/extend {horas}` | En curso, y `fecha_fin + horas <= fecha_creacion + 24 h` | `fecha_fin` += horas, `precio` += horas × 3500 |

Reglas:
- Cualquier otra combinación devuelve **409**.
- Confirmar la llegada de una `pendiente` devuelve 409 "Primero acepta la reserva". Es el flujo del usuario: primero aceptar, luego confirmar.
- Nadie pasa una reserva a `completada` a mano: solo el job.
- "Vencer primero" significa que cada acción, dentro de su transacción, aplica antes el vencimiento a esa reserva. Así una llegada o una aceptación tardía (15 minutos o más) no revive una reserva vencida: la reserva queda `cancelada` y la respuesta es 409 `LLEGADA_VENCIDA`.

## 4. La regla única de qué ocupa un cupo

Una reserva **ocupa un cupo** si:
- **va en camino**: `estado IN ('pendiente','activa')`, `fecha_real_inicio IS NULL` y `fecha_creacion > ahora − 15 minutos`; **o**
- **está parqueada**: `estado = 'activa'`, `fecha_real_inicio IS NOT NULL` y `fecha_fin > ahora`.

Se define **una sola vez**, en la vista `reservas_en_curso` (§5.2). Los cupos disponibles de una zona son `capacidad_total − count(reservas_en_curso de la zona)`, y salen de la vista `zonas_con_disponibilidad`.

Como la regla depende de la hora real, un cupo se libera justo a tiempo **aunque el job se atrase**. El job solo pone los estados al día. Tampoco existe el paso "devolver el cupo", así que no puede devolverse dos veces.

**Fechas y zona horaria (importante):**
- Las columnas son `timestamp` **sin zona**, con la hora UTC.
- drizzle escribe `Date.toISOString()` y Postgres descarta la `Z` (`node_modules/drizzle-orm/pg-core/columns/timestamp.js:34`). Al leer, drizzle le agrega `+0000` (`:31`).
- Por eso, en SQL "ahora" **siempre** es `(now() at time zone 'utc')`, nunca `now()` ni `localtimestamp`.
- En TypeScript va como una constante: `ahoraUtc`, en §6.2.
- Dentro de una transacción `now()` no cambia, así que todas las sentencias usan el mismo "ahora".

## 5. Fase 1: base de datos

Archivos:
- **Nuevo**: `db/migrations/001_cupos_calculados.sql`, con el contenido de §5.2.
- **`db/init.sql`**, para instalaciones nuevas en Docker:
  - En `reservas`, cambiar `fecha_real_inicio TIMESTAMP NOT NULL` por `fecha_real_inicio TIMESTAMP`, con un comentario: "llegada confirmada por el encargado; NULL = no ha llegado".
  - Cambiar los `DEFAULT NOW()` de `fecha_creacion` y `fecha_actualizacion` por `DEFAULT (now() at time zone 'utc')`.
  - Agregar al final las vistas, los índices y el CHECK de §5.2 (d, e, f).
  - `init.sql` solo corre con un volumen vacío.

El usuario aplica la migración en Neon (editor SQL o psql) **después** de probarla en local.

### 5.1 Diagnóstico (solo lectura)

Corre esto primero, en local y luego en Neon (lo corre el usuario), y muéstrale el resultado al usuario:

```sql
SHOW TimeZone;  -- esperado: UTC / GMT / Etc/UTC
SELECT estado, count(*) FROM reservas GROUP BY estado ORDER BY 1;
-- 'completada' en el modelo viejo = se confirmó la placa; si su tiempo no ha terminado, el carro sigue parqueado
SELECT count(*) FROM reservas
 WHERE estado = 'completada' AND fecha_creacion + (fecha_fin - fecha_real_inicio) > (now() at time zone 'utc');
-- vehículos con más de una reserva pendiente o activa (bloquearían el índice único)
SELECT id_vehiculo, count(*) FROM reservas WHERE estado IN ('pendiente','activa') GROUP BY 1 HAVING count(*) > 1;
-- en curso sin fecha_fin (datos rotos)
SELECT id, estado FROM reservas WHERE estado IN ('pendiente','activa') AND fecha_fin IS NULL;
-- contador viejo vs. capacidad total
SELECT id, capacidad, capacidad_total FROM zonas_azules ORDER BY id;
```

### 5.2 Migración (idempotente)

```sql
BEGIN;

-- a) Fechas por defecto en UTC, igual que las que escribe el backend.
ALTER TABLE reservas ALTER COLUMN fecha_creacion      SET DEFAULT (now() at time zone 'utc');
ALTER TABLE reservas ALTER COLUMN fecha_actualizacion SET DEFAULT (now() at time zone 'utc');

-- b) fecha_real_inicio pasa a ser la LLEGADA (NULL = no ha llegado), y la ventana va desde la creación.
--    Conversión de los datos del modelo viejo, UNA sola vez: solo corre mientras la columna sigue NOT NULL.
--    En el modelo viejo, aceptar movía la ventana (inicio = aceptación, fin = aceptación + duración)
--    y confirmar la llegada completaba la reserva. Los precios históricos no se tocan.
DO $$
BEGIN
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'reservas'
         AND column_name = 'fecha_real_inicio') = 'NO' THEN

    ALTER TABLE reservas ALTER COLUMN fecha_real_inicio DROP NOT NULL;

    -- 'activa' vieja = aceptada, sin llegada: ventana desde la creación (misma duración), sin llegada.
    UPDATE reservas
       SET fecha_fin = fecha_creacion + (fecha_fin - fecha_real_inicio),
           fecha_real_inicio = NULL
     WHERE estado = 'activa';

    -- 'pendiente' y 'cancelada' viejas nunca llegaron (en el modelo viejo, llegar = completar).
    UPDATE reservas SET fecha_real_inicio = NULL WHERE estado IN ('pendiente', 'cancelada');

    -- 'completada' vieja = se confirmó la placa, y fecha_actualizacion guarda ese momento (la llegada).
    -- Si su tiempo (desde la creación) no ha terminado, el carro sigue parqueado: vuelve a 'activa'.
    -- Postgres evalúa todo el SET con los valores viejos.
    UPDATE reservas
       SET fecha_fin = fecha_creacion + (fecha_fin - fecha_real_inicio),
           fecha_real_inicio = fecha_actualizacion,
           estado = CASE WHEN fecha_creacion + (fecha_fin - fecha_real_inicio) > (now() at time zone 'utc')
                         THEN 'activa'::estado_reserva ELSE 'completada'::estado_reserva END
     WHERE estado = 'completada' AND fecha_fin IS NOT NULL;
  END IF;
END $$;

-- c) Lo que ya debió vencer (lo mismo que hace el job; las dos sentencias son idempotentes).
UPDATE reservas SET estado = 'cancelada', precio = 5000, fecha_actualizacion = (now() at time zone 'utc')
 WHERE estado IN ('pendiente','activa') AND fecha_real_inicio IS NULL
   AND fecha_creacion <= (now() at time zone 'utc') - interval '15 minutes';
UPDATE reservas SET estado = 'completada', fecha_actualizacion = (now() at time zone 'utc')
 WHERE estado = 'activa' AND fecha_real_inicio IS NOT NULL AND fecha_fin <= (now() at time zone 'utc');
--    En curso sin fecha_fin: datos rotos.
UPDATE reservas SET estado = 'cancelada', fecha_actualizacion = (now() at time zone 'utc')
 WHERE estado IN ('pendiente','activa') AND fecha_fin IS NULL;
--    Vehículo con más de una en curso: se deja la más reciente.
UPDATE reservas r SET estado = 'cancelada', fecha_actualizacion = (now() at time zone 'utc')
 WHERE r.estado IN ('pendiente','activa') AND r.id_vehiculo IS NOT NULL
   AND EXISTS (SELECT 1 FROM reservas o
                WHERE o.id_vehiculo = r.id_vehiculo AND o.estado IN ('pendiente','activa') AND o.id > r.id);

-- d) Qué ocupa un cupo. ÚNICA definición. Los 15 minutos también están en reglas.ts (MINUTOS_PARA_LLEGAR).
CREATE OR REPLACE VIEW reservas_en_curso AS
SELECT r.id, r.id_zona, r.id_vehiculo, r.id_conductor, r.estado,
       r.fecha_creacion, r.fecha_real_inicio, r.fecha_fin
  FROM reservas r
 WHERE (r.estado IN ('pendiente','activa') AND r.fecha_real_inicio IS NULL          -- en camino
        AND r.fecha_creacion > (now() at time zone 'utc') - interval '15 minutes')
    OR (r.estado = 'activa' AND r.fecha_real_inicio IS NOT NULL                     -- parqueada
        AND r.fecha_fin > (now() at time zone 'utc'));

-- e) Zonas con los cupos disponibles calculados. `capacidad` conserva el nombre que ya usa la app.
CREATE OR REPLACE VIEW zonas_con_disponibilidad AS
SELECT z.id, z.latitud, z.longitud, z.indicaciones, z.capacidad_total,
       greatest(z.capacidad_total - coalesce(o.ocupados, 0), 0)::int AS capacidad
  FROM zonas_azules z
  LEFT JOIN (SELECT id_zona, count(*)::int AS ocupados FROM reservas_en_curso GROUP BY id_zona) o
         ON o.id_zona = z.id;

-- f) Índices. El parcial por zona también le sirve al job (su WHERE implica el predicado).
CREATE INDEX IF NOT EXISTS ix_reservas_en_curso_zona
    ON reservas (id_zona) WHERE estado IN ('pendiente','activa');
--    Garantía final de "una reserva en curso por vehículo" (los NULL no chocan).
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservas_vehiculo_en_curso
    ON reservas (id_vehiculo) WHERE estado IN ('pendiente','activa');

-- g) Capacidad total válida.
ALTER TABLE zonas_azules DROP CONSTRAINT IF EXISTS ck_zonas_capacidad_total;
ALTER TABLE zonas_azules ADD CONSTRAINT ck_zonas_capacidad_total CHECK (capacidad_total >= 0);

COMMIT;
```

Notas:
- `zonas_azules.capacidad` (el contador viejo) **se queda, pero sin uso**. Ningún código la lee ni la escribe; tiene `DEFAULT 0`.
  - Se borra en una fase posterior, cuando todo esté estable: `ALTER TABLE zonas_azules DROP COLUMN capacidad;`.
  - Hay que quitarla también de los `schema.ts` de zones, reservations y **payments**, y de `parknear-zones-service/src/zones/entities/zone.entity.ts`.
- **Reversión de la parte estructural**: la conversión del paso b no se puede deshacer. Volver a `NOT NULL` exige llenar antes los NULL.

  ```sql
  DROP VIEW IF EXISTS zonas_con_disponibilidad; DROP VIEW IF EXISTS reservas_en_curso;
  DROP INDEX IF EXISTS ux_reservas_vehiculo_en_curso; DROP INDEX IF EXISTS ix_reservas_en_curso_zona;
  -- si se vuelve al backend viejo, recalcular su contador:
  UPDATE zonas_azules z SET capacidad = greatest(capacidad_total - (SELECT count(*) FROM reservas r
         WHERE r.id_zona = z.id AND r.estado IN ('pendiente','activa')), 0);
  ```

## 6. Fase 2: reservations-service (`parknear-reservations-service`)

### 6.1 Dependencia y módulo
- `npm i @nestjs/schedule`. Usa la última versión compatible con Nest 11; el instalado es `@nestjs/core` 11.1.18.
- `src/app.module.ts`: agregar `ScheduleModule.forRoot()` a `imports`.
- `src/reservas/reservas.module.ts`: agregar `VencimientoService` (§6.8) a `providers`.

### 6.2 Nuevo `src/reservas/reglas.ts`

```ts
import { sql } from 'drizzle-orm';

/** Tarifa por hora de parqueo (COP). */
export const TARIFA_HORA = 3500;
/** Cargo fijo por reservar (COP). Se cobra siempre, aunque la reserva se cancele. */
export const CARGO_RESERVA = 5000;
/** Minutos que tiene el conductor para llegar desde que reserva. OJO: también está en la vista `reservas_en_curso`. */
export const MINUTOS_PARA_LLEGAR = 15;
export const HORAS_MIN = 1;
/** Con 24 h el precio máximo es 89.000, dentro de decimal(7,2) (máx. 99.999,99). */
export const HORAS_MAX = 24;

/** "Ahora" en UTC, como se guardan las columnas `timestamp` (sin zona) de reservas. */
export const ahoraUtc = sql`(now() at time zone 'utc')`;

export function precioPorHoras(horas: number): string {
  return (CARGO_RESERVA + horas * TARIFA_HORA).toFixed(2);
}
```

Quita `calcularPrecio` de `reservas.service.ts:24-28`.

### 6.3 `src/database/schema.ts`
- En `reservas`: `fecha_real_inicio: timestamp('fecha_real_inicio', { mode: 'date' })` **sin `.notNull()`**.
  - Haz lo mismo en `parknear-payments-service/src/database/schema.ts`.
  - En `src/reservas/interfaces/reserva.interface.ts`: `fecha_real_inicio: Date | null`, con el comentario "llegada confirmada; null = no ha llegado".
- Declara la vista (solo lectura):

```ts
import { pgView } from 'drizzle-orm/pg-core';

/** Reservas que ocupan un cupo ahora mismo (vista de db/migrations/001). */
export const reservasEnCurso = pgView('reservas_en_curso', {
  id: integer('id').notNull(),
  id_zona: integer('id_zona'),
  id_vehiculo: varchar('id_vehiculo', { length: 10 }),
  id_conductor: uuid('id_conductor'),
  estado: estadoReservaEnum('estado').notNull(),
}).existing(); // existing(): drizzle-kit no intenta crearla
```

### 6.4 DTOs
- **`create-reserva.dto.ts`**: `{ id_zona: int ≥ 1, id_vehiculo: string ≤ 10, horas: int entre HORAS_MIN y HORAS_MAX }` (con `@Type(() => Number) @IsInt() @Min() @Max()`).
  - **Se quita `id_conductor`**: el conductor sale del token (`req.user.sub`). Hoy cualquiera puede reservar a nombre de otro.
  - **Se quita `fecha_fin`**: el servidor calcula `fecha_creacion + horas` con el reloj de la base de datos. Hoy se usa el reloj del teléfono y el precio sale fraccionado: 1 hora puede costar 8.499,97.
- **`extend-reserva.dto.ts`**: `{ horas: int entre 1 y 23 }`, en vez de `fecha_fin`.
- **`update-reserva-state.dto.ts`**: `{ estado: IsIn(['activa','cancelada']) }`, donde `activa` = aceptar. **Se quita `fecha_fin`**.
- La llegada **no** usa este DTO: tiene su propio endpoint, sin cuerpo.
- El `ValidationPipe` global tiene `forbidNonWhitelisted`, así que una app vieja que mande `id_conductor` o `fecha_fin` recibe 400. Por eso **la app y el backend se despliegan juntos**.

### 6.5 Repositorio (`src/reservas/repositories/reservas.repository.ts`)

Se **eliminan** `decrementCapacity`, `incrementCapacity`, `updateStateWithPrice` y el `create` suelto. El código de referencia de abajo puede necesitar ajustes de tipos al compilar.

```ts
import { and, count, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { CARGO_RESERVA, HORAS_MAX, MINUTOS_PARA_LLEGAR, TARIFA_HORA, ahoraUtc, precioPorHoras } from '../reglas';

type Db = DrizzleService['db'];
/** La conexión normal o una transacción en curso. */
type Ejecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const minutosParaLlegar = sql`make_interval(mins => ${MINUTOS_PARA_LLEGAR}::int)`;
/** Número fijo del candado del job (pg_try_advisory_xact_lock). */
const CANDADO_VENCIMIENTO = 72_100_415;

/**
 * Cancela las reservas cuyo conductor no llegó en 15 minutos (solo cobra el cargo) y
 * completa las parqueadas cuyo tiempo terminó. No toca fechas. Idempotente: con la guarda
 * en el WHERE, correrlo dos veces o a la vez que otro cambio no hace nada dos veces.
 * `filtro` lo limita a una reserva o a un vehículo.
 */
async vencer(ejecutor: Ejecutor = this.db, filtro?: SQL) {
  const canceladas = await ejecutor.update(schema.reservas)
    .set({ estado: 'cancelada', precio: CARGO_RESERVA.toFixed(2), fecha_actualizacion: ahoraUtc })
    .where(and(
      inArray(schema.reservas.estado, ['pendiente', 'activa']),
      isNull(schema.reservas.fecha_real_inicio),
      sql`${schema.reservas.fecha_creacion} <= ${ahoraUtc} - ${minutosParaLlegar}`,
      filtro,
    ))
    .returning({ id: schema.reservas.id });

  const completadas = await ejecutor.update(schema.reservas)
    .set({ estado: 'completada', fecha_actualizacion: ahoraUtc })
    .where(and(
      eq(schema.reservas.estado, 'activa'),
      isNotNull(schema.reservas.fecha_real_inicio),
      sql`${schema.reservas.fecha_fin} <= ${ahoraUtc}`,
      filtro,
    ))
    .returning({ id: schema.reservas.id });

  return { canceladas: canceladas.length, completadas: completadas.length };
}

/** Lo que corre el job. Si otra réplica ya está venciendo, no hace nada y devuelve null. */
async vencerConCandado() {
  return this.db.transaction(async (tx) => {
    const [fila] = await tx.execute<{ libre: boolean }>(
      sql`select pg_try_advisory_xact_lock(${CANDADO_VENCIMIENTO}) as libre`,
    );
    return fila?.libre ? this.vencer(tx) : null;
  });
}

/**
 * Crea la reserva solo si el vehículo es del conductor, no tiene otra en curso y la
 * zona tiene cupo, todo en una transacción. Orden de bloqueo fijo: vehículo y luego
 * zona (nadie bloquea en orden inverso, así que no hay deadlocks).
 */
async crearConCupo(input: { idConductor: string; idZona: number; placa: string; horas: number }) {
  return this.db.transaction(async (tx) => {
    // 1. El vehículo es del conductor. Bloquearlo pone en fila las reservas del mismo vehículo.
    const [vehiculo] = await tx.select({ placa: schema.vehiculos.placa })
      .from(schema.vehiculos)
      .where(and(
        eq(schema.vehiculos.placa, input.placa),
        eq(schema.vehiculos.id_conductor, input.idConductor),
      ))
      .for('update');
    if (!vehiculo) return { error: 'VEHICULO_AJENO' as const };

    // 2. Vence lo que ya debió vencer de este vehículo (el job puede no haber pasado aún).
    await this.vencer(tx, eq(schema.reservas.id_vehiculo, input.placa));

    // 3. Una reserva en curso por vehículo.
    const [enCurso] = await tx.select({ id: schema.reservas.id })
      .from(schema.reservas)
      .where(and(
        eq(schema.reservas.id_vehiculo, input.placa),
        inArray(schema.reservas.estado, ['pendiente', 'activa']),
      ))
      .limit(1);
    if (enCurso) return { error: 'VEHICULO_CON_RESERVA' as const };

    // 4. Bloquea la zona: quien llegue después espera aquí, y su conteo ya incluye esta reserva.
    const [zona] = await tx.select({ total: schema.zonasAzules.capacidad_total })
      .from(schema.zonasAzules)
      .where(eq(schema.zonasAzules.id, input.idZona))
      .for('update');
    if (!zona) return { error: 'ZONA_NO_EXISTE' as const };

    const [{ ocupados }] = await tx.select({ ocupados: count() })
      .from(schema.reservasEnCurso)
      .where(eq(schema.reservasEnCurso.id_zona, input.idZona));
    if (ocupados >= zona.total) return { error: 'ZONA_SIN_CUPO' as const };

    // 5. Crea la reserva con el reloj de la base de datos. fecha_real_inicio queda NULL hasta la llegada.
    const [reserva] = await tx.insert(schema.reservas).values({
      id_conductor: input.idConductor,
      id_zona: input.idZona,
      id_vehiculo: input.placa,
      fecha_creacion: ahoraUtc,
      fecha_fin: sql`${ahoraUtc} + make_interval(hours => ${input.horas}::int)`,
      precio: precioPorHoras(input.horas),
      estado: 'pendiente',
    }).returning();
    return { reserva };
  });
}

/** Aceptar (pendiente → activa) o cancelar, con guarda. No toca fechas. Primero vence lo vencido. */
async cambiarEstado(id: number, estado: 'activa' | 'cancelada') {
  return this.db.transaction(async (tx) => {
    const deEsta = eq(schema.reservas.id, id);
    // Así una aceptación tardía no revive una reserva que ya venció.
    await this.vencer(tx, deEsta);

    const [reserva] = estado === 'activa'
      ? await tx.update(schema.reservas)
          .set({ estado: 'activa', fecha_actualizacion: ahoraUtc })
          .where(and(deEsta, eq(schema.reservas.estado, 'pendiente')))
          .returning()
      : await tx.update(schema.reservas)
          .set({
            estado: 'cancelada',
            // Sin llegada solo se cobra el cargo de reserva; con llegada, lo reservado.
            precio: sql`case when ${schema.reservas.fecha_real_inicio} is null
                         then ${CARGO_RESERVA.toFixed(2)}::numeric else ${schema.reservas.precio} end`,
            fecha_actualizacion: ahoraUtc,
          })
          .where(and(deEsta, inArray(schema.reservas.estado, ['pendiente', 'activa'])))
          .returning();

    if (reserva) return { reserva };
    const actual = await tx.query.reservas.findFirst({ where: deEsta });
    return { actual: actual ?? null };
  });
}

/** El encargado verificó la placa: registra la llegada. La reserva sigue activa y fecha_fin no cambia. */
async confirmarLlegada(id: number) {
  return this.db.transaction(async (tx) => {
    const deEsta = eq(schema.reservas.id, id);
    await this.vencer(tx, deEsta);

    const [reserva] = await tx.update(schema.reservas)
      .set({ fecha_real_inicio: ahoraUtc, fecha_actualizacion: ahoraUtc })
      .where(and(deEsta, eq(schema.reservas.estado, 'activa'), isNull(schema.reservas.fecha_real_inicio)))
      .returning();

    if (reserva) return { reserva };
    const actual = await tx.query.reservas.findFirst({ where: deEsta });
    return { actual: actual ?? null };
  });
}

/** Suma horas a una reserva en curso del conductor, sin pasar de HORAS_MAX desde la creación. */
async extender(id: number, idConductor: string, horas: number) {
  return this.db.transaction(async (tx) => {
    const deEsta = eq(schema.reservas.id, id);
    await this.vencer(tx, deEsta);
    const extra = sql`make_interval(hours => ${horas}::int)`;

    const [reserva] = await tx.update(schema.reservas).set({
        fecha_fin: sql`${schema.reservas.fecha_fin} + ${extra}`,
        precio: sql`${schema.reservas.precio} + ${(horas * TARIFA_HORA).toFixed(2)}::numeric`,
        fecha_actualizacion: ahoraUtc,
      })
      .where(and(
        deEsta,
        eq(schema.reservas.id_conductor, idConductor),
        inArray(schema.reservas.estado, ['pendiente', 'activa']),
        sql`${schema.reservas.fecha_fin} + ${extra}
            <= ${schema.reservas.fecha_creacion} + make_interval(hours => ${HORAS_MAX}::int)`,
      ))
      .returning();

    if (reserva) return { reserva };
    const actual = await tx.query.reservas.findFirst({ where: deEsta });
    return { actual: actual ?? null };
  });
}
```

Otros cambios en el repositorio:
- **`findByUserId(userId, paginacion, soloEnCurso)`**: cuando `soloEnCurso` es true, agrega al filtro esta condición en el `items` y en el `total`:

  ```ts
  inArray(schema.reservas.id, this.db.select({ id: schema.reservasEnCurso.id }).from(schema.reservasEnCurso))
  ```

- `findById` se queda.

### 6.6 Servicio (`src/reservas/reservas.service.ts`)

Todas las respuestas de error tienen el formato `{ statusCode, error, codigo, message }`:

```ts
/** Error con `codigo`, para que la app distinga el caso además de mostrar el mensaje. */
function conflicto(codigo: string, message: string) {
  return new ConflictException({ statusCode: 409, error: 'Conflict', codigo, message });
}
// Igual para 403 (ForbiddenException), 404 (NotFoundException) y 400 (BadRequestException).
```

| `codigo` | HTTP | `message` (lo muestra la app tal cual) |
|---|---|---|
| `VEHICULO_AJENO` | 403 | El vehículo {placa} no está registrado a tu nombre. |
| `VEHICULO_CON_RESERVA` | 409 | El vehículo {placa} ya tiene una reserva en curso. |
| `ZONA_NO_EXISTE` | 404 | La zona no existe. |
| `ZONA_SIN_CUPO` | 409 | La zona ya no tiene cupos disponibles. |
| `LLEGADA_VENCIDA` | 409 | El tiempo para llegar venció y la reserva se canceló. |
| `RESERVA_NO_ACEPTADA` | 409 | Primero acepta la reserva; luego confirma la llegada. |
| `LLEGADA_YA_CONFIRMADA` | 409 | La llegada de esta reserva ya se confirmó. |
| `TRANSICION_INVALIDA` | 409 | La reserva ya está {estado}. |
| `RESERVA_TERMINADA` | 409 | La reserva ya terminó; no se puede extender. |
| `DURACION_MAXIMA` | 400 | Una reserva no puede durar más de 24 horas. |

- **`create(dto, solicitante)`**:
  - Llama a `crearConCupo({ idConductor: solicitante.sub, idZona: dto.id_zona, placa: dto.id_vehiculo.trim().toUpperCase(), horas: dto.horas })` y traduce `error` a la tabla.
  - Error de Postgres `23505` con `constraint_name = 'ux_reservas_vehiculo_en_curso'` → `VEHICULO_CON_RESERVA`. Es la red de seguridad del índice.
- **`updateState(id, estado)`** → `cambiarEstado`.
  - Sin fila → 404.
  - Si `actual` está `cancelada`, sin llegada y con `fecha_creacion + 15 min <= ahora` → `LLEGADA_VENCIDA`. Basta el reloj del servidor, porque solo elige el mensaje.
  - En cualquier otro caso → `TRANSICION_INVALIDA`.
- **`confirmarLlegada(id)`** → repositorio `confirmarLlegada`. Si no hay fila, se diagnostica con `actual`:
  - no existe → 404;
  - `pendiente` → `RESERVA_NO_ACEPTADA`;
  - `activa` con `fecha_real_inicio` → `LLEGADA_YA_CONFIRMADA`;
  - `cancelada` sin llegada y vencida → `LLEGADA_VENCIDA`;
  - en cualquier otro caso → `TRANSICION_INVALIDA`.
- **`extendReserva(id, sub, horas)`** → `extender`. Si no hay fila, se diagnostica con `actual`:
  - no existe → 404;
  - `id_conductor !== sub` → 403;
  - está `completada` o `cancelada` → `RESERVA_TERMINADA`;
  - en cualquier otro caso → `DURACION_MAXIMA`.
- **`findById(id, solicitante)`**: un CONDUCTOR solo ve sus reservas (403 si no es suya). Hoy cualquier conductor lee cualquier reserva. Reutiliza `validarDueno`.
- **`handleDbError`**: drizzle 0.45 **envuelve** los errores del driver en `DrizzleQueryError` (`node_modules/drizzle-orm/errors.js:10`), y el código de Postgres queda en `error.cause.code` y `error.cause.constraint_name`.
  - El código actual lee `error.code`, así que **hoy nunca coincide**.
  - Corrígelo con `const pg = (error as { cause?: unknown })?.cause ?? error`.
  - Mapea `23503` → 400, `23505` → 409 (`VEHICULO_CON_RESERVA` si es ese índice) y `22007` → 400.
  - Si aparece `40P01` (deadlock) o `40001`, reintenta la transacción hasta 2 veces. Con el orden de bloqueo fijo no debería ocurrir.

### 6.7 Controlador (`src/reservas/reservas.controller.ts`)
- `POST /reservas`: agrega `@Request() req: { user: Solicitante }` y llama a `create(dto, req.user)`.
- **Nuevo `POST /reservas/:id/llegada`**: roles ADMIN y CONTROLADOR, sin cuerpo, llama a `confirmarLlegada(id)` y devuelve la reserva.
- `GET /reservas/:id`: pasa `req.user`.
- `GET /reservas/user/:id`: lee `@Query('en_curso') enCurso?: string` (`'true'` o `'1'` → `soloEnCurso`).
- `PATCH /reservas/:id/extend`: pasa `dto.horas`.
- `PUT /reservas/:id/state`: pasa `dto.estado`.
- Actualiza los comentarios de cada endpoint con los códigos de error.

### 6.8 Job: nuevo `src/reservas/vencimiento.service.ts`

```ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReservasRepository } from './repositories/reservas.repository';

const apagado = process.env.JOB_VENCIMIENTO === 'off';

/**
 * Cada minuto cancela las reservas cuyo conductor no llegó en 15 minutos y completa las
 * parqueadas cuyo tiempo terminó. Los cupos NO dependen de este job (los calcula la vista
 * `reservas_en_curso` con la hora real): solo deja los estados al día. Es idempotente y,
 * con varias réplicas, corre una sola a la vez (candado en la BD).
 */
@Injectable()
export class VencimientoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VencimientoService.name);

  constructor(private readonly reservasRepository: ReservasRepository) {}

  /** Al arrancar pone al día lo que venció mientras el servicio estaba apagado. */
  onApplicationBootstrap() {
    if (!apagado) void this.vencer();
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'vencer-reservas', waitForCompletion: true, disabled: apagado })
  async vencer() {
    try {
      const resultado = await this.reservasRepository.vencerConCandado();
      if (resultado && (resultado.canceladas || resultado.completadas)) {
        this.logger.log(`Vencidas: ${resultado.canceladas} canceladas, ${resultado.completadas} completadas`);
      }
    } catch (error) {
      this.logger.error('No se pudieron vencer las reservas', error as Error);
    }
  }
}
```

### 6.9 Por qué es correcto con concurrencia
- **Mismo vehículo**:
  - `SELECT … FOR UPDATE` sobre la fila de `vehiculos` pone en fila a las transacciones.
  - Al soltar el bloqueo, la siguiente ve la reserva que ya se guardó.
  - El índice único parcial es la garantía final (23505 → 409).
- **Misma zona, último cupo**:
  - La segunda transacción espera en el `FOR UPDATE` de la zona.
  - En READ COMMITTED (el modo por defecto) cada sentencia toma una foto nueva de los datos, así que el `count` posterior incluye la reserva que la primera ya guardó. Resultado: 409 `ZONA_SIN_CUPO`.
- **Sin deadlocks**: el orden de bloqueo es siempre vehículo y luego zona. zones-service solo bloquea la zona, y el job y las transiciones solo bloquean filas de `reservas`.
- **Transiciones** (encargado contra job, o dos encargados):
  - Son un UPDATE con guarda. Postgres vuelve a evaluar el WHERE sobre la versión más reciente de la fila, así que solo uno la cambia; el otro recibe 0 filas → 409.
  - Como los cupos se calculan, no hay un "devolver cupo" que pueda duplicarse.
- **Sin huecos de cupo**: una reserva ocupa cupo desde que se crea.
  - Si se confirma la llegada antes de los 15 minutos, pasa sin pausa de "en camino" a "parqueada", y en ningún momento queda libre un cupo que otro pueda tomar.
  - Si la llegada se confirma tarde, se rechaza (`LLEGADA_VENCIDA`), porque ese cupo ya pudo darse a otro.
- **Neon pooler (modo transacción)**: solo se usan bloqueos de fila y `pg_try_advisory_xact_lock`, que es de transacción. No hay estado de sesión.

## 7. Fase 3: zones-service (`parknear-zones-service`)

- **`src/database/schema.ts`**: declara la vista `zonasConDisponibilidad = pgView('zonas_con_disponibilidad', { id, latitud, longitud, indicaciones, capacidad_total, capacidad }).existing()`, con los mismos tipos que `zonas_azules`. Declara también `reservasEnCurso` (`id`, `id_zona`), como en §6.3.
- **`src/zones/zones.service.ts`**:
  - **`search`, `findOne` y `resumen` leen de la vista**: cambia `.from(zonas_azules)` y las referencias de columnas por `zonasConDisponibilidad`.
    - `orden=disponibles` ordena por `(capacidad > 0) desc, id`.
    - `resumen` calcula `con_cupo = count(*) filter (where capacidad > 0)` y `cupos_disponibles = coalesce(sum(capacidad), 0)`.
    - La respuesta conserva la forma `{ id, latitud, longitud, indicaciones, capacidad, capacidad_total }`, ahora con `capacidad` = disponibles calculados.
  - **`create`**:
    - Inserta solo `latitud`, `longitud`, `indicaciones` y `capacidad_total`. **Ignora `capacidad`.**
    - Valida que `capacidad_total` sea un entero ≥ 0; si no, 400. Este servicio no tiene `ValidationPipe` y los DTO no tienen decoradores, así que se valida a mano en el servicio.
    - Devuelve `findOne(id)`.
  - **`update`**: arma un objeto explícito con los campos editables. Hoy hace `.set(payload)` con lo que llegue. Después:

    ```ts
    await this.drizzleService.db.transaction(async (tx) => {
      const [zona] = await tx.select({ id: zonas_azules.id }).from(zonas_azules)
        .where(eq(zonas_azules.id, id)).for('update');           // mismo bloqueo que crear reserva
      if (!zona) throw new NotFoundException('Zona no encontrada');
      if (cambios.capacidad_total !== undefined) {
        const [{ ocupados }] = await tx.select({ ocupados: count() }).from(reservasEnCurso)
          .where(eq(reservasEnCurso.id_zona, id));
        if (cambios.capacidad_total < ocupados) {
          throw new ConflictException({ statusCode: 409, error: 'Conflict', codigo: 'CAPACIDAD_MENOR_A_OCUPADOS',
            message: `La zona tiene ${ocupados} reservas en curso; la capacidad total no puede ser menor.` });
        }
      }
      if (Object.keys(cambios).length > 0) await tx.update(zonas_azules).set(cambios).where(eq(zonas_azules.id, id));
    });
    return this.findOne(id);
    ```

- **DTOs** (`dto/create-zone.dto.ts` y `dto/update-zone.dto.ts`): quita `capacidad`.
- **`entities/zone.entity.ts`**: comenta que `capacidad` son los disponibles calculados (solo lectura).

## 8. Fase 4: app (`/home/btw/code/ZoneUp-app`)

Lee la documentación de Expo v57 antes. Mantén el estilo existente: comentarios en español, alertas con `useAlerta()` y clases `zu-*`.

La pantalla del encargado **ya sigue el flujo del usuario**: con `pendiente` muestra Aceptar y Rechazar; con `activa`, la verificación de la placa y Cancelar. Lo que cambia es qué hace "confirmar llegada" y cómo se muestran las fechas.

1. **`src/api/client.ts`**: `ApiError` gana un campo opcional `codigo?: string`. En `request`, al construir el `ApiError` (cerca de la línea 169), léelo de `data.codigo` si es texto.
2. **`src/types.ts`**:
   - `Reserva.fecha_real_inicio: string | null`, con el comentario "Llegada confirmada por el encargado (placa verificada). null = aún no llega." Reemplaza el comentario actual de la línea 210.
   - `fecha_fin`: "Fin de la reserva: creación + horas reservadas (más las extensiones)".
   - `CreateReservaDto` → `{ id_zona, id_vehiculo, horas }`.
   - `UpdateReservaEstadoDto` → `{ estado: 'activa' | 'cancelada' }`.
   - Quita `capacidad` de `CreateZonaDto` y `UpdateZonaDto`.
   - Documenta `ZonaAzul.capacidad` como "disponibles, calculado por el servidor".
3. **`src/api/reservas.ts`**:
   - Comentario de cabecera: contrato nuevo, el endpoint de llegada y los códigos de error. Quita "OJO: no valida que queden cupos".
   - `ReservaResponse.fecha_real_inicio: string | null`.
   - `createReserva` manda `{ id_zona, id_vehiculo, horas }`.
   - `extendReserva(id, horas)` manda `{ horas }`.
   - `aceptarReserva` y `cancelarReserva` se quedan igual.
   - **`confirmarLlegada(id)`** → `request<ReservaResponse>(\`/reservas/${id}/llegada\`, {})`. Con cuerpo `{}`, `request` usa POST.
   - Helpers nuevos:
     - `llego(reserva)` = `fecha_real_inicio !== null`.
     - `estaEnCamino(reserva, ahora)` = (`pendiente` o `activa`) y `!llego` y `ahora < limiteLlegada`.
     - `estaParqueada(reserva, ahora)` = `activa` y `llego` y `fecha_fin > ahora`.
   - `listReservasConductor(id, { …, enCurso })` → agrega `en_curso: 'true'` a los parámetros.
4. **Ventana y duración**: van **desde `fecha_creacion`**, ya no desde `fecha_real_inicio`, que puede ser null.
   - Cambia `formatVentana(reserva.fecha_real_inicio, …)` por `formatVentana(reserva.fecha_creacion, …)` en:
     - `gestion_reservas.tsx:189`
     - `controlador/detalle_reserva.tsx:176`
     - `conductor/detalle_reserva.tsx:132`
     - `mis_reservas.tsx:149`
   - Cambia `horasEntre(reserva.fecha_real_inicio, …)` por `horasEntre(reserva.fecha_creacion, …)` en:
     - `useDetalle_reserva.ts:74`
     - `useDetalleReserva.ts:96, 108, 111`
     - `mis_reservas.tsx:131`
   - Donde haya llegada, agrega el dato "Llegó: {formatHora(fecha_real_inicio)}".
5. **`src/api/zonas.ts`**: crear y actualizar sin `capacidad`.
6. **`src/components/reservas/accionesReserva.ts`**: las cuatro acciones se quedan. Ajustes:
   - `confirmar_llegada` llama a `confirmarLlegada(reserva.id)`. Textos:
     - pregunta: "Confirmas que el vehículo frente a ti tiene la placa X. La reserva seguirá activa hasta su hora de fin."
     - éxito: "Llegada confirmada" / "La llegada de la placa X quedó registrada."
   - `rechazar` y `cancelar` antes de la llegada: añade "Se cobra solo el cargo de reserva."
7. **Encargado: `src/components/screens/controlador/detalle_reserva.tsx`**:
   - El panel "¿La placa del vehículo es X?" se muestra solo con **`activa` y `!llego`**. Hoy sale con toda `activa`, en las líneas 95-124.
     - Si el tiempo para llegar venció, en su lugar muestra "El tiempo para llegar venció; la reserva se cancelará automáticamente".
   - Con `activa` y `llego`: tarjeta "Llegó a las HH:MM · parqueado hasta HH:MM".
   - El contador de 15 minutos sale solo con `estaEnCamino`.
   - Aceptar, Rechazar y Cancelar se quedan como están.
   - `descripcionEstado`. Para `activa` depende de `llego`:
     - pendiente: "Llegó una nueva solicitud. Acéptala o recházala antes de que pasen 15 minutos."
     - activa sin llegada: "Ya la aceptaste. Falta confirmar la placa cuando llegue el vehículo."
     - activa con llegada: "Llegada confirmada. El vehículo está parqueado hasta el fin de la reserva."
     - completada: "Terminó el tiempo de la reserva. El cupo quedó libre."
     - cancelada: "Rechazada, anulada o el conductor no llegó a tiempo. El cupo quedó libre."
8. **`src/components/screens/controlador/gestion_reservas.tsx`**:
   - Con `activa` y `!llego`: botón "Verificar placa".
   - Con `activa` y `llego`: "Ver detalle" y la línea "Parqueado hasta HH:MM".
   - El contador de 15 minutos sale solo con `estaEnCamino`.
   - Ajusta `porAtender` en `useGestion_reserva.ts` y `useDetalle_reserva.ts`.
9. **Conductor: `src/components/screens/conductor/detalle_reserva.tsx`**. Nuevo `descripcionEstado`:
   - pendiente: "Esperando a que el encargado acepte tu solicitud. Tienes 15 minutos para llegar."
   - activa sin llegada: "El encargado aceptó tu reserva. Al llegar verificará la placa de tu vehículo."
   - activa con llegada: "Llegada confirmada. Tu reserva termina a las HH:MM."
   - completada: "Terminó tu reserva."
   - cancelada: "La reserva se canceló (rechazada o no llegaste a tiempo). Se cobra el cargo de reserva."
   - `ContadorLlegada` sale solo con `estaEnCamino`.
10. **`src/hooks/reservas/useDetalleReserva.ts`** (extender):
    - `extensible` = `estaEnCamino` o `estaParqueada`.
    - `nuevoFin` = `fecha_fin + horas`, sin `Math.max` con ahora.
    - `superaMaximo` = `horasEntre(fecha_creacion, nuevoFin) > HORAS_MAX`.
    - `nuevoPrecio` = `reserva.precio + horas × TARIFA_HORA`.
    - Llama a `extendReserva(reserva.id, horasExtra)`.
11. **`src/hooks/reservas/useNuevaReserva.ts` y `src/components/screens/conductor/nueva_reserva.tsx`**:
    - Carga `listReservasConductor(user.id, { enCurso: true, limit: 50 })` en vez de `{ limit: 5 }`. Con eso arma `ocupados: Map<placa, Reserva>`.
    - Los vehículos con reserva en curso salen deshabilitados, con la etiqueta "Con reserva en curso". Por defecto se elige el primer vehículo libre.
    - El aviso "Ya tienes una reserva en curso" sale solo si **todos** los vehículos están ocupados, con el texto "Todos tus vehículos tienen una reserva en curso" y un botón para ver la reserva.
    - En `guardar`:
      - Quita la revisión previa con `getZona` (líneas 147-157) y manda `horas`. Ya no se manda `id_conductor`.
      - Si el error es `ApiError.codigo === 'ZONA_SIN_CUPO'`: alerta de advertencia "La zona se quedó sin cupos" y recarga la zona.
      - Si es `VEHICULO_CON_RESERVA`: alerta de advertencia y recarga.
      - Cualquier otro: alerta de error con el `message`.
12. **`src/hooks/reservas/useMisReservas.ts` y `mis_reservas.tsx`**: `enCamino` pasa a ser **una lista**, porque puede haber una por vehículo. Se muestra un `ContadorLlegada` por cada una.
13. **Admin, zonas**:
    - `src/components/screens/admin/nueva_zona.tsx` y `src/hooks/admin/useNuevo_zona.ts`: quita el campo "Cupos disponibles" y su validación. Queda solo "Capacidad total".
    - `detalle_zona.tsx` y `useDetalle_zona.ts`: igual, más "Disponibles ahora: X de Y" de solo lectura. El 409 `CAPACIDAD_MENOR_A_OCUPADOS` muestra el `message` en una alerta.
14. **Sin cambios**: `zonas_para_reservar.tsx`, `DisponibilidadBadge.tsx` y la lista admin `zonas.tsx`. Leen `capacidad`, que ahora llega calculada.

## 9. Fase 5: pruebas

### 9.1 Entorno local

Es la receta que ya funcionó.

```bash
SP=<scratchpad de la sesión>   # carpeta para logs y scripts temporales
# Postgres 18 con el init.sql (para probar la MIGRACIÓN, monta el init.sql viejo:
#   git -C /home/btw/code/cdg show bc4f6b6:db/init.sql > $SP/init-viejo.sql)
docker rm -f zoneup-test-pg
docker run -d --name zoneup-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=parknear -p 55432:5432 \
  -v /home/btw/code/cdg/db/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro postgres:18-alpine
# base de datos de telemetría para el gateway
docker exec zoneup-test-pg psql -h 127.0.0.1 -U postgres -c "create database servicebus_db"
docker exec zoneup-test-pg psql -h 127.0.0.1 -U postgres -d servicebus_db -c "create table bus_logs (time timestamptz not null default now(), service_name varchar(50) not null, event_type varchar(50) not null, correlation_id uuid not null, payload jsonb)"

cd /home/btw/code/cdg
for s in auth users zones reservations; do (cd parknear-$s-service && npm run build); done
DB=postgres://postgres:postgres@127.0.0.1:55432/parknear
# auth 13000, users 13001, zones 13002, reservations 13004, gateway 13003
for pair in auth:13000 users:13001 zones:13002 reservations:13004; do s=${pair%%:*}; p=${pair##*:}
  (cd parknear-$s-service && PORT=$p DATABASE_URL=$DB JWT_SECRET=secretKey JWT_EXPIRES_IN=1h setsid nohup node dist/main > $SP/run-$s.log 2>&1 &)
done
(cd Parknear-serviceBus && cargo build && BIND_ADDR=127.0.0.1:13003 \
  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/servicebus_db \
  AUTH_BASE_URL=http://127.0.0.1:13000 USERS_BASE_URL=http://127.0.0.1:13001 ZONES_BASE_URL=http://127.0.0.1:13002 \
  RESERVATIONS_BASE_URL=http://127.0.0.1:13004 PAYMENTS_BASE_URL=http://127.0.0.1:13005 TICKETS_BASE_URL=http://127.0.0.1:13006 \
  RUST_LOG=warn setsid nohup ./target/debug/Parknear-serviceBus > $SP/run-gateway.log 2>&1 &)
# Para apagar: matar por puerto (lsof -ti:13004 -sTCP:LISTEN | xargs -r kill). NUNCA el 8081 del usuario.
```

- **Usuarios de prueba**:
  - Conductores: `POST /auth/register` siempre crea un conductor. Luego `POST /auth/login` devuelve `access_token`. El backend no revisa `estado` al hacer login.
  - Admin: inserta en `usuarios` y en `admin` con un hash hecho con `require('bcryptjs').hashSync('Admin12345', 10)`, ejecutado desde `parknear-users-service`.
  - Encargado: el admin hace `PATCH /users/:documento` con `{ "tipo_usuario": "controlador" }`.
- **Vehículos**: `POST /users/:documento/vehiculo` o un INSERT en `vehiculos`.
- **App contra el entorno local**: `EXPO_PUBLIC_API_URL=http://localhost:13003 npx expo start --web --port 8090`.
  - Navegador: Chromium con playwright-core, viewport 390×844.
  - El token vive en memoria: **no uses `page.goto` después del login**, navega por la interfaz.
- **Probar el job sin esperar**: atrasa las fechas con SQL. Por ejemplo, `UPDATE reservas SET fecha_creacion = fecha_creacion - interval '16 minutes' WHERE id = …`, o `fecha_fin = (now() at time zone 'utc') - interval '1 minute'`. Luego espera menos de 70 s.

### 9.2 Casos y resultado esperado

| # | Caso | Esperado |
|---|---|---|
| A | Zona con `capacidad_total=1`, 20 conductores con su vehículo y 20 `POST /reservas` **en paralelo** (repetir 5 veces). Después, con `capacidad_total=3`. | Exactamente 1 respuesta 201 y 19 respuestas 409 `ZONA_SIN_CUPO` (con 3: 3 y 17). `select count(*) from reservas_en_curso where id_zona=…` = capacidad_total. |
| B | Mismo vehículo, 2 zonas, en paralelo | 1 respuesta 201 y 1 respuesta 409 `VEHICULO_CON_RESERVA` |
| C | Mismo conductor, 2 vehículos, 2 zonas | 2 respuestas 201 |
| D | Vehículo de otro conductor / cuerpo con `id_conductor` o `fecha_fin` / `horas` 0 o 25 | 403 `VEHICULO_AJENO` / 400 / 400 |
| E | Crear: revisar las fechas | `fecha_real_inicio` NULL, `fecha_fin − fecha_creacion` = horas exactas, precio = 5000 + horas × 3500 |
| F | Aceptar → `activa` | Las fechas **no cambian** |
| G | Confirmar llegada de la activa; repetirla; confirmar la llegada de una `pendiente` | `fecha_real_inicio` ≈ ahora, sigue `activa` y `fecha_fin` sin cambio / 409 `LLEGADA_YA_CONFIRMADA` / 409 `RESERVA_NO_ACEPTADA` |
| H | Aceptar o confirmar llegada con `fecha_creacion` atrasada 16 minutos | 409 `LLEGADA_VENCIDA`, y la fila queda `cancelada` con precio 5000 |
| I | Job: pendiente atrasada 16 min; activa sin llegada atrasada 16 min; activa con llegada y `fecha_fin` en el pasado; activa con llegada y `fecha_fin` en el futuro | En menos de 60 s: `cancelada` (5000) / `cancelada` (5000) / `completada` / sin cambios. Las fechas nunca cambian. `GET /zonas/:id` muestra el cupo libre **antes** de que corra el job. |
| J | Cancelar una activa sin llegada; cancelar una activa con llegada | precio 5000 / precio sin cambio. Fechas sin cambio en los dos casos. |
| K | Rechazar y aceptar **en paralelo** sobre la misma pendiente; cancelar y confirmar llegada en paralelo | En cada par, una respuesta 200 y la otra 409 |
| L | Extender 2 h; pasar de 24 h desde la creación; extender una terminada | `fecha_fin` + 2 h y precio + 7000 / 400 `DURACION_MAXIMA` / 409 `RESERVA_TERMINADA` |
| M | Admin: bajar `capacidad_total` por debajo de las reservas en curso; mandar `capacidad` en el cuerpo; `GET /zonas`, `?orden=disponibles` y `/zonas/resumen` | 409 `CAPACIDAD_MENOR_A_OCUPADOS` / `capacidad` se ignora / disponibles = total − en curso |
| N | Un conductor hace `GET /reservas/:id` de una reserva ajena | 403 |
| O | Migración sobre datos del modelo viejo (init viejo + una fila de cada caso de §5.2 b) | Cada fila termina como describe §5.2. Correr la migración dos veces no cambia nada más (el bloque `DO` no repite la conversión). |
| P | App en Chromium: el conductor reserva y ve el contador; el encargado acepta, verifica la placa y ve "Llegó a las…"; el formulario de zonas sin "Cupos disponibles"; las alertas de cada 409 | Flujo completo sin errores en consola |

Esqueleto para el caso A. `tokens.json` es un arreglo `[{ token, placa }]` preparado antes:

```js
// node concurrencia.mjs <idZona>
import { readFileSync } from 'node:fs';
const G = 'http://127.0.0.1:13003', ZONA = Number(process.argv[2]);
const tokens = JSON.parse(readFileSync('tokens.json', 'utf8'));
const res = await Promise.all(tokens.map(({ token, placa }) =>
  fetch(`${G}/reservas`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id_zona: ZONA, id_vehiculo: placa, horas: 1 }) })
  .then(async (r) => `${r.status} ${(await r.json()).codigo ?? ''}`)));
console.table(res.reduce((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {}));
```

Después, también: `npm run build` y `npm run lint` en reservations, zones y payments (por el cambio de schema), y `npx tsc --noEmit` en la app.

## 10. Fase 6: despliegue

1. **La app y el backend se despliegan juntos**. Cambian `POST /reservas`, `PUT /reservas/:id/state`, `PATCH /reservas/:id/extend`, el nuevo `POST /reservas/:id/llegada`, `fecha_real_inicio` (ahora puede ser null) y los formularios de zona.
2. En Neon, lo hace el usuario:
   - corre el diagnóstico (§5.1);
   - aplica la migración (§5.2), que tarda segundos;
   - **inmediatamente después** despliega reservations-service, zones-service y payments-service;
   - luego publica la app.

   Entre la migración y el despliegue, el backend viejo sigue con su contador y moviendo fechas. Mantén esa ventana corta.
3. **Verificación**: `SELECT * FROM zonas_con_disponibilidad;`. En los logs de reservations deben aparecer líneas "Vencidas: …" cuando corresponda.
4. **Costo en Neon**: un job cada minuto mantiene el cómputo encendido todo el tiempo (sin scale-to-zero). El usuario lo aceptó.
   - Si hay que bajarlo, cambia `CronExpression.EVERY_MINUTE` por `EVERY_10_MINUTES`. Los cupos siguen siendo exactos gracias a la vista; solo los estados se ponen al día más tarde.
   - `JOB_VENCIMIENTO=off` lo apaga.
5. **Fase posterior**: borrar `zonas_azules.capacidad` (§5.2, notas).

## 11. Fuera de alcance (pendientes conocidos, no incluidos)

- users-service: cualquier conductor puede editar o borrar vehículos de otros (`/users/:documento/vehiculo/:placa` no revisa al dueño).
- Borrar un vehículo con una reserva en curso: la FK `ON DELETE SET NULL` deja la reserva sin vehículo, y sigue ocupando el cupo. Conviene responder 409 en ese caso.
- Borrar una zona con reservas: la FK `RESTRICT` da 23503 y hoy responde 500.
- Pagos: no hay reembolsos. Si algún día se paga por adelantado, la regla "cancelada sin llegada = 5000" implica devolver la diferencia.
- `horario_zona` no tiene endpoints, así que los encargados no están limitados a sus zonas.
- El conductor no puede cancelar su propia reserva (no hay endpoint). Si se quiere: `POST /reservas/:id/cancelar`, solo para el dueño, solo sin llegada y con precio 5000.
- Si un carro se va antes de `fecha_fin`, el encargado solo puede cancelar. Un "finalizar antes" (activa → completada, liberando el cupo) sería un endpoint aparte.
