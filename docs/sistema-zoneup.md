# ZoneUp: cómo funciona el sistema

> Describe el código tal como está en `back-parknear@bc4f6b6` (backend, `/home/btw/code/cdg`) y
> `ZoneUp-app@915a05e` (app, `/home/btw/code/ZoneUp-app`), al 2026-10-26.
>
> Los cambios ya diseñados para cupos, reservas y vencimiento están en
> [`plan-cupos-reservas.md`](plan-cupos-reservas.md). Donde algo va a cambiar, este documento lo marca con **(cambia con el plan)**.

---

## 1. Qué es ZoneUp

ZoneUp es un sistema para **reservar cupos de parqueo en las zonas azules** (estacionamiento regulado en la vía pública) de Manizales. Tiene tres tipos de usuario:

| Rol | En el código | Qué hace |
|---|---|---|
| **Conductor** | `conductor` / `CONDUCTOR` | Se registra, registra sus vehículos, busca zonas con cupo, reserva por horas, ve su historial y extiende sus reservas. |
| **Encargado de zona** | `controlador` / `CONTROLADOR` | Atiende las reservas en la calle: las acepta o rechaza, y verifica la placa del vehículo cuando llega. |
| **Administrador** | `admin` / `ADMIN` | Gestiona usuarios (crea, cambia tipo y estado) y zonas azules (crea, edita, borra, define la capacidad). |

El sistema tiene dos partes, cada una en su propio repositorio:

| Parte | Carpeta | Repositorio | Tecnología |
|---|---|---|---|
| App móvil y web | `/home/btw/code/ZoneUp-app` | `github.com/JacoboAlfaro/ZoneUp-app` | Expo + React Native (Android, iOS y web) |
| Backend | `/home/btw/code/cdg` | `github.com/CokeinsZ/back-parknear` | Gateway en Rust y microservicios NestJS (TypeScript) |

"ParkNear" es el nombre interno del backend: aparece en carpetas, paquetes y servicios. "ZoneUp" es el nombre del producto.

---

## 2. Vista general

```
                     ┌──────────────────────────────────────────┐
                     │           App ZoneUp (Expo / RN)         │
                     │  Android · iOS · Web                     │
                     │  pantallas de conductor, encargado, admin│
                     └────────────────────┬─────────────────────┘
                                          │ HTTPS + JSON
                                          │ Authorization: Bearer <JWT>
                                          ▼
                     ┌──────────────────────────────────────────┐      ┌──────────────────────────┐
                     │   Gateway "service bus" (Rust · axum)    │─────▶│ TimescaleDB              │
                     │   https://zoneup.online  (puerto 3003)   │ logs │ servicebus_db.bus_logs   │
                     └───┬───────┬───────┬────────┬───────┬─────┘      └──────────────────────────┘
               /auth     │/users │/zonas │/reservas│/pagos │/tickets
                 ▼       ▼       ▼       ▼        ▼       ▼
              ┌──────┐┌──────┐┌──────┐┌────────────┐┌────────┐┌─────────┐
              │ auth ││users ││zones ││reservations││payments││ support │  ← microservicios NestJS
              │ 3000 ││ 3001 ││ 3002 ││    3004    ││  3005  ││  3006   │
              └──┬───┘└──┬───┘└──┬───┘└─────┬──────┘└───┬────┘└─────────┘
                 └───────┴───────┴──────────┴───────────┘
                                  │ SQL (drizzle-orm + postgres-js)
                                  ▼
                     ┌──────────────────────────────────────────┐
                     │ PostgreSQL "parknear" (Neon en producción)│  ← UNA sola base de datos
                     └──────────────────────────────────────────┘     compartida por todos

   payments ⇄ Mercado Pago (API de pagos + webhook)        support: sin implementar todavía
```

Ideas clave:
- **La app solo habla con el gateway.** El gateway decide a qué microservicio va cada petición, según el comienzo de la ruta.
- **Los microservicios no se llaman entre sí.** Todos leen y escriben **la misma base de datos**. Cuando un servicio necesita datos de "otro dominio", los consulta directamente en SQL. Por ejemplo, reservations hace JOIN con `usuarios`, `vehiculos` y `zonas_azules`.
- **Nadie le pregunta a auth si un token es válido.** auth firma los tokens, y cada servicio los verifica por su cuenta con el mismo secreto (`JWT_SECRET`).
- El gateway registra cada petición en una base de datos aparte (TimescaleDB), para trazabilidad.

---

