# @atiende/worker

Proceso Node/TS de trabajos en segundo plano de Atiende Licitaciones: cola de
jobs sobre Postgres (`jobs`), scheduler de descubrimiento por fuente,
handlers `discover_tenders` y `run_agent`, y registro explícito de salud de
fuente (`source_runs`).

## Arranque rápido

```bash
npm install
npm run -w apps/worker test        # PGlite en memoria, sin Postgres/Docker
npm run -w apps/worker typecheck
npm run -w apps/worker lint
npm run -w apps/worker dev         # arranca el worker (tsx watch)
```

No requiere Postgres ni Docker para desarrollo/tests: usa PGlite (igual que
`packages/db`/`apps/api`). Para producción, define `DATABASE_URL=postgres://...`
(ver `.env.example` y `packages/db/README.md`).

## Arquitectura

```
src/
  config.ts            Variables de entorno (WORKER_*, ver .env.example)
  logger.ts             pino, logger raíz; cada job deriva un hijo con job_id/correlation_id
  index.ts               Entrypoint: arranca DB, cola, scheduler, worker; SIGTERM/SIGINT
  queue/
    types.ts             Job, JobHandler, mapJobRow (fila cruda -> tipo de dominio)
    backoff.ts            computeBackoffDelayMs: exponencial + jitter simétrico
    job-queue.ts           JobQueue: enqueue/claim/heartbeat/complete/fail/cancel
    worker.ts              Worker: bucle de reclamo+ejecución, heartbeat, cierre ordenado
    metrics.ts             JobMetrics: contadores en memoria por estado/tipo
  scheduler/
    schedule-config.ts     SourceScheduleConfig, DEFAULT_SCHEDULES, loadScheduleConfig
    scheduler.ts            Scheduler: tick() encola discover_tenders sin duplicar por ventana
  handlers/
    discover-tenders.ts     DiscoveryJobHandler: corre un SourceConnector, escribe source_runs, ingiere
    run-agent.ts             Handler esqueleto: AgentRunner + FakeProvider/OpenAI
  ingest/
    ingest-client.ts        TenderIngestClient: POST /internal/tenders/ingest (alineado al contrato real de apps/api)
    ingest-mapper.ts        mapTenderRecordToIngestRecord: TenderRecord (@atiende/sources) -> shape de apps/api
  source-runs/
    source-run-status.ts     Estados finos (7) -> proyección al enum angosto de packages/db
    source-runs-repository.ts  INSERT en `source_runs`
test/
  helpers.ts                createMigratedDb (PGlite + migraciones reales), seedOrgAndUser
  job-queue.test.ts          Reclamo atómico, backoff+jitter (fake timers), dead letter, lease, idempotencia
  scheduler.test.ts          Unicidad por (tipo, fuente, ventana)
  ingest-client.test.ts      Contra un servidor HTTP real (node:http), no un mock de fetch
  discover-tenders-handler.test.ts  A1/A2/A4 (ver docs/ACEPTACION.md)
  run-agent-handler.test.ts  Esqueleto de run_agent con FakeProvider
  worker-shutdown.test.ts    Cierre ordenado (SIGTERM), métricas
```

### `JobQueue` (tabla `jobs`, `packages/db/migrations/0003_system_tables.sql`)

- **Reclamo atómico**: una única sentencia `UPDATE ... WHERE id = (SELECT ...
  FOR UPDATE SKIP LOCKED)` — el mismo patrón ya validado en
  `packages/db/test/jobs-locking.test.ts`. `test/job-queue.test.ts` reproduce
  ese mismo test (N workers > M jobs, ningún duplicado) contra `JobQueue`.
- **Lease + recuperación de lease expirado**: la tabla `jobs` no tiene una
  columna `lease_until` (no se agregó una migración nueva en esta ronda, ver
  "Pendientes" abajo). En su lugar, `locked_at` cumple ese rol: un job
  `running` cuyo `locked_at` es más viejo que `leaseSeconds` es reclamable de
  nuevo por otro worker (`claim()` incluye esa condición en el mismo UPDATE
  atómico). `heartbeat()` refresca `locked_at` mientras el job sigue vivo.
- **Reintentos con backoff exponencial + jitter**: `computeBackoffDelayMs`
  (`src/queue/backoff.ts`) usa jitter simétrico multiplicativo (±20% por
  defecto) alrededor del delay puro `base * factor^(attempt-1)`, acotado a
  `maxMs`. `fail()` decide entre reprogramar (`queued`, `next_run_at`
  recalculado) o `dead` (dead letter) según `attempts >= max_attempts`,
  guardando siempre `last_error`.
