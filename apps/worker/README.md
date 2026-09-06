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
    source-run-status.ts     Estados finos (8) -> mapeo 1:1 al enum ampliado de packages/db (WK-22)
    source-runs-repository.ts  INSERT en `source_runs`
test/
  helpers.ts                createMigratedDb (PGlite + migraciones reales), seedOrgAndUser, seedMember
  job-queue.test.ts          Reclamo atómico, backoff+jitter, dead letter, lease, idempotencia, cancelación (WK-01/WK-10/WK-14/WK-22)
  scheduler.test.ts          Unicidad por (tipo, fuente, ventana), WK-04 (lógica secuencial en PGlite) + WK-15 (SQL emitido; concurrencia real de motor PENDIENTE, ref. B-03)
  ingest-client.test.ts      Contra un servidor HTTP real (node:http), no un mock de fetch; WK-09/WK-17/WK-20 (tabla de verdad exhaustiva 400-599)/WK-21 (407 vía undici)
  discover-tenders-handler.test.ts  A1/A2/A4 (ver docs/ACEPTACION.md); WK-03/WK-05/WK-06
  run-agent-handler.test.ts  Esqueleto de run_agent con FakeProvider; WK-08/WK-16/WK-19/WK-23
  worker-shutdown.test.ts    Cierre ordenado (SIGTERM), métricas, WK-02/WK-10/WK-14
  config.test.ts             loadConfig() con env vacío/completo/inválido
  schedule-config.test.ts    loadScheduleConfig() con WORKER_SCHEDULE_JSON válido/inválido/vacío
db-proposals/                Las 3 migraciones propuestas (0026-0028) ya están aplicadas en
                              packages/db; sus tests acompañantes ya NO son .pending/describe.skip
                              (activados en la ronda 4, WK-22) — ver docs/auditoria-1/worker-cierre.md