## 3. Recorrido de una petición, de punta a punta

Ejemplo: el encargado abre "Gestión de reservas" y busca "abc".

1. **App**:
   - El hook `useGestion_reserva` → `useListaPaginada` espera 500 ms a que el usuario deje de escribir.
   - Luego llama a `buscarReservas({ q: 'abc', limit: 20, offset: 0 })` (`src/api/reservas.ts`).
   - Esa función usa `request()` (`src/api/client.ts`), que arma `GET https://zoneup.online/reservas?q=abc&limit=20&offset=0` con el header `Authorization: Bearer <token>`.
   - Si llega otra búsqueda antes de que responda, la anterior se cancela con `AbortController`.
2. **Gateway**: los middlewares corren en este orden, de afuera hacia adentro (`Parknear-serviceBus/src/main.ts`).
   1. `TraceLayer`: deja el registro en la consola.
   2. **CORS**: responde los *preflight* `OPTIONS` del navegador y agrega los headers CORS a todas las respuestas.
   3. **Correlation ID**: toma `X-Correlation-ID` del request o genera un UUID, y lo pone en el request y en la respuesta.
   4. **Blacklist**: devuelve 403 si la IP está bloqueada.
   5. **Rate limit**: devuelve 429 si la IP agotó su cubeta.
   6. **Router** (`src/proxy/router.rs`):
      - Quita un prefijo `/api` si viene.
      - Elige el servicio por prefijo: `/reservas` → reservations.
      - Reenvía método, ruta, query, headers (menos los *hop-by-hop* y `Host`) y cuerpo a `RESERVATIONS_BASE_URL`.
      - Manda a la telemetría un evento `REQUEST_ROUTED`.
3. **reservations-service** (NestJS):
   1. `JwtAuthGuard` verifica la firma y la vigencia del token con `JWT_SECRET` y deja en `req.user` los datos `{ sub, email, tipo_usuario, estado }`.
   2. `RolesGuard` compara `tipo_usuario` con `@Roles('ADMIN', 'CONTROLADOR')`. Si no coincide, responde 403.
   3. Controller → service → repository. El repository consulta Postgres con drizzle: un JOIN de `reservas` con `usuarios`, `vehiculos` y `zonas_azules`, con filtro y paginación.
   4. Responde `{ items, total, limit, offset }`.
4. **Gateway**:
   - Copia el estado, los headers y el cuerpo de la respuesta, y agrega `X-Correlation-ID`.
   - Manda el evento `RESPONSE_RECEIVED`. Si el servicio no respondió, manda `UPSTREAM_ERROR` y devuelve 502.
5. **App**:
   - `request()` convierte el JSON. Si hubo error, lanza `ApiError` con el `message` del servidor y el `status`.
   - `src/api/reservas.ts` lo convierte a los tipos de la app. Por ejemplo, `precio` llega como texto y queda como número.
   - El hook actualiza la pantalla. Los errores se muestran con una alerta emergente (`useAlerta()`).

---

## 4. El gateway (`Parknear-serviceBus`, Rust)

Es un **proxy inverso** escrito con axum 0.7 y tokio. Usa reqwest como cliente HTTP y sqlx para la telemetría.

| Ruta (sin `/api`) | Servicio | Variable de entorno |
|---|---|---|
| `/health` | Lo responde el gateway: `{"status":"ok"}` | — |
| `/auth…` | auth | `AUTH_BASE_URL` |
| `/users…` | users | `USERS_BASE_URL` |
| `/zonas…` | zones | `ZONES_BASE_URL` |
| `/reservas…` | reservations | `RESERVATIONS_BASE_URL` |
| `/pagos…` | payments | `PAYMENTS_BASE_URL` |
| `/tickets…` | support | `TICKETS_BASE_URL` |
| cualquier otra | 404 | — |

Configuración (`src/config/config.rs`, leída de variables de entorno o `.env`):

| Variable | Uso | Por defecto |
|---|---|---|
| `DATABASE_URL` | TimescaleDB de telemetría | obligatoria |
| `BIND_ADDR` | Dirección y puerto de escucha | `0.0.0.0:3000`; en compose, `0.0.0.0:3003` |
| `*_BASE_URL` | Dirección de cada servicio | obligatorias |
| `*_SERVICE_NAME` | Nombre del servicio en los logs | `auth_service`, … |
| `CORS_ALLOWED_ORIGINS` | Orígenes web permitidos, separados por coma | vacío o `*` = cualquiera |
| `MAX_DB_CONNECTIONS` | Pool de la telemetría | 5 |
| `REQUEST_BODY_LIMIT_BYTES` | Tamaño máximo del cuerpo | 16 MB |
| `RUST_LOG` | Nivel de log | `info` |

