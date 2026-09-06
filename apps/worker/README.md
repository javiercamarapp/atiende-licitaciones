# @atiende/worker

Proceso Node/TS de trabajos en segundo plano de Atiende Licitaciones: cola de
jobs sobre Postgres (`jobs`), scheduler de descubrimiento por fuente,
handlers `discover_tenders` y `run_agent`, y registro explícito de salud de
fuente (`source_runs`).

## Arranque rápido

```bash
npm install
npm run -w apps/worker test        # PGlite en memoria, sin Postgres/Docker
npm run -w apps/worker test:coverage # con umbrales (líneas>=85%, ramas>=80%)
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
  job-queue.test.ts          Reclamo atómico, backoff+jitter, dead letter, lease, idempotencia, WK-01/WK-10
  scheduler.test.ts          Unicidad por (tipo, fuente, ventana), WK-04 (2 procesos concurrentes)
  ingest-client.test.ts      Contra un servidor HTTP real (node:http), no un mock de fetch; WK-09
  discover-tenders-handler.test.ts  A1/A2/A4 (ver docs/ACEPTACION.md); WK-03/WK-05/WK-06
  run-agent-handler.test.ts  Esqueleto de run_agent con FakeProvider; WK-08
  worker-shutdown.test.ts    Cierre ordenado (SIGTERM), métricas, WK-02/WK-10
  config.test.ts             loadConfig() con env vacío/completo/inválido
  schedule-config.test.ts    loadScheduleConfig() con WORKER_SCHEDULE_JSON válido/inválido/vacío
db-proposals/                Migraciones PENDIENTE esquema (fuera de mi ámbito tocar packages/db),
                              cada una con su test .pending.test.ts (it.skip) — ver docs/auditoria-1/worker.md
```

## Correcciones de la ronda 2 (auditoría adversarial)

`docs/auditoria-1/worker.md` documentó 12 hallazgos (WK-01..WK-12) sobre el
código de la ronda 1, más un hallazgo WK-13 detectado por re-verificación de
`packages/agents` (regresión de compilación por un cambio de contrato en esa
dependencia). Los 13 están corregidos en código/tests en esta ronda; 3
requieren una migración de `packages/db` fuera de mi ámbito y quedan
documentados como **PENDIENTE esquema** en `apps/worker/db-proposals/`
(WK-04 índice único, WK-07 ampliar enum, WK-08 `worker_role`) — sus
mitigaciones funcionales inmediatas SÍ están aplicadas en código. Ver las
notas "Corrección ronda 2 (WK-NN)" en cada sección de este README, la
columna "Estado reparación" de `docs/auditoria-1/worker.md`, y
`docs/logs/fix-worker-ronda2.log` para la ejecución real de
`typecheck`/`lint`/`test`/`test:coverage`.

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
  **Corrección ronda 2 (WK-01, `docs/auditoria-1/worker.md`)**: la
  recuperación de lease expirado incrementaba `attempts` sin comparar nunca
  contra `max_attempts` — el único camino que un crash REAL del proceso
  (SIGKILL/OOM) ejecuta (`fail()` solo se llama desde el `catch` manejado de
  `Worker.process()`, que un crash real nunca alcanza). Un job cuyo handler
  crasheaba repetidamente quedaba `running` para siempre. Ahora la misma
  sentencia UPDATE dead-letra directamente (`last_error`: "lease expirado
  tras N intentos") si el siguiente reclamo excedería `max_attempts`;
  `claim()` nunca entrega esa fila como "reclamada". Ver
  `test/job-queue.test.ts` ("WK-01").
- **Fencing token (corrección ronda 2, WK-02)**: no hay columna dedicada
  `lease_generation`, pero `attempts` cumple ese rol de facto (`claim()` la
  incrementa en cada reclamo, inicial o por lease expirado). Antes de esta
  ronda, `Worker.process()` descartaba el resultado booleano de
  `heartbeat()` con un `.catch()` fire-and-forget: si el lease expiraba
  mientras el worker original seguía vivo y otro worker lo reclamaba, el
  worker despojado JAMÁS se enteraba y seguía ejecutando el handler (con
  riesgo real de doble efecto secundario, p. ej. dos POST a `apps/api`) —
  confirmado con doble reclamo real por la auditoría. Ahora `heartbeat()`
  acepta un `expectedAttempts` (el `job.attempts` capturado al momento del
  `claim()` que originó ese handler); si un heartbeat detecta `false`,
  `Worker.process()` aborta el `AbortSignal` del handler y garantiza que el
  resultado NUNCA se persiste (ni `complete()` ni `fail()`). Ver
  `test/worker-shutdown.test.ts` ("WK-02").
- **Reintentos con backoff exponencial + jitter**: `computeBackoffDelayMs`
  (`src/queue/backoff.ts`) usa jitter simétrico multiplicativo (±20% por
  defecto) alrededor del delay puro `base * factor^(attempt-1)`, acotado a
  `maxMs`. `fail()` decide entre reprogramar (`queued`, `next_run_at`
  recalculado) o `dead` (dead letter) según `attempts >= max_attempts`,
  guardando siempre `last_error`.
- **Errores permanentes (corrección ronda 2, WK-10)**: un error marcado
  `permanent: true` (fuente no configurada/no verificada, un 4xx de
  `apps/api` salvo 429, un `ZodError` — ver `src/queue/errors.ts`
  `isPermanentJobError`) no pasa por el ciclo de backoff de `fail()`: se
  dead-letra de inmediato con `JobQueue.deadLetterPermanent()`, en el primer
  intento. Antes, un `NotConfiguredError` se reprogramaba con backoff
  exponencial como cualquier error transitorio, gastando capacidad de
  worker en reintentos que nunca cambiarían el resultado.
- **Reloj inyectable, NUNCA `now()` de SQL para comparaciones de tiempo**:
  `claim()`/`heartbeat()` comparan contra `this.now()` (JS, inyectable), no
  contra el `now()` de Postgres/PGlite. Esto es deliberado: el reloj del
  motor de base de datos es independiente del reloj de JS que
  `vi.useFakeTimers()`/`vi.setSystemTime()` interceptan, así que usar
  `now()` de SQL habría hecho imposible probar backoff/lease de forma
  determinista con fake timers (ver comentario extenso en
  `src/queue/job-queue.ts`).
- **Idempotencia por `jobKey`**: no hay columna dedicada (ver "Pendientes").
  `enqueue()` guarda la clave en `payload.jobKey`. **Corrección ronda 2
  (WK-04)**: antes hacía lectura-luego-inserción SIN lock — dos procesos
  concurrentes (dos `Scheduler` de dos procesos `apps/worker`, el propio
  modo de escalado horizontal recomendado abajo) podían ver "no existe
  todavía" al mismo tiempo y ambos insertar, duplicando el job (confirmado
  5/5 por la auditoría). Ahora serializa el SELECT-luego-INSERT de una
  misma `(kind, jobKey)` con `pg_advisory_xact_lock` dentro de una
  transacción: un segundo proceso con la misma clave se bloquea hasta que
  el primero haga COMMIT/ROLLBACK, momento en el cual su propio SELECT ya
  ve la fila recién insertada. Verificado con 2 `Scheduler` concurrentes x
  20 iteraciones sin duplicados (`test/scheduler.test.ts`, "WK-04"). El
  índice único parcial sigue siendo la solución estructural definitiva,
  propuesta en `db-proposals/PROPOSAL-02-jobs-dedupe-and-cancelled.sql`
  (PENDIENTE esquema).