- **Reloj inyectable, NUNCA `now()` de SQL para comparaciones de tiempo**:
  `claim()`/`heartbeat()` comparan contra `this.now()` (JS, inyectable), no
  contra el `now()` de Postgres/PGlite. Esto es deliberado: el reloj del
  motor de base de datos es independiente del reloj de JS que
  `vi.useFakeTimers()`/`vi.setSystemTime()` interceptan, así que usar
  `now()` de SQL habría hecho imposible probar backoff/lease de forma
  determinista con fake timers (ver comentario extenso en
  `src/queue/job-queue.ts`).
- **Idempotencia por `jobKey`**: no hay columna dedicada (ver "Pendientes").
  `enqueue()` guarda la clave en `payload.jobKey` y hace lectura-luego-
  inserción: si ya existe un job `queued`/`running` con el mismo `(kind,
  jobKey)`, retorna ese job (`deduped: true`) en vez de insertar uno nuevo.
- **Cancelación**: no hay estado `cancelled` en el enum `job_status` (ver
  "Pendientes"); `cancel()` usa `dead` con `last_error` describiendo el
  motivo.

### `Worker` (bucle de ejecución)

Reclama un job a la vez, ejecuta el handler correspondiente con heartbeat
periódico, y aplica `complete()`/`fail()` según el resultado. Cada línea de
log del job lleva `job_id`/`correlation_id`/`kind`/`attempts` (pino `child`
logger, ver `src/logger.ts`).

**Cierre ordenado (SIGTERM/SIGINT, ver `src/index.ts`)**: `Worker.stop()`
deja de reclamar jobs nuevos de inmediato (incluso si estaba dormido
esperando `pollIntervalMs`, se despierta) y espera a que el job en curso
TERMINE normalmente (se completa o falla, liberando su lock por el camino
normal), hasta `WORKER_SHUTDOWN_TIMEOUT_MS`. Si el handler no respeta
`AbortSignal` y sigue corriendo pasado ese plazo, `stop()` igual resuelve
(nunca cuelga el apagado del proceso); ese job queda corriendo en segundo
plano hasta que su `Promise` se asiente por su cuenta — JS no puede forzar
la cancelación de una `Promise` en curso, así que un cierre *realmente*
limpio depende de que los handlers sean cooperativos con `signal` (el
handler `discover_tenders` sí lo es: corta el `for await` del conector y
pasa la señal a `TenderIngestClient`).

### `Scheduler` (REQ-146/REQ-150)

Encola `discover_tenders` por fuente (y por org, si aplica) sin duplicar
dentro de la misma ventana de tiempo: la clave de idempotencia del job
codifica `fuente + org + inicio de ventana` (`floor(now/intervalMs) *
intervalMs`). Llamar `tick()` muchas veces dentro de la misma ventana (p.
ej. tras un reinicio del proceso) nunca produce un segundo job mientras el
primero siga activo.