Detalles:
- **CORS** (`src/middleware/cors.rs`):
  - Métodos: GET, POST, PUT, PATCH, DELETE y OPTIONS.
  - Headers permitidos: `content-type`, `authorization` y `x-correlation-id`.
  - Expone `x-correlation-id` y cachea el *preflight* 1 hora.
  - Va por fuera del rate limit, así que los 429 y 403 también llevan headers CORS.
- **Rate limit** (`src/middleware/rate_limit.rs`):
  - Usa una cubeta de tokens **por IP de conexión**: 100 de capacidad y 10 tokens por segundo.
  - Vive en memoria; cada instancia del gateway tiene la suya.
  - Ignora `X-Forwarded-For` a propósito, para que no se pueda falsificar.
- **Blacklist** (`src/middleware/blacklist.rs`): un conjunto de IPs en memoria. Hoy está vacío y no hay forma de llenarlo desde fuera: solo existen los métodos `block` y `unblock`, sin endpoint.
- **Telemetría** (`src/telemetry/`):
  - Cada evento entra a un canal de 1000 posiciones.
  - Un *worker* aparte lo inserta en `bus_logs`: una *hypertable* de TimescaleDB con columnas tiempo, servicio, tipo de evento, correlation id y payload JSON.
  - Si el canal se llena, el evento se descarta. La petición nunca espera a la telemetría.
- **Timeouts hacia los servicios**: 5 s para conectar y 30 s en total.
- **Apagado ordenado**: termina las peticiones en curso al recibir SIGTERM o Ctrl-C.

---

## 5. Autenticación, roles y usuarios

### 5.1 Tokens

1. `POST /auth/register` o `POST /auth/login` (auth-service) devuelven `{ user, access_token }`.
2. El `access_token` es un **JWT firmado con `JWT_SECRET`** (HS256, el algoritmo por defecto de `@nestjs/jwt`).
   - Vence según `JWT_EXPIRES_IN`: por defecto `1h`.
   - Contiene `{ sub: id del usuario (uuid), email, tipo_usuario, estado }`.
3. La app lo guarda **en memoria** (`src/api/client.ts`) y lo manda en cada petición. Al cerrar la app se pierde y hay que volver a entrar.
4. Cada servicio verifica el token por su cuenta:
   - `JwtStrategy` y `JwtAuthGuard` (passport-jwt) lo validan.
   - `RolesGuard` compara `tipo_usuario` sin distinguir mayúsculas.
   - Todos los servicios tienen copias propias de estos archivos.

Consecuencias:
- **El rol y el estado viajan dentro del token.** Si un admin cambia el tipo de un usuario o lo desactiva, el token viejo sigue valiendo con el rol anterior hasta que vence (máximo 1 hora). El cambio se aplica al volver a entrar.
- **Todos los servicios deben tener el mismo `JWT_SECRET`.** Si falta, usan `'secretKey'`. En producción siempre hay que definirlo.

### 5.2 Tipos de usuario: una tabla por rol

Los datos comunes viven en `usuarios`. El rol se expresa con una fila en `conductores`, `controladores` o `admin`, que comparten el mismo `id` (herencia de tabla por clase).
- **El tipo vigente** sale de unir `usuarios` con esas tablas: cuenta la fila cuyo `estado` **no** es `'eliminado'`. Si hubiera más de una, gana conductor, luego controlador, luego admin (`tipoUsuarioSql` en users y en auth).
- **Cambiar el tipo** (`PATCH /users/:documento` con `tipo_usuario`, solo admin) marca como `'eliminado'` las filas de los otros roles y activa o crea la del nuevo, todo en una transacción (`asignarTipo`).
  - No se borran filas, así que se conservan los vehículos y el historial de reservas.
  - Un admin no puede cambiar su propio tipo.

### 5.3 Estado de la cuenta

`usuarios.estado` puede ser `activo`, `no_verificado`, `inactivo` o `eliminado`.
- **Registro público** (`/auth/register`):
  - Siempre crea un **conductor**, aunque el cuerpo pida otro tipo.
  - Por defecto la cuenta queda `inactivo`.
  - La app entra de inmediato con el token que devuelve el registro.