- **Cancelación**: no hay estado `cancelled` en el enum `job_status` (ver
  "Pendientes"); `cancel()` usa `dead` con `last_error` describiendo el
  motivo. Migración propuesta en
  `db-proposals/PROPOSAL-02-jobs-dedupe-and-cancelled.sql` (PENDIENTE
  esquema).

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
   (REQ-147/REQ-148), incluso si el job termina en error. **Corrección
   ronda 2 (WK-03, `docs/auditoria-1/worker.md`)**: antes de esta ronda,
   si `ingestClient.ingest()` fallaba DESPUÉS de un `discover()` exitoso,
   la excepción se propagaba sin registrar NINGUNA fila (confirmado
   empíricamente: `0` filas tras una ingesta fallida con datos ya
   descubiertos) — violaba este mismo contrato. Ahora ese caso también
   registra un estado fino explícito `ingest_failed` (distinto de un
   fallo de la fuente: aquí la fuente sí respondió, lo que falló fue la
   entrega a `apps/api`) con el conteo de registros descubiertos pero no
   ingeridos. Ver `test/discover-tenders-handler.test.ts` ("WK-03").
3. Envía los `TenderRecord` descubiertos a `apps/api` vía
   `TenderIngestClient` — **nunca** escribe en la tabla `tenders`
   directamente (frontera de paquetes: esa tabla es de `packages/db`/
   `apps/api`, fuera del alcance de `apps/worker` en esta ronda).

**Cobertura honesta (correcciones ronda 2, WK-05/WK-06)**: `coverage.obtained`
solo cuenta registros efectivamente enviados/persistidos, nunca extracción
parcial descartada por un fallo (antes, un fallo de `discover()` a mitad de
iteración reportaba "obtenido: N>0" con registros que nunca llegaron a
ningún lado — el conteo descartado ahora vive aparte, en
`coverage.discardedAfterDiscoverFailure`). `coverage.expected` viene de
`payload.expectedTotal` cuando el llamador lo conoce, o queda `null` CON un
`coverage.expectedReason` explícito (antes era SIEMPRE `null` sin ninguna
explicación).

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
(`ok|failed|captcha|interface_changed|permission_missing|down`) que los 8
estados finos de este worker (agrega `rate_limited`/`not_configured`/
`ingest_failed`, este último nuevo en la ronda 2 para WK-03). No se tocó
esa migración (fuera de alcance: `packages/db`). El estado fino real
siempre se guarda en `evidence.fineState`/`evidence.message` (columna
`jsonb`, sin restricción de esquema) y se proyecta al valor más cercano en
la columna `status`, **nunca** a `ok` para un estado que no lo es. **WK-07
(`docs/auditoria-1/worker.md`)**: cualquier consumidor futuro que filtre
por `status = 'failed'` sin inspeccionar `evidence.fineState` pierde la
distinción entre "nunca verificado"/"limitado por tasa"/"ingesta falló".
Migración propuesta (amplía el enum a los 8 estados finos) en
`db-proposals/PROPOSAL-01-widen-source-run-status.sql` (PENDIENTE
esquema).

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
(`llm_complete`: pasa un prompt al proveedor y regresa el texto,
`declaredEffects: ['read_only']` — obligatorio desde `packages/agents`
commit `480d183`/AG-05, ver WK-13 en `docs/auditoria-1/worker.md`) — no hay
herramientas de negocio reales (extraer bases, redactar sección de
propuesta, etc.); esas son responsabilidad de `apps/api` (dueño de la
persistencia real), siguiendo el mismo patrón de `ToolRegistry.register()`.