```

## Correcciones de la ronda 2 (auditoría adversarial)

`docs/auditoria-1/worker.md` documentó 12 hallazgos (WK-01..WK-12) sobre el
código de la ronda 1, más un hallazgo WK-13 detectado por re-verificación de
`packages/agents` (regresión de compilación por un cambio de contrato en esa
dependencia). Los 13 están corregidos en código/tests en esta ronda; 3
requerían una migración de `packages/db` fuera de mi ámbito y quedaron
documentados en su momento como **PENDIENTE esquema** en
`apps/worker/db-proposals/` (WK-04 índice único, WK-07 ampliar enum, WK-08
`worker_role`) — sus mitigaciones funcionales inmediatas SÍ estaban
aplicadas en código desde entonces. Las 3 migraciones propuestas ya se
incorporaron a `packages/db` (`0026-0028`), y la ronda 4 (WK-22/WK-23, ver
esa sección más abajo) actualizó el código de `apps/worker` para
aprovecharlas de verdad — ver las notas "Corrección ronda 2 (WK-NN)" en
cada sección de este README para el estado original, y "Correcciones de la
ronda 4" para el cierre. La columna "Estado reparación" de
`docs/auditoria-1/worker.md`, y `docs/logs/fix-worker-ronda2.log` para la
ejecución real de `typecheck`/`lint`/`test`/`test:coverage` de esa ronda
(ver `docs/logs/fix-worker-ronda4.log` para la de esta ronda).

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
  ve la fila recién insertada.
  **Nota de honestidad (WK-15, docs/auditoria-1/worker-reverificacion.md,
  cierre de WK-04 PARCIAL)**: el SQL (`pg_advisory_xact_lock` transaccional)
  es **correcto para Postgres real**; en **PGlite solo se verifica la
  lógica secuencial** (que el código toma el lock, hace el SELECT y decide
  bien "insertar" vs. "deduplicar" en el orden correcto), NO concurrencia de
  motor real — PGlite (ver `packages/db/README.md` "Límites conocidos": una
  sola conexión/proceso) serializa dos `db.transaction()` lanzados con
  `Promise.all` de punta a punta, sin intercalado alguno, así que la carrera
  que el advisory lock previene nunca llega a ocurrir en este entorno; el
  test "dos Scheduler concurrentes... 20 iteraciones" (`test/scheduler.test.ts`,
  "WK-04") pasaría idéntico sin el lock. Lo que SÍ está verificado en este
  entorno, y es una garantía real, es que `enqueue()` emite exactamente el
  SQL correcto: `test/scheduler.test.ts` ("WK-15") intercepta las sentencias
  ejecutadas dentro de la transacción y confirma que contienen
  `pg_advisory_xact_lock` con la clave estable `${kind}:${jobKey}`. La
  verificación de concurrencia de motor REAL (Postgres de verdad, con
  conexiones de sistema operativo reales compitiendo) queda **PENDIENTE**
  hasta que exista un Postgres de pruebas en CI (ver "Pendientes" más abajo,
  ref. B-03) — el índice único estructural (ver "Cancelación" abajo) SÍ
  está aplicado y probado.
- **Cancelación (corrección ronda 4, WK-22, `docs/auditoria-1/worker-cierre.md`)**:
  el enum `job_status` tiene `'cancelled'` desde `packages/db/migrations/
  0027_jobs_dedupe_and_cancelled.sql` (aplicado); `JobQueue.cancel()` ya lo
  usa directamente (antes de esta ronda seguía escribiendo `'dead'` pese a
  que el esquema ya lo soportaba — "reparación declarada, código no
  actualizado"). Distinguible de un dead-letter por reintentos agotados
  sin necesidad de leer `last_error`. Ver `test/job-queue.test.ts`
  ("JobQueue: cancelación") y `db-proposals/PROPOSAL-02-jobs-dedupe-and-cancelled.test.ts`.

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

**Mapeo de estados finos -> `status` real (corrección ronda 4, WK-22, `docs/
auditoria-1/worker-cierre.md`)**: ver `src/source-runs/source-run-status.ts`.
`packages/db/migrations/0026_widen_source_run_status.sql` ya amplió el enum
real `source_run_status` con `rate_limited`/`not_configured`/
`ingest_failed` (los 8 estados finos de este worker tienen ahora
equivalente exacto). Antes de esta ronda el esquema ya estaba ampliado pero
`toDbStatus()` seguía proyectando esos 3 valores a `'failed'` —
"reparación declarada, código no actualizado" (WK-22, ALTA). Ahora el
mapeo es 1:1: `status` en la base ES el estado fino real, no una
proyección. `evidence.fineState`/`evidence.message` se siguen escribiendo
también, por compatibilidad de lectura hacia atrás con cualquier
consumidor que ya lea de ahí — no porque `status` deje de ser la fuente de
verdad. Ver `db-proposals/PROPOSAL-01-widen-source-run-status.test.ts`
(activado, ya no `.pending`/`describe.skip`).

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
resultado de la corrida de OTRO tenant. Como defensa en profundidad
inicial: se fijaba `app.current_org_id` (vía `set_config`) y el propio
`UPDATE` filtraba explícitamente `org_id = $organizationId` además de `id`.

**Corrección ronda 4 (WK-23, `docs/auditoria-1/worker-cierre.md`, ALTA)**:
`packages/db/migrations/0028_worker_role.sql` (WK-08 esquema) ya aplicó el
rol `worker_role` dedicado. Antes de esta ronda, `updateAgentRunRow` fijaba
`app.current_org_id` pero **nunca** `app.current_user_id` ni adoptaba
`worker_role` de verdad — el día que la conexión se migrara a ese rol tal
cual estaba el código, la política RLS de `agent_runs` (`org_id =
current_org_id() and has_role(org_id, write_roles)`, packages/db/
migrations/0008) habría bloqueado hasta el `UPDATE` legítimo (falso
positivo de "otro tenant"), porque `has_role()` depende de
`current_user_id()`. `updateAgentRunRow` ahora:
1. Valida `organizationId` y `actorId` como UUID (zod) — fail-closed con
   mensaje explícito si no lo son.
2. Corre de verdad como `worker_role` (`set local role worker_role`,
   ámbito de transacción) y fija `app.current_org_id`/`app.current_user_id`
   = `actorId` (el actor REAL que originó la corrida — `RunAgentPayload.
   actorId`, ya conocido por `apps/api` al encolar el job; **no** un
   usuario de servicio genérico: `0028` no crea ninguno, y su propio
   comentario documenta que la política de organización existente ya
   cubre este caso combinada con el actor real).
3. El filtro explícito `org_id = $organizationId` se mantiene como defensa
   en profundidad adicional, redundante con RLS pero sin costo.

`rowCount === 0` sigue lanzando `AgentRunOrgMismatchError` (permanent, ver
WK-10) sin importar si la causa es "la fila es de otro tenant" o "RLS
bloqueó porque `actorId` no tiene membresía de escritura activa en esa
organización" — ambas son, desde la perspectiva de este job, la misma
condición de fallo. Ver `test/run-agent-handler.test.ts` ("WK-08"/"WK-23")
y `db-proposals/PROPOSAL-03-worker-role.test.ts`.

## Seguridad: conexión "de plataforma" para jobs/source_runs; worker_role real para agent_runs

`apps/worker` escribe en `jobs` y `source_runs` usando la conexión
"propietaria" de las migraciones (`createDbClientFromEnv`), **sin**
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
decisión de arquitectura ya compartida con el runner de migraciones.

**`agent_runs` es distinto (WK-23, ronda 4)**: `updateAgentRunRow`
(`src/handlers/run-agent.ts`) es la ÚNICA escritura de este worker sobre
una tabla de datos de tenant sensible a RLS con semántica de
autorización real (a diferencia de `jobs`/`source_runs`, que son de
plataforma). Por eso, y solo para esa operación, el worker SÍ adopta
`worker_role` de verdad (`set local role worker_role` dentro de la
transacción de la escritura) con la identidad correcta (`app.
current_org_id`/`app.current_user_id` del actor real) — ver sección
`run_agent` arriba. `jobs`/`source_runs` siguen con la conexión
propietaria (sin cambios): no tienen aislamiento por tenant real que
`worker_role` cambiaría, y migrar TODA la conexión del proceso a
`worker_role` (en vez de solo esta escritura puntual) queda fuera de
alcance de esta ronda — ver "Pendientes" abajo.

## Correcciones de la ronda 4 (corrector, WK-19..23, `docs/auditoria-1/worker-cierre.md`)

Resumen de los 5 hallazgos de la re-verificación adversarial 2 (cierre);
detalle completo en cada sección referenciada y en `docs/logs/fix-worker-ronda4.log`:

- **WK-19 (BAJA/MEDIA, borde de WK-16)**: el guard fail-closed de
  `organizationId` usaba un truthy-check (`!organizationId`), que no
  capturaba un string truthy-pero-inválido (`'  '`, solo espacios) ni un
  objeto. Ahora valida con `z.string().uuid()` — ver sección `run_agent`.
- **WK-20 (MEDIA, zona gris HTTP)**: 501 y 505-599 (96 códigos) quedaban
  sin clasificar explícitamente (ni retryable ni permanent). Ahora la
  clasificación es exhaustiva para los 200 códigos 400-599: 501/505 son
  permanentes explícitos (fallas estructurales del servidor), el resto de
  5xx es transitorio explícito. Ver `src/ingest/ingest-client.ts`
  (`isRetryableStatus`) y `test/ingest-client.test.ts` ("WK-20: tabla de
  verdad exhaustiva").
- **WK-21 (BAJA, curiosidad de plataforma)**: undici (fetch nativo de Node)
  convierte CUALQUIER HTTP 407 en un `TypeError: fetch failed` genérico
  (WHATWG fetch spec, paso de status 407 con `window='no-window'`, siempre
  el caso en Node), indistinguible a simple vista de otros fallos de red.
  Ahora se detecta por la firma específica de esa `cause` (vacía, sin
  `.code`/`.message` — a diferencia de DNS/ECONNRESET/ECONNREFUSED, que sí
  los traen) y se clasifica como error PERMANENTE de configuración de
  proxy, con mensaje explícito. Ver `isBareUndiciNetworkError` en
  `src/ingest/ingest-client.ts` y `test/ingest-client.test.ts` ("WK-21").
- **WK-22 (ALTA, "reparación declarada, código no actualizado")**: el
  esquema de las 3 propuestas (`packages/db/migrations/0026-0028`) ya
  estaba aplicado desde hace una ronda, pero 2 de 3 funciones de aplicación
  nunca se actualizaron para usarlo: `toDbStatus()` seguía proyectando 3
  estados finos a `'failed'`, y `JobQueue.cancel()` seguía escribiendo
  `'dead'` en vez de `'cancelled'`. Ambas corregidas; los 3
  `.pending.test.ts` (`describe.skip`, cuerpos vacíos) se activaron con
  contenido real (renombrados sin `.pending`, sin `.skip`) y pasan contra
  la DB migrada. Ver secciones `JobQueue`/`discover_tenders` arriba y
  `apps/worker/db-proposals/*.test.ts`.
- **WK-23 (ALTA, forward-looking, ahora cerrada de verdad)**: la RLS real
  de `worker_role` sobre `agent_runs` bloquearía incluso un `UPDATE`
  legítimo porque `updateAgentRunRow()` nunca fijaba
  `app.current_user_id`. Se definió el contrato de identidad leyendo las
  políticas REALES de `packages/db/migrations/0028_worker_role.sql` (su
  propio comentario ya documentaba la solución: la política de
  organización existente de `agent_runs`, sin cambios, se satisface
  fijando `app.current_user_id` = el actor REAL de la corrida, no un
  usuario de servicio genérico — 0028 no crea ninguno) y se adaptó el
  código a ese esquema: `updateAgentRunRow` ahora valida `organizationId`/
  `actorId` como UUID, adopta `worker_role` de verdad, y fija ambos
  `set_config`. No hizo falta ninguna `PROPOSAL-04` ni cambio de esquema —
  las políticas de 0028 YA permiten el update legítimo tal cual están. Ver
  sección `run_agent`/"Seguridad" arriba, `test/run-agent-handler.test.ts`
  y `db-proposals/PROPOSAL-03-worker-role.test.ts`.

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
- ~~**Enum `source_run_status` de `packages/db` más angosto que los 8
  estados finos de este worker**~~ **CERRADO (ronda 4, WK-22)**:
  `packages/db/migrations/0026_widen_source_run_status.sql` ya amplió el
  enum real, y `src/source-runs/source-run-status.ts` (`toDbStatus()`) ya
  usa el mapeo 1:1 — `rate_limited`/`not_configured`/`ingest_failed` se
  persisten con su propio valor en `status`, no proyectados a `'failed'`.
  `evidence.fineState` se mantiene por compatibilidad de lectura hacia
  atrás. Ver `db-proposals/PROPOSAL-01-widen-source-run-status.test.ts`
  (activado, ya no `.pending`/`describe.skip`).
- **`jobs` no tiene columna/índice único DEDICADA para idempotencia real de
  `jobKey`** (se sigue usando `payload.jobKey` + `pg_advisory_xact_lock`
  transaccional en `enqueue()`, mitigación funcional que sigue siendo
  correcta y suficiente — ver WK-04/WK-15 arriba). ~~ni estado `cancelled`
  propio (se usa `dead`)~~ **CERRADO (ronda 4, WK-22)**: el índice único
  parcial `(kind, payload->>'jobKey') WHERE status IN ('queued','running')`
  Y el valor `'cancelled'` del enum `job_status` ya están aplicados
  (`packages/db/migrations/0027_jobs_dedupe_and_cancelled.sql` +
  `0026b_resolve_duplicate_active_jobs.sql` para el "Paso 0" de datos
  preexistentes) — `JobQueue.cancel()` ya usa `'cancelled'`, distinguible de
  un dead-letter por reintentos agotados sin leer `last_error`. Lo que
  queda genuinamente pendiente, y NO se cierra con WK-22/WK-23 (está
  ligado a B-03, ver el punto siguiente): `enqueue()` sigue usando
  SELECT-luego-INSERT + advisory lock en vez de simplificarse a `INSERT ...
  ON CONFLICT DO NOTHING` (el índice único ya lo permitiría) — es
  redundante pero no incorrecto (defensa en profundidad adicional sobre el
  advisory lock), y la simplificación en sí no depende de B-03, solo no se
  hizo en esta ronda por no ser un hallazgo abierto. Ver
  `db-proposals/PROPOSAL-02-jobs-dedupe-and-cancelled.test.ts` (activado).
- **Concurrencia de sistema operativo real de `claim()`/`enqueue()`
  (advisory lock) NO probada — referencia B-03**: PGlite es una sola
  conexión/proceso (ver `packages/db/README.md`, limitación ya documentada
  ahí), así que ningún test de este paquete ejercita dos conexiones de
  sistema operativo reales compitiendo de verdad. `test/job-queue.test.ts`
  prueba el mismo invariante que protege a Postgres real (una única
  sentencia UPDATE atómica), reproduciendo el patrón de
  `packages/db/test/jobs-locking.test.ts`; `test/scheduler.test.ts` prueba
  la lógica secuencial de `enqueue()` + (WK-15) el SQL exacto que emite. Lo
  que falta, y queda explícitamente **PENDIENTE (ref. B-03)**, es repetir
  ambos escenarios contra un Postgres de pruebas real en CI (Docker/CI, no
  disponible en este entorno) con procesos de sistema operativo genuinamente
  concurrentes.
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
- ~~**`worker_role` dedicado**~~ **CERRADO para `agent_runs` (ronda 4,
  WK-23)**: ver sección Seguridad arriba — `updateAgentRunRow` ya adopta
  `worker_role` de verdad con la identidad correcta. `jobs`/`source_runs`
  siguen con la conexión propietaria a propósito (son de plataforma, sin
  aislamiento por tenant que RLS cambiaría); migrar TODA la conexión del
  proceso a `worker_role` (no solo esta escritura puntual) sigue siendo un
  endurecimiento futuro opcional, no un hallazgo abierto.

## Precisión WK-04/WK-08 PARCIAL: qué cierra esta ronda (WK-22/WK-23) y qué sigue ligado a B-03

`docs/auditoria-1/worker-cierre.md` dejó WK-04 y WK-08 como **PARCIAL**
(mitigación principal cerrada, residual documentado). Esta ronda (WK-22/
WK-23) cierra el residual de CÓDIGO de ambos; lo único que sigue abierto en
los dos es, en ambos casos, la MISMA referencia a B-03 (Postgres de pruebas
real en CI, no disponible en este entorno con PGlite de una sola conexión):

- **WK-04 (unicidad de jobs por `(kind, jobKey)`)**:
  - CERRADO por esta ronda: `cancel()` ya usa `'cancelled'` (WK-22); el
    índice único estructural ya está aplicado y probado contra una
    violación real de restricción (`23505`, PGlite SÍ aplica restricciones
    únicas reales aunque no concurrencia real).
  - Ligado a B-03, SIN cambio en esta ronda: la prueba de que el advisory
    lock serializa de verdad DOS CONEXIONES DE SISTEMA OPERATIVO reales
    compitiendo (no solo la lógica secuencial que PGlite sí puede probar)
    sigue pendiente de un Postgres de pruebas real en CI. No es algo que
    WK-22/WK-23 puedan cerrar por sí solos: ninguna corrección de código en
    `apps/worker` sustituye la necesidad de ese entorno.
- **WK-08 (defensa de `agent_runs` contra escritura cruzada de tenant)**:
  - CERRADO por esta ronda: el gap de integración específico que WK-23
    identificó (RLS real de `worker_role` + código de `updateAgentRunRow`
    nunca probados juntos, y el código no fijaba `app.current_user_id`) ya
    está cerrado — `updateAgentRunRow` adopta `worker_role` de verdad con
    la identidad del actor real, y `test/run-agent-handler.test.ts`/
    `db-proposals/PROPOSAL-03-worker-role.test.ts` prueban tanto el update
    legítimo (con actor real, membresía de escritura activa) como el
    bloqueo (sin `current_user_id`, o con un actor sin membresía en esa
    org) contra RLS real (PGlite con `SET LOCAL ROLE worker_role`, no un
    mock).
  - Ligado a B-03, SIN cambio en esta ronda: `jobs`/`source_runs` siguen
    con la conexión propietaria (decisión de arquitectura para tablas de
    plataforma, no un hallazgo abierto), y la concurrencia de sistema
    operativo real de esa conexión (igual que WK-04) sigue sin poder
    demostrarse en PGlite. Esto es INDEPENDIENTE de la identidad de
    `worker_role` (WK-23, ya cerrada): B-03 es sobre concurrencia de
    motor, WK-23 era sobre identidad/autorización — dos ejes distintos que
    esta ronda no debe confundir en la tabla de hallazgos.

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