- **Login**: el backend **no revisa el estado**. Es **la app** la que rechaza el ingreso de cuentas `inactivo` o `eliminado` (`src/api/auth.ts`), con un mensaje que pide que un admin la active.
- El admin activa, inactiva o elimina cuentas desde "Detalle del usuario".

### 5.4 Permisos de edición (users-service)

- Un conductor solo edita **su propia cuenta**, y nunca su tipo ni su estado (403).
- El admin edita a cualquiera.
- Los valores inválidos de tipo o estado dan 400.

---

## 6. Los microservicios

Todos son **NestJS 11**, con drizzle-orm 0.45 sobre postgres-js. Se conectan a la base con `DATABASE_URL` y usan `prepare: false`, que es compatible con el pooler de Neon.

Cada servicio tiene **su propia copia** de:
- `src/database/schema.ts`: solo las tablas que usa;
- los guards de auth;
- `src/common/busqueda.ts` (users, zones y reservations).

No comparten código: un cambio de esquema hay que replicarlo a mano en cada copia. La fuente de verdad del esquema es `db/init.sql`.

### 6.1 auth (`parknear-auth-service`, puerto 3000)

| Método y ruta | Acceso | Qué hace |
|---|---|---|
| `POST /auth/register` | público | Crea un conductor (contraseña con bcrypt) y devuelve `{ user, access_token }`. 409 si el correo, documento o celular ya existe. |
| `POST /auth/login` | público | Valida correo y contraseña y devuelve `{ user, access_token }`. 401 "Credenciales invalidas". |

### 6.2 users (`parknear-users-service`, puerto 3001)

Maneja usuarios y **vehículos**: los vehículos viven en este servicio.

| Método y ruta | Acceso | Qué hace |
|---|---|---|
| `POST /users` | ADMIN | Crea un usuario de cualquier tipo. |
| `GET /users?q&limit&offset` | ADMIN | Página de usuarios, los más recientes primero. `q` busca en nombre, documento y correo. |
| `GET /users/resumen` | ADMIN | `{ total, activos }` |
| `GET /users/:email` | ADMIN | Un usuario |
| `PATCH /users/:documento` | ADMIN; CONDUCTOR (solo a sí mismo) | Edita datos, contraseña, tipo y estado (§5.4). |
| `POST /users/:documento/vehiculo` | ADMIN, CONDUCTOR | Registra un vehículo (`placa`, `marca`, `color`). 409 si la placa ya existe. |
| `GET /users/:documento/vehiculos` | ADMIN, CONDUCTOR | Vehículos del conductor |
| `PATCH /users/:documento/vehiculo/:placa` | ADMIN, CONDUCTOR | Edita un vehículo |
| `DELETE /users/:documento/vehiculo/:placa` | ADMIN, CONDUCTOR | Borra un vehículo |

### 6.3 zones (`parknear-zones-service`, puerto 3002)

| Método y ruta | Acceso | Qué hace |
|---|---|---|
| `GET /zonas?q&orden&limit&offset` | **público** | Página de zonas. `q` busca en las indicaciones, o por número ("12", "#12", "zona 12"). `orden=disponibles` pone primero las que tienen cupo. |
| `GET /zonas/resumen` | público | `{ total, con_cupo, cupos_disponibles }` |
| `GET /zonas/:id` | público | Una zona |
| `POST /zonas` | ADMIN | Crea una zona (`latitud`, `longitud`, `indicaciones`, `capacidad`, `capacidad_total`). |
| `PATCH /zonas/:id` | ADMIN | Edita una zona |
| `DELETE /zonas/:id` | ADMIN | Borra una zona |

Una zona tiene dos números:
- `capacidad_total`: los cupos físicos.
- `capacidad`: los cupos disponibles. **Hoy es un contador** que reservations resta y suma, y que el admin también puede editar **(cambia con el plan: pasa a calcularse)**.

### 6.4 reservations (`parknear-reservations-service`, puerto 3004)