**Simplificación deliberada**: la cadencia es un intervalo en milisegundos
por fuente (`SourceScheduleConfig.intervalMs`, configurable vía
`WORKER_SCHEDULE_JSON` sin tocar código), no una expresión cron completa
(`* * * * *`). Para el alcance de esta ronda esto ya cumple REQ-146
("cadencia configurable por fuente según límites reales, no una cadencia
fija universal") y REQ-150; un parser de cron real queda como pendiente si
se necesita alinear a horarios de reloj de pared específicos en vez de
ventanas relativas al arranque del proceso.

### `discover_tenders` (`src/handlers/discover-tenders.ts`)

**Contrato `DiscoveryJobHandler`** (pedido explícitamente en esta ronda):
un `JobHandler<DiscoverTendersPayload>` que:

1. Nunca reporta éxito ("ok"/"0 nuevas") para una fuente sin
   `SourceConnector.liveVerification.verified === true` con evidencia real
   (REQ-150) — falla EXPLÍCITAMENTE con `not_configured`.
2. Registra siempre una fila en `source_runs` con estado explícito
   (REQ-147/REQ-148), incluso si el job termina en error.
3. Envía los `TenderRecord` descubiertos a `apps/api` vía
   `TenderIngestClient` — **nunca** escribe en la tabla `tenders`
   directamente (frontera de paquetes: esa tabla es de `packages/db`/
   `apps/api`, fuera del alcance de `apps/worker` en esta ronda).

**Dependencia de `packages/sources`**: ese paquete ya existía en el
filesystem al empezar esta ronda, pero **sin commitear** (`git log --
packages/sources` no devuelve nada; `git status` lo lista como
`Untracked`). Se usó tal cual está hoy (`ConnectorRegistry`,
`SourceConnector`, `classifySourceFailure`, etc.) en vez de inventar una
interfaz paralela, documentando aquí el punto de acoplamiento: si otro
agente cambia esas firmas antes de que ambos paquetes se commiteen juntos,
`npm run -w apps/worker typecheck` lo detecta de inmediato.

**Hallazgo importante (no es un bug de este worker)**: los 5 conectores
reales registrados en `buildDefaultConnectorRegistry()` (ComprasMX,
OCDS-SHCP, DOF, PDN-S6, portales estatales) tienen HOY
`liveVerification.verified === false` (ver sus propios comentarios en
`packages/sources/src/connectors/*`: reCAPTCHA sin resolver, hosts que no
resuelven por DNS, etc.). Esto significa que, mientras eso no cambie, **cada
corrida real de `discover_tenders` contra estos 5 conectores reporta
`not_configured` explícito** en `source_runs`, nunca "ok" con "0 nuevas" —
exactamente el comportamiento que exige REQ-150/REQ-148 (tolerancia cero a
declarar una integración activa sin evidencia real). El camino feliz
(ingesta real de convocatorias) se prueba en `test/discover-tenders-
handler.test.ts` con un conector fake `liveVerification.verified: true`,
para demostrar que el resto del flujo (envío HTTP, `source_runs` "ok",
cobertura) funciona en cuanto un conector real se verifique.

**Mapeo de estados finos -> enum angosto de `packages/db`**: ver
`src/source-runs/source-run-status.ts`. El enum `source_run_status` de
`packages/db/migrations/0013_source_runs.sql` es MÁS ANGOSTO
(`ok|failed|captcha|interface_changed|permission_missing|down`) que los 7
estados pedidos en esta ronda (agrega `rate_limited`/`not_configured`). No
se tocó esa migración (fuera de alcance: `packages/db`). El estado fino
real siempre se guarda en `evidence.fineState`/`evidence.message` (columna
`jsonb`, sin restricción de esquema) y se proyecta al valor más cercano en
la columna `status`, **nunca** a `ok` para un estado que no lo es.

### `run_agent` (`src/handlers/run-agent.ts`) — ESQUELETO

Ejecuta un `AgentRunner` de `packages/agents` (librería pura, sin
persistencia propia) con almacenes en memoria (`InMemoryRunStore`,
`InMemoryToolCallStore`, etc.): la corrida vive solo mientras dura el job.
Si el job trae `agentRunId`, el resultado FINAL se refleja en la fila
`agent_runs` ya existente (`packages/db/migrations/0004_agents.sql`) vía
una conexión directa a la base (ver "Seguridad" abajo).

Usa `FakeProvider` (determinista, sin red) salvo que `OPENAI_API_KEY` esté
definida, en cuyo caso usa `OpenAIResponsesProvider` real de
`packages/agents`. **Registra una sola herramienta de demostración**
(`llm_complete`: pasa un prompt al proveedor y regresa el texto) — no hay
herramientas de negocio reales (extraer bases, redactar sección de
propuesta, etc.); esas son responsabilidad de `apps/api` (dueño de la
persistencia real), siguiendo el mismo patrón de `ToolRegistry.register()`.

## Seguridad: conexión "de plataforma", sin `withTenantContext`

`apps/worker` escribe en `jobs`, `source_runs` y `agent_runs` usando la
conexión "propietaria" de las migraciones (`createDbClientFromEnv`), **sin**
`withTenantContext`/`SET LOCAL ROLE app_role` — igual que el propio runner
de migraciones de `packages/db`. Esto es intencional para un proceso de
plataforma: `jobs`/`source_runs` no tienen aislamiento por tenant real (o,
en el caso de `jobs`, el worker necesita ver jobs de TODAS las
organizaciones para poder procesarlos), y `source_runs` es explícitamente
"solo back office" (política `app.is_superadmin()`).

**Pendiente de endurecimiento** (no implementable sin tocar
`packages/db`, fuera de alcance de esta ronda): un `worker_role` dedicado
con exactamente los `GRANT` necesarios (`SELECT/UPDATE` en `jobs`,
`INSERT/SELECT` en `source_runs`, `UPDATE` en `agent_runs`) en vez de la
conexión con privilegios de propietario/migraciones.

## Pendientes / fuera de alcance de esta ronda

- **Acoplamiento a un contrato "espejo", no importado directamente**:
  `apps/api` SÍ implementó `POST /internal/tenders/ingest` durante esta
  misma ronda (`apps/api/src/modules/tenders/internal-ingest.routes.ts` +
  `schemas.ts`, también sin commitear todavía). `TenderIngestClient`
  (`src/ingest/ingest-client.ts`) y `mapTenderRecordToIngestRecord`
  (`src/ingest/ingest-mapper.ts`) se alinearon leyendo ese código real
  (mismo body `{records, organizationIds?}`, misma respuesta
  `{results, summary}`, misma cabecera `X-Platform-Api-Key`/variable
  `PLATFORM_API_KEY`). Las apps NO se importan entre sí (solo
  `packages/*`), así que ese tipo se mantiene DUPLICADO a mano en
  `TenderIngestRecord`; si `apps/api` cambia su schema de ingesta, este
  archivo debe actualizarse manualmente — `test/ingest-client.test.ts`
  ejercita el cliente contra un servidor HTTP real (`node:http`) que
  replica ese contrato, no contra el proceso real de `apps/api` (evitar esa
  dependencia cruzada evita que los tests de este paquete se vuelvan
  inestables por cambios concurrentes en `apps/api` durante esta ronda). Un
  test de integración cruzada real (worker -> proceso real de apps/api ->
  Postgres) es una buena candidata para una ronda futura una vez que ambos
  paquetes estén commiteados y sus interfaces estabilizadas.
- **Enum `source_run_status` de `packages/db` más angosto que los 7 estados
  pedidos** (`rate_limited`/`not_configured` sin equivalente exacto — ver
  arriba). Recomendación: una migración futura que amplíe el enum, tras lo
  cual `src/source-runs/source-run-status.ts` deja de necesitar la
  proyección y puede escribir el estado fino directamente en `status`.
- **`jobs` no tiene columna/índice único para idempotencia real de
  `jobKey`** ni estado `cancelled` propio (se usa `dead`). Recomendación:
  columna `job_key text` + índice único parcial `(kind, job_key) WHERE
  status IN ('queued','running')`, y agregar `'cancelled'` al enum
  `job_status`. Sin esa migración, `JobQueue.enqueue()` con `jobKey` es
  lectura-luego-inserción (no 100% atómico bajo Postgres real con múltiples
  conexiones concurrentes escribiendo el mismo `jobKey` en el mismo
  instante; en la práctica el `Scheduler` es la única fuente de `jobKey`
  hoy y corre secuencialmente, así que el riesgo real es bajo).
- **Concurrencia de sistema operativo real de `claim()`** no probada:
  PGlite es una sola conexión/proceso (ver `packages/db/README.md`,
  limitación ya documentada ahí). `test/job-queue.test.ts` prueba el mismo
  invariante que protege a Postgres real (una única sentencia UPDATE
  atómica), reproduciendo el patrón de
  `packages/db/test/jobs-locking.test.ts`, pero no la concurrencia de SO en
  sí. Pendiente contra un Postgres de pruebas real (no disponible en este
  entorno).
- **`run_agent` no persiste `tool_calls` individuales en Postgres**: usa
  `InMemoryToolCallStore`/`InMemoryRunStore` de `packages/agents` (librería
  pura sin persistencia). Persistir contra `agent_runs`/`tool_calls` reales
  paso a paso (no solo el resultado final) es responsabilidad de `apps/api`
  (dueño de esa capa de persistencia), fuera de alcance de `packages/db` en
  esta ronda.
- **Integración real con OpenAI no ejercitada**: `OpenAIResponsesProvider`
  se usa tal cual la expone `packages/agents` (que documenta lo mismo en su
  propio README); esta ronda no tuvo credenciales de producción para
  probarla contra la API real.
- **`run_agent` solo registra una herramienta de demostración**
  (`llm_complete`); no hay herramientas de negocio reales conectadas
  (extraer bases, redactar propuesta, etc.) — esas viven en `apps/api`.
- **Sin exportador Prometheus**: `JobMetrics` es un contador en memoria
  simple (`src/queue/metrics.ts`); `apps/api` ya usa `prom-client` para su
  propio `/metrics`. Exponer un endpoint equivalente en este proceso queda
  pendiente.
- **`maxConcurrentJobs` de `config.ts` no se usa todavía**: cada proceso
  `apps/worker` corre un solo `Worker` (un job a la vez); escalar
  horizontalmente hoy se hace levantando más procesos (cada uno con su
  propio `WORKER_ID`), no con concurrencia dentro del mismo proceso.
- **`worker_role` dedicado** (ver sección Seguridad arriba).

## Cómo correr con Postgres real

```bash
export DATABASE_URL=postgres://usuario:password@host:5432/basededatos
export API_BASE_URL=https://api.atiende.mx
export PLATFORM_API_KEY=<clave compartida con apps/api, mismo valor que su PLATFORM_API_KEY>
npm run -w apps/worker build
npm run -w apps/worker start
```

El worker aplica las migraciones de `packages/db` al arrancar (igual que
`apps/api`), salvo `SKIP_MIGRATIONS=true`.
