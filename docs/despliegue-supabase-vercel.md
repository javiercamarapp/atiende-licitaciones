# Despliegue en Supabase + Vercel (D-11)

Este documento se referencia desde `packages/db/src/driver.ts` (comentario de
`DATABASE_URL_POOL_MAX`), `docs/PROGRESO.md` y `docs/AGENTES.md` desde el
2026-09-06 pero nunca se había creado — este archivo cierra ese hueco.
Escrito el 2026-09-09 al verificar e integrar los restos del agente #131
(rama `origin/staging/am-03-am-05-d11`, commit `2fed401`) en la rama
`integracion/d11-serverless`. Describe el **estado real verificado hoy**,
no un plan aspiracional: cada afirmación de "hecho" está atada a un archivo
o comando que se puede releer/re-ejecutar; cada "pendiente" es un hueco real
del código, no una formalidad.

## 0. La decisión (contexto)

D-11 (`docs/DECISIONES.md`): Postgres gestionado en un proyecto **Supabase
nuevo** (nunca el de Likida) + despliegue en **Vercel**: frontend ya vive en
`atiende-licitaciones`; la API iría como funciones serverless en un segundo
proyecto `atiende-licitaciones-api`; el worker (hoy un proceso Node de larga
duración, ver `apps/worker/src/index.ts`) se reemplazaría por **ticks**
disparados por `pg_cron`+`pg_net` de Supabase contra un endpoint HTTP de la
API, porque Vercel Hobby solo permite crons diarios y no procesos de larga
duración. Todo estado que hoy vive en memoria de proceso de la API debe
pasar a Postgres — el motivo concreto: en serverless, dos requests
consecutivas pueden aterrizar en dos instancias de Node totalmente
distintas sin memoria compartida (ver `apps/api/test/serverless-shared-state.test.ts`).

Bloqueo relacionado: `docs/BLOQUEOS.md` B-08 ("sin backend en producción").

## 1. Qué está HECHO y verificado hoy

### 1.1 Pool de Postgres apto para Supabase (commit `e121b54`, ya en `main`)

`packages/db/src/driver.ts` (`createPgClient`/`createDbClientFromEnv`) acepta:

- `DATABASE_URL_NO_SSL=true` — única vía para desactivar TLS (solo Postgres
  local sin TLS, p. ej. `docker-compose.dev.yml`). Por defecto (sin la
  variable, o con cualquier otro valor) TLS queda **activo** con
  `rejectUnauthorized: false` — necesario porque el *transaction pooler* de
  Supabase (puerto 6543) exige TLS y presenta una cadena de CA que Node no
  trae en su almacén por defecto.
- `DATABASE_URL_POOL_MAX` (por defecto `3`, deliberadamente bajo) — en
  serverless cada instancia de función abre su propio pool; con el `max=10`
  por defecto de `pg` y decenas de instancias vivas se agotarían las
  conexiones del pooler mucho antes de su propio límite.

**Gap real, CERRADO 10-sep-2026 (auditoría de fusión con la familia
"atiende", rama `agent/audit-fix`):** ninguna de las dos variables estaba
documentada en `apps/api/.env.example`, `apps/worker/.env.example` ni
`infra/env/.env.prod.example`, y `infra/scripts/check-env-parity.mjs` no
las detectaba porque solo escaneaba `apps/api/src`, `apps/worker/src` y
`packages/mail|whatsapp/src` — no `packages/db/src`, que es donde
`driver.ts` las lee. Corregido: las tres variables ahora están documentadas
en los tres archivos, y `packages/db/src` se agregó a los `sourceDirs` de
`infra/scripts/check-env-parity.mjs` para `api`/`worker` (con
`DATABASE_URL_POOL_MAX` en `allowMissing` -- tiene default seguro).