| Método y ruta | Acceso | Qué hace |
|---|---|---|
| `POST /reservas` | CONDUCTOR | Crea una reserva `pendiente` con `{ id_conductor, id_zona, id_vehiculo, fecha_fin }`. |
| `GET /reservas?q&estado&limit&offset` | ADMIN, CONTROLADOR | Reservas de todas las zonas, con su conductor (sin contraseña), vehículo y zona. Primero las pendientes, luego las activas. `q` busca por placa, conductor, documento, zona, "#id" o "zona N". |
| `GET /reservas/resumen` | ADMIN, CONTROLADOR | Conteo por estado |
| `GET /reservas/:id` | ADMIN, CONDUCTOR | Una reserva |
| `GET /reservas/:id/completa` | ADMIN, CONTROLADOR | `{ reserva, conductor, vehiculo, zona }` |
| `GET /reservas/user/:id?limit&offset` | ADMIN; CONDUCTOR (solo las suyas) | Historial del conductor, cada reserva con su zona |
| `GET /reservas/user/:id/resumen` | ADMIN; CONDUCTOR (solo las suyas) | Conteo por estado del conductor |
| `GET /reservas/zona/:idZona` | ADMIN, CONTROLADOR | Reservas de una zona |
| `PUT /reservas/:id/state` | ADMIN, CONTROLADOR | Cambia el estado: aceptar, rechazar, cancelar o completar. |
| `PATCH /reservas/:id/extend` | CONDUCTOR dueño | Corre `fecha_fin` y recalcula el precio. |

Precio: **$5.000 de cargo de reserva + $3.500 por hora**, calculado en el servidor. La app replica la fórmula solo para mostrar estimados.

Es el único servicio con `ValidationPipe` global (`whitelist` y `forbidNonWhitelisted`): rechaza campos que no estén en el DTO.

### 6.5 payments (`parknear-payments-service`, puerto 3005)

Integra **Mercado Pago**. Usa las variables `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_WEBHOOK_SECRET`.

| Método y ruta | Acceso | Qué hace |
|---|---|---|
| `POST /pagos` | CONDUCTOR | Cobra lo que falta de una reserva: el precio de la reserva menos los pagos aprobados. Crea un pago `pendiente`, lo procesa en Mercado Pago y guarda el resultado. |
| `GET /pagos/:idPago` | ADMIN, CONDUCTOR | Un pago |
| `GET /pagos/usuario/:idUsuario` | ADMIN, CONDUCTOR | Pagos de las reservas de un usuario |
| `POST /mercadopago/procesar-pago` | sin guard | Procesa un pago directo |
| `POST /mercadopago/notificacion` | webhook (firma HMAC-SHA256) | Mercado Pago avisa cambios. Se consulta el pago real y se actualiza la tabla `pagos`. |

**La app todavía no usa pagos.** Además, el gateway no enruta `/mercadopago…` (ver §11).

### 6.6 support (`parknear-support-service`, puerto 3006)

Es un esqueleto: solo tiene `GET /` → "Hello World!". Las tablas `solicitudes_soporte` y `mensajes_soporte` existen en la base, pero ningún servicio las usa.

### 6.7 Búsqueda y paginación (users, zones, reservations)

- Los listados **nunca devuelven la tabla completa**. El contrato es `{ items, total, limit, offset }`, con `limit` de 20 por defecto y 50 como máximo.
- La búsqueda se hace en la base de datos, sin distinguir mayúsculas ni tildes (`translate` + `lower`). Escapa `%` y `_` del texto buscado.
- Los conteos de las tarjetas de los paneles salen de endpoints `/resumen`, que también se calculan en la base.
- En la app, `useListaPaginada`:
  - busca cuando el usuario deja de escribir (500 ms);
  - cancela la búsqueda anterior si llega una nueva;
  - trae 20 elementos y ofrece "Cargar más";
  - recarga al volver a la pantalla.

---

## 7. La base de datos

Una sola base de datos PostgreSQL llamada `parknear`. En producción es **Neon** (Postgres administrado que se suspende cuando no hay uso); en local, Postgres 18 en Docker. El esquema está en `db/init.sql`, que Docker aplica solo con un volumen vacío. No hay herramienta de migraciones.

```
usuarios (id uuid PK, documento_identidad UQ, email UQ, celular UQ, nombres, contrasena, estado, fechas)
   │ 1
   ├──── 0..1 conductores (id PK/FK, puntos_fidelidad, estado)
   │              │ 1
   │              └──── N vehiculos (placa PK, id_conductor FK, marca, color)
   ├──── 0..1 controladores (id PK/FK, estado)
   ├──── 0..1 admin (id PK/FK, estado)
   └──── N solicitudes_soporte ── N mensajes_soporte            (sin uso)

zonas_azules (id serial PK, latitud, longitud, indicaciones, capacidad, capacidad_total)
   ├──── N horario_zona (id_zona, id_controlador, fecha) PK compuesta   (sin endpoints)
   └──── N reservas

reservas (id serial PK,
          id_conductor → conductores   ON DELETE RESTRICT,
          id_zona      → zonas_azules  ON DELETE RESTRICT,
          id_vehiculo  → vehiculos.placa ON DELETE SET NULL,
          fecha_real_inicio, fecha_fin, precio decimal(7,2) ≥ 0,
          estado, fecha_creacion, fecha_actualizacion)
   └──── N pagos (id_reserva FK, mp_id_transaccion, mp_payload jsonb, monto, metodo, estado, anotaciones)
```