**Corrección ronda 2 (WK-08, `docs/auditoria-1/worker.md`)**: `updateAgentRunRow`
hacía `UPDATE agent_runs SET ... WHERE id = $1` SIN verificar que
`job.payload.organizationId` coincidiera con el `org_id` real de esa fila.
Con la conexión sin RLS de este worker (ver "Seguridad" abajo), un job
`run_agent` con `agentRunId`/`organizationId` inconsistentes (bug/dato
corrupto en quien encola el job) podía sobrescribir en silencio el
resultado de la corrida de OTRO tenant. Ahora, como defensa en profundidad:
se fija `app.current_org_id` (vía `set_config`) y el propio `UPDATE` filtra
explícitamente `org_id = $organizationId` además de `id`; si no coincide,
no toca ninguna fila y lanza `AgentRunOrgMismatchError` (marcado
`permanent`, ver WK-10) en vez de un no-op silencioso. Ver
`test/run-agent-handler.test.ts` ("WK-08").

## Seguridad: conexión "de plataforma", sin `withTenantContext`

`apps/worker` escribe en `jobs`, `source_runs` y `agent_runs` usando la
conexión "propietaria" de las migraciones (`createDbClientFromEnv`), **sin**
`withTenantContext`/`SET LOCAL ROLE app_role` — igual que el propio runner
de migraciones de `packages/db`. Esto es intencional para un proceso de
plataforma: `jobs`/`source_runs` no tienen aislamiento por tenant real (o,
en el caso de `jobs`, el worker necesita ver jobs de TODAS las
organizaciones para poder procesarlos), y `source_runs` es explícitamente
"solo back office" (política `app.is_superadmin()`).

**Corrección de precisión (WK-08, `docs/auditoria-1/worker.md`)**: el
párrafo anterior subestimaba el alcance real. `packages/db/migrations/
0007_rls_functions.sql` documenta que el rol propietario/migraciones NO
tiene `FORCE ROW LEVEL SECURITY` aplicada — es decir, con esta conexión el
worker puede leer/escribir SIN RLS **cualquier tabla del esquema, de
cualquier tenant**, no solo `jobs`/`source_runs`/`agent_runs`. Es una
decisión de arquitectura ya compartida con el runner de migraciones (no
exclusiva de este worker), pero el alcance real es más amplio del que
sugería este README. Mitigación de defensa en profundidad ya aplicada en
código: ver "WK-08" en la sección `run_agent` arriba.

**Pendiente de endurecimiento** (no implementable sin tocar
`packages/db`, fuera de alcance de esta ronda): un `worker_role` dedicado
con exactamente los `GRANT` necesarios (`SELECT/UPDATE` en `jobs`,
`INSERT/SELECT` en `source_runs`, `UPDATE` en `agent_runs`) en vez de la
conexión con privilegios de propietario/migraciones, heredando `app_role`
para que `agent_runs` quede bajo RLS real. Migración propuesta en
`db-proposals/PROPOSAL-03-worker-role.sql` (PENDIENTE esquema).

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
- **Enum `source_run_status` de `packages/db` más angosto que los 8 estados
  finos de este worker** (`rate_limited`/`not_configured`/`ingest_failed`
  sin equivalente exacto — ver arriba, WK-07). Migración propuesta en
  `db-proposals/PROPOSAL-01-widen-source-run-status.sql` (PENDIENTE
  esquema), tras la cual `src/source-runs/source-run-status.ts` deja de
  necesitar la proyección y puede escribir el estado fino directamente en
  `status`.
- **`jobs` no tiene columna/índice único para idempotencia real de
  `jobKey`** ni estado `cancelled` propio (se usa `dead`). Mitigación
  funcional YA aplicada sin migración (WK-04, ver arriba): `enqueue()`
  serializa con `pg_advisory_xact_lock` transaccional, verificado con 2
  procesos concurrentes x 20 iteraciones sin duplicados. El índice único
  parcial `(kind, payload->>'jobKey') WHERE status IN ('queued','running')`
  + `'cancelled'` en el enum `job_status` siguen siendo la solución
  estructural definitiva, propuestos en
  `db-proposals/PROPOSAL-02-jobs-dedupe-and-cancelled.sql` (PENDIENTE
  esquema).
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