**Bug real encontrado al cerrar el gap de arriba (no una formalidad de
documentación):** `infra/compose/docker-compose.prod.yml` (la opción de
despliegue en VPS, alternativa a Supabase+Vercel) **nunca fijaba
`DATABASE_URL_NO_SSL`** para `api`/`worker`, y su propio servicio
`postgres` (`postgres:16-alpine`, sin TLS configurado) tampoco lo soporta.
Desde que `createDbClientFromEnv` activa TLS por defecto (D-11, commit
`e121b54`, 2026-09-08 21:04) hasta hoy, `api`/`worker` habrían reventado en
su primera query real contra ese Postgres con `"The server does not support
SSL connections"` — confirmado reproduciendo el error en vivo contra un
`postgres:16-alpine` real antes de aplicar el fix. La verificación Docker
E2E de E17/S11 (`docs/BLOQUEOS.md`) es de 2026-09-07 20:31, **antes** de
`e121b54` — nunca se volvió a correr con Docker real después de ese cambio
(el hardening posterior, commit `990ed95`, se verificó explícitamente "sin
Docker en este entorno"), así que la regresión pasó inadvertida ~2 días.
Corregido fijando `DATABASE_URL_NO_SSL: "true"` en `migrate`/`api`/`worker`
de `docker-compose.prod.yml`. Se encontró además un segundo bug real
independiente al mismo tiempo (mismo mecanismo, agregar `packages/db/src` a
`check-env-parity.mjs` lo hizo visible por primera vez): `worker` tampoco
fijaba `PUBLIC_URL`/`MAIL_FROM` (los lee `apps/worker/src/config.ts` con
default seguro `https://app.atiende.mx`/`soporte@atiende.mx` para las
alertas que envía directo, `send-agent-alert.ts`) — nunca revienta, pero un
despliegue real enviaría alertas con la URL/remitente de EJEMPLO en vez del
dominio real del operador. Corregido con los mismos valores que ya usa
`api` (`WEB_DOMAIN`/`MAIL_FROM`).

**Verificación real aplicada (no solo `check-env-parity.mjs`, que ahora
pasa OK):** `docker compose -f docker-compose.prod.yml build postgres
migrate api worker` + `up -d` con un `.env` de prueba real (nunca
commiteado): `postgres` y `api` quedan `healthy`, `migrate` aplica las 84
migraciones reales y termina en 0, `worker` arranca y **consulta Postgres
real con éxito** (jobs `discover_tenders` tomados de la cola y
dead-letterizados por `NotConfiguredError` — el comportamiento honesto
esperado de B-02, no un crash), `GET /readyz` responde `{"status":"ok"}`
desde dentro del contenedor `api`. Stack bajado con `down -v` al terminar.

### 1.2 Tabla `rate_limit_buckets` (migración `packages/db/migrations/0097_rate_limit_buckets.sql`, ya en `main`)

Bucket de `@fastify/rate-limit` persistido en Postgres, con `updated_at`
indexado y una función `app.cleanup_rate_limit_buckets()` (borra filas de
más de 1 día) — RLS habilitada sin políticas (nadie con rol de aplicación
puede leerla/escribirla; solo la conexión "cruda" de migraciones/la propia
API).

**Gap real (no introducido por esta ronda, preexistente en `main`):** el
comentario de la migración dice literalmente *"`app.cleanup_rate_limit_buckets()`
la invoca `apps/worker` (`runWorkerTick`, ver `src/runtime.ts`) en cada
tick"* — **eso no existe**. No hay `apps/worker/src/runtime.ts`, no hay
`runWorkerTick`, y `grep -rn cleanup_rate_limit_buckets apps/` no encuentra
ninguna invocación. Sin esto, `rate_limit_buckets` crece sin límite en
producción (una fila por IP/ruta vista alguna vez) hasta que se resuelva
junto con el punto 2.2 de abajo (el propio endpoint de tick es el lugar
natural para llamarla).

### 1.3 Store de `@fastify/rate-limit` persistido (commit `2fed401`, integrado en esta rama)

`apps/api/src/lib/rate-limit-store.ts` implementa el contrato `Store` de
`@fastify/rate-limit` (`incr`/`child`) contra `rate_limit_buckets`, con el
mismo algoritmo de ventana que `LocalStore` (ver el propio código, muy
documentado). Registrado en `apps/api/src/app.ts` para el tier `global`
con `skipOnError: true` (si Postgres falla, esa petición NO se bloquea —
mejor perder protección de límite de tasa un instante que devolver 500 en
todas las rutas). `/healthz` y `/readyz` quedan excluidos del limitador
(`config: { rateLimit: false }`, `apps/api/src/modules/health/routes.ts`)
para que `/readyz` conserve su propio 503 explícito cuando la base cae.

**Corrección aplicada en esta integración** (no estaba en `2fed401`): la
rama del limitador `exponentialBackoff` calculaba `power(2, exponente)` sin
tope. Verificado empíricamente contra PGlite: `power(2::float8, 1024)` YA
lanza `error: value out of range: overflow` en Postgres (a diferencia de
`2 ** exponente` en JS, que ante overflow da `Infinity` silenciosamente y
`LocalStore` lo captura con `Number.isSafeInteger`). Con `skipOnError: true`
activo, ese error habría hecho que el propio backoff exponencial —cuyo
objetivo es frenar cada vez más a quien sigue excediendo el límite—
terminara **abriendo la puerta por completo** a partir de cierto volumen de
peticiones sostenidas. Se acotó el exponente a 60 antes de llamar a
`power()` (con cualquier `timeWindowMs` realista, `2^60` ya excede el techo
`Number.MAX_SAFE_INTEGER` al que se clampa el resultado, así que el
comportamiento observable no cambia — solo se evita que Postgres intente
calcular un número que de todos modos iba a descartarse). **Ningún tier de
`apps/api/src/lib/rate-limit-settings.ts` activa hoy `exponentialBackoff` ni
`continueExceeding`**, así que esta rama de código no se ejecuta en
producción tal como está configurada hoy — el fix cierra el hueco para
cuando se active, sin esperar a que alguien la active para descubrirlo.

### 1.4 Migraciones contra Postgres real: el mecanismo YA existe (aunque no con el nombre `migrate:remote`)

No hay ningún script ni alias de npm llamado `migrate:remote`. Lo que sí
existe y hace exactamente eso es `scripts/db-postgres-migrate.mjs` (escrito
para el job `db-postgres` de CI): aplica `packages/db/migrations/*.sql` una
por una contra **cualquier** Postgres real vía `DATABASE_URL`, usando
`applyMigrations` de `@atiende/db` (el mismo runner que usa la API/worker al
arrancar). Para aplicarlo contra Supabase basta:

```bash
DATABASE_URL="postgres://usuario:password@<host-pooler-supabase>:6543/postgres" \
  node scripts/db-postgres-migrate.mjs
```

Reporta explícitamente cuántas migraciones aplicó/ya estaban, y si algo
falla a la mitad, indica exactamente cuál fue la primera migración
pendiente/fallida (lee `schema_migrations`). No está aliasado como
`npm run migrate:remote` en `package.json` — trivial de añadir cuando haga
falta, pero hoy hay que invocarlo con el comando de arriba.

## 2. Qué NO existe todavía (pendiente real de D-11)

### 2.1 Entrada serverless de `apps/api` para Vercel

`apps/api/src/index.ts` sigue siendo un servidor Fastify de proceso largo
(`app.listen({ port, host: '0.0.0.0' })`). No hay ningún archivo bajo `api/`
en la raíz ni ninguna función serverless (`export default function handler`)
que exponga `buildApp()` como Vercel Function. No hay un segundo
`vercel.json`/proyecto `atiende-licitaciones-api`: el único `vercel.json`
del repo construye y sirve **solo** `apps/web` como sitio estático
(`buildCommand: npm run build --workspace apps/web`).

### 2.2 Worker por ticks vía `POST /internal/worker/tick`

Esa ruta no existe en ningún módulo de `apps/api/src/modules/`. Hoy
`apps/worker/src/index.ts` es un proceso persistente: arranca un `Worker`
(cola con polling, `setInterval`) y un `Scheduler.tick()` propio en un
`setInterval` — diseñado para correr indefinidamente, no para ejecutarse
como una sola invocación HTTP corta. Adaptarlo a "un tick, una respuesta"
implica factorizar `Scheduler.tick()` + un ciclo de `Worker` que procese un
lote acotado de jobs (no un `while(true)`) detrás de esa ruta, con
`PLATFORM_API_KEY` como autenticación (mismo patrón que
`/internal/tenders/ingest`). Ese refactor no se ha empezado.

### 2.3 `pg_cron`+`pg_net` en Supabase

Depende de 2.2 (necesita una URL real que llamar). No hay ninguna migración
ni script que configure estas extensiones — ni siquiera un borrador. El
usuario debe crear el proyecto Supabase primero (ver `docs/BLOQUEOS.md`
B-08: sin token/proyecto Supabase en esta máquina a la fecha).

### 2.4 Documentación operativa desactualizada en consecuencia

`docs/OPERACION.md` §1 todavía dice *"No hay infraestructura de despliegue
(Dockerfile, IaC, pipeline de release) commiteada en este repositorio"* —
eso ya no es exacto (`infra/compose/docker-compose.prod.yml`,
`infra/docker/*` sí existen, de la opción de despliegue en VPS evaluada
antes de decidir D-11) y tampoco cubre Supabase/Vercel. Actualizarlo queda
fuera del alcance de esta ronda (se documenta aquí para no perderlo).

## 3. Checklist para completar el despliegue (orden sugerido)

1. **Usuario:** crear el proyecto Supabase nuevo y el segundo proyecto
   Vercel (`atiende-licitaciones-api`); obtener la cadena de conexión del
   *transaction pooler* (puerto 6543) y guardarla en
   `infra/env/.env.supabase` (gitignored, ver `docs/BLOQUEOS.md` B-08).
2. Añadir `DATABASE_URL_NO_SSL`/`DATABASE_URL_POOL_MAX` a
   `apps/api/.env.example`, `apps/worker/.env.example` e
   `infra/env/.env.prod.example` (sección 1.1).
3. Aplicar migraciones remotas con `scripts/db-postgres-migrate.mjs`
   (sección 1.4) y verificar `SELECT * FROM schema_migrations` en Supabase.
4. Construir la entrada serverless de `apps/api` (sección 2.1) — investigar
   el patrón real de Vercel Functions con Fastify (no asumir compatibilidad
   directa; Fastify expone `app.server`, no un handler `(req,res)` nativo de
   Vercel sin adaptador).
5. Refactorizar el tick del worker y exponer `POST /internal/worker/tick`
   (sección 2.2), incluyendo la llamada a
   `app.cleanup_rate_limit_buckets()` (sección 1.2) en cada tick.
6. Configurar `pg_cron`+`pg_net` en el proyecto Supabase para invocar ese
   endpoint con `PLATFORM_API_KEY` (sección 2.3).
7. Configurar ambos proyectos Vercel: variables de entorno completas de
   `apps/api/.env.example` en el proyecto de la API, `VITE_API_URL` en el
   del frontend apuntando a la API real, `CORS_ORIGINS` con el dominio del
   frontend.
8. Verificar `/readyz` real contra Supabase (debe responder `{status:'ok'}`)
   antes de cortar cualquier tráfico hacia el backend anterior.

## 4. Verificación de esta ronda (gate completo, evidencia literal)

Rama `integracion/d11-serverless` creada desde `origin/main`
(`a2447e0`), con el contenido verificado de `2fed401`
(`apps/api/src/app.ts`, `apps/api/src/lib/rate-limit-store.ts`,
`apps/api/src/modules/health/routes.ts`,
`apps/api/test/serverless-shared-state.test.ts`) más el fix de la sección
1.3. `bash scripts/ci-local.sh --skip-install` (log completo en
`docs/logs/ci-local.log`):

```
apps/api:build                           OK
apps/api:lint                            OK
apps/api:test                            OK
apps/api:typecheck                       OK
apps/web:build                           OK
apps/web:lint                            OK
apps/web:test:coverage                   OK
apps/web:typecheck                       OK
apps/worker:build                        OK
apps/worker:lint                         OK
apps/worker:test:coverage                OK
apps/worker:typecheck                    OK
check-env-parity                         OK
check-secrets                            OK
check-secrets:selftest                   OK
npm audit                                OK
packages/agents:build                    OK
packages/agents:lint                     OK
packages/agents:test:coverage            OK
packages/agents:typecheck                OK
packages/db:build                        OK
packages/db:lint                         OK
packages/db:test                         OK
packages/db:typecheck                    OK
packages/expediente:build                OK
packages/expediente:lint                 OK
packages/expediente:test:coverage        OK
packages/expediente:typecheck            OK
packages/sources:build                   OK
packages/sources:lint                    OK
packages/sources:test:coverage           OK
packages/sources:typecheck               OK

ci-local.sh: TODO OK.
```

`apps/api:test`: 86 archivos / 449 pruebas, incluyendo
`test/serverless-shared-state.test.ts (2 tests)` (comparte el contador de
`/auth/login` y el estado OIDC `oauth_states`/PKCE entre dos `buildApp()`
distintos sobre la misma conexión PGlite, simulando dos instancias
serverless).

**No se reprodujo aquí** (mismo recordatorio que imprime `ci-local.sh`) el
job `db-postgres` de CI, que corre las migraciones y los ataques de RLS
contra un Postgres 16 real — ese job solo corre en GitHub Actions.

## 5. Veredicto sobre fusionar `integracion/d11-serverless`

**Seguro fusionar a `main`** el contenido de esta rama (el store de
rate-limit persistido, la exclusión de `/healthz`/`/readyz` del limitador y
la suite `serverless-shared-state.test.ts`): gate completo verde, sin
overlap con otros commits en vuelo, y con el bug real de overflow de
`power()` ya corregido y cubierto por el razonamiento de la sección 1.3
(no hay test que ejercite `exponentialBackoff` directamente porque ningún
tier lo activa hoy — ver "Pendiente" abajo).

**Esto NO significa que D-11 (Supabase + Vercel) esté listo de punta a
punta.** Sigue pendiente todo lo de la sección 2: sin eso, no hay forma de
desplegar la API+worker en Vercel/Supabase todavía — el hosting real de
producción sigue siendo el bloqueo B-08.

**Pendiente recomendado para la siguiente ronda (no bloquea este merge):**
un test que active `exponentialBackoff: true` en un tier de prueba y fuerce
más de ~1024 peticiones excediendo el límite dentro de la misma ventana,
para ejercitar en CI el tope de la sección 1.3 en vez de solo por
inspección de código.