Tipos enumerados:

| Enum | Valores |
|---|---|
| `estado_usuario` | activo, no_verificado, inactivo, eliminado |
| `estado_reserva` | pendiente, activa, cancelada, completada |
| `metodo_pago` | efectivo, mercadopago |
| `estado_pago` | pendiente, aprobado, rechazado, reembolzado *(sic)* |
| `estado_solicitud` / `tipo_solicitud` | De soporte (sin uso) |

Detalles importantes:
- Los ids de usuario son **UUID v7** (`uuidv7()` de Postgres 18, envuelto en `uuid_generate_v7()`).
- **Fechas**: las columnas son `timestamp` *sin* zona horaria y guardan la hora **UTC**. drizzle escribe `Date.toISOString()`. Para comparar con "ahora" en SQL hay que usar `now() at time zone 'utc'`.
- **Qué tablas usa cada servicio**:

  | Servicio | Tablas |
  |---|---|
  | auth | `usuarios` y las tres tablas de rol (lectura y alta) |
  | users | Las mismas, más `vehiculos` |
  | zones | `zonas_azules` |
  | reservations | `reservas` (lectura y escritura), `zonas_azules` (lectura; hoy también resta y suma `capacidad`), y `usuarios` y `vehiculos` (lectura, para los listados) |
  | payments | `pagos` y `reservas` |

---

## 8. Cómo funciona una reserva hoy

**(Todo este apartado cambia con el plan: ver [`plan-cupos-reservas.md`](plan-cupos-reservas.md) §2-§4.)**

1. **El conductor reserva** desde la app ("Reservar zona azul", luego la zona, luego el vehículo y las horas).
   - La app revisa que la zona tenga cupo y que el conductor no tenga otra reserva "en camino". Esa revisión **solo existe en la app**.
   - Luego manda `POST /reservas`.
   - El servidor crea la reserva `pendiente` con:
     - `fecha_real_inicio` = ahora;
     - `fecha_fin` = la que mandó la app, calculada con el reloj del teléfono como ahora + horas;
     - `precio` = 5000 + horas × 3500.
   - Después, **en otra sentencia y sin transacción**, resta 1 a `zonas_azules.capacidad`.
2. **El conductor tiene 15 minutos para llegar**, contados desde `fecha_creacion`. Hoy la app solo lo muestra (`ContadorLlegada`); **ningún proceso cancela automáticamente**.
3. **El encargado acepta** (`PUT /reservas/:id/state {estado:'activa'}`): el servidor reinicia `fecha_real_inicio` a "ahora" y corre `fecha_fin` conservando la duración.
4. **Llega el vehículo**: el encargado compara la placa y "confirma la llegada" → `completada`. El servidor **devuelve el cupo** (+1).
5. **Rechazar o cancelar** → `cancelada`, y devuelve el cupo (+1).
6. **Extender**: el conductor suma horas (`PATCH /reservas/:id/extend`). El precio se recalcula.

Límites conocidos de este flujo, todos resueltos en el plan:
- Puede haber sobreventa del último cupo, porque la resta no es atómica.
- El cupo se libera cuando el carro **llega**, no cuando se va.
- No hay vencimiento automático.
- `POST /reservas` confía en el `id_conductor` que manda la app.

---

## 9. La app (`ZoneUp-app`)

### 9.1 Tecnología
- **Expo + React Native**, para Android, iOS y web desde el mismo código.
  - El último commit usa **SDK 57** (RN 0.86).
  - Hay una actualización **sin commit** a SDK 58 (RN 0.88) en `package.json` y `app.json`.
  - `AGENTS.md` pide leer la documentación versionada de Expo antes de programar.
- **expo-router**: las rutas son archivos dentro de `app/`. Usa Stack y, para el conductor, Drawer.
- **Uniwind** (Tailwind 4 para RN): estilos con `className`. Los colores de la marca son *tokens* `zu-*` en `global.css` (`zu-navy` #1e3a5f, `zu-sky-*`, `zu-accent`, etc.).
- **react-hook-form** para formularios, **lucide-react-native** para íconos y **react-native-maps** para el mapa del panel del conductor (centrado en Manizales; todavía no muestra las zonas).

### 9.2 Capas del código

```
app/                         Rutas (expo-router). Archivos delgados: solo montan la pantalla.
  _layout.tsx                Proveedores (alertas, sesión) + qué rutas existen según el rol.
src/components/screens/<rol>/   Pantallas (UI) de conductor, controlador, admin, auth.
src/hooks/<área>/            Estado y lógica de cada pantalla (cargar, guardar, validar).
src/api/*.ts                 Funciones con nombre de negocio (createReserva, listZonas…):
                             arman la petición y convierten la respuesta a los tipos de la app.
src/api/client.ts            El ÚNICO lugar que usa fetch: URL base, token, errores (ApiError).
src/session/context.tsx      Quién está dentro (user) + signIn / signUp / signOut.
src/components/alerta/       Alertas emergentes propias (useAlerta), en lugar de Alert.alert.
src/types.ts, src/formato.ts Tipos compartidos y formato de pesos, fechas y horas.
```

**Cómo se protege la navegación** (`app/_layout.tsx`):
- `Stack.Protected` registra cada grupo de rutas solo si el usuario tiene el rol: `conductor/`, `controlador/` y `admin/`. Sin sesión solo existe `(auth)/`.
- `app/index.tsx` redirige a cada uno a su panel.
- Esto solo ordena la navegación. **La seguridad real está en el backend** (guards).

**A dónde apunta la app**:
- `EXPO_PUBLIC_API_URL`, en el `.env` de la app, es la URL del gateway. En producción es `https://zoneup.online`; por defecto, `http://localhost:3003`.
- Opcionalmente, `EXPO_PUBLIC_AUTH_URL`, `EXPO_PUBLIC_USERS_URL`, `EXPO_PUBLIC_ZONAS_URL` y `EXPO_PUBLIC_RESERVAS_URL` sirven para hablar con un servicio directamente, sin gateway.

### 9.3 Pantallas por rol

| Rol | Rutas (`app/…`) | Pantallas |
|---|---|---|
| Sin sesión | `(auth)/login`, `(auth)/register` | Ingreso y registro (siempre como conductor) |
| Conductor | `conductor/(panel)/…` (Drawer + Stack) | Panel con mapa · Mi perfil y editar perfil · Mis vehículos, nuevo y detalle · Reservar zona azul (lista de zonas con disponibilidad) · Nueva reserva · Mis reservas · Detalle de la reserva (cuenta regresiva y extender) |
| Encargado | `controlador/…` | Panel (conteos por estado) · Gestión de reservas (búsqueda y filtro por estado; aceptar, rechazar) · Detalle de la reserva (verificar placa, confirmar llegada, cancelar) |
| Admin | `admin/…` | Panel (conteos) · Usuarios: lista, nuevo y detalle (cambiar tipo y estado) · Zonas azules: lista, nueva y detalle (editar, borrar) |

---

## 10. Despliegue y entornos

### 10.1 Docker Compose (`/home/btw/code/cdg/docker-compose.yml`)

| Servicio | Imagen o build | Puerto interno | Notas |
|---|---|---|---|
| `postgres` | `postgres:18-alpine` | 5432 | Base local con `db/init.sql`. En producción los servicios usan Neon vía `DATABASE_URL`. |
| `timescaledb` | `timescale/timescaledb:latest-pg16` | 5432 (host 5433) | Telemetría del gateway (`Parknear-serviceBus/init.sql`) |
| `auth`, `users`, `zones`, `reservations`, `payments` | Build Node 22 (dos etapas) | 3000, 3001, 3002, 3004, 3005 | Reciben `DATABASE_URL`, `JWT_SECRET` y `JWT_EXPIRES_IN`. Tienen *healthcheck* TCP. |
| `support` | Build Node | 3006 | Esqueleto |
| `service-bus` | Build Rust (DOCKERFILE de dos etapas) | 3003 | El gateway. Arranca cuando los demás están sanos. *Healthcheck* en `/health`. |

Variables (ver `.env.example`):
- `POSTGRES_*`, `TIMESCALE_*`
- `DATABASE_URL` (Neon)
- `JWT_SECRET`, `JWT_EXPIRES_IN`
- `CORS_ALLOWED_ORIGINS`
- `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`
- los puertos

`Parknear-serviceBus/` también trae su propio `docker-compose.yml` y `docker-compose.db.yml`, para correr solo el gateway y su TimescaleDB.

### 10.2 Producción
- La app publicada llama a `https://zoneup.online`, que es el gateway.
- La base es Neon.
- Backend y app **se despliegan juntos** cuando cambia un contrato. Por ejemplo, cuando los listados pasaron de arreglos a `{ items, total }`.

### 10.3 Desarrollo local
- **Backend**: `docker compose up` en `/home/btw/code/cdg`, o cada servicio con `npm run start:dev` y el gateway con `cargo run`. La receta completa con puertos de prueba está en [`plan-cupos-reservas.md`](plan-cupos-reservas.md) §9.1.
- **App**: `npm start` en `/home/btw/code/ZoneUp-app` (Expo, puerto 8081). `EXPO_PUBLIC_API_URL` debe apuntar al gateway.
  - En un teléfono físico, usa la IP de la computadora, no `localhost`.
  - Para la web, el origen tiene que estar en `CORS_ALLOWED_ORIGINS`, o dejarlo en `*`.

---

## 11. Puntos a tener en cuenta (estado actual)

Lo que ya está resuelto en el plan aparece como **(plan)**.

1. **Cupos y reservas** **(plan)**:
   - Puede haber sobreventa del último cupo.
   - El cupo se libera cuando el carro llega.
   - No hay vencimiento automático.
   - `POST /reservas` acepta cualquier `id_conductor`.
   - Cualquier conductor puede leer cualquier reserva con `GET /reservas/:id`.
2. **Vehículos de otros**: las rutas `/users/:documento/vehiculo…` no verifican que el `documento` sea el del conductor del token. Un conductor podría registrar, editar o borrar vehículos de otro.
3. **Cambios de rol o estado** se aplican cuando vence el token (hasta 1 hora). Además, el backend no impide el login de cuentas inactivas o eliminadas; solo la app lo bloquea.
4. **El registro público acepta `estado` en el cuerpo**: una petición hecha a mano podría crear la cuenta ya `activo`.
5. **Rutas del gateway que no llegan a nada**:
   - `/tickets` apunta a `http://tickets:3006`, pero en compose el servicio se llama `support`, y además no tiene endpoints.
   - `/mercadopago/*` (incluido el webhook) no está enrutado, así que Mercado Pago no puede notificar a través del gateway.
6. **Validación desigual**: solo reservations usa `ValidationPipe`. zones acepta cualquier campo en sus DTO, y `PATCH /zonas/:id` guarda lo que llegue.
7. **Errores de base de datos**: drizzle 0.45 envuelve los errores en `DrizzleQueryError`, y el código de Postgres queda en `error.cause.code`. Los `handleDbError` que leen `error.code` nunca coinciden **(plan, para reservations)**.
8. **Código duplicado entre servicios** (`schema.ts`, guards, `busqueda.ts`): hay que mantener las copias iguales a mano.
9. **Rate limit por IP de conexión**: si el gateway queda detrás de otro proxy o balanceador, todos los usuarios comparten la misma IP y, por lo tanto, la misma cubeta (100 peticiones de golpe y 10 por segundo).
10. **Filtro de usuarios por estado**: `listUsers` de la app acepta `estado`, pero el backend no lo lee en `GET /users`. Por eso la pantalla de usuarios filtra por estado en el teléfono, solo sobre la página ya cargada.
11. **Pagos**: la app no los usa todavía y no hay reembolsos.
12. **Sesión en memoria**: al cerrar la app hay que volver a iniciar sesión. Para conservarla habría que usar `expo-secure-store`.
13. **`JWT_SECRET`**: si falta, los servicios usan `'secretKey'`. Debe definirse siempre.

---

## 12. Glosario

| Término | Significado |
|---|---|
| Zona azul | Tramo de vía con parqueo regulado. En la base: `zonas_azules`. |
| Cupo | Un puesto de parqueo de una zona. `capacidad_total` = cupos físicos; `capacidad` = disponibles. |
| Encargado / controlador | Persona que atiende la zona en la calle. Rol `controlador`. |
| Reserva en curso | Pendiente o activa que todavía ocupa un cupo (definición exacta en el plan, §4). |
| Gateway / service bus | El proxy en Rust por el que pasa toda petición de la app. |
| Correlation ID | UUID que acompaña una petición por el gateway y los logs, para rastrearla de punta a punta. |
| JWT | Token firmado que prueba quién es el usuario y qué rol tiene. Vence en 1 hora. |
| Neon | Proveedor de Postgres en la nube donde está la base de producción. |
