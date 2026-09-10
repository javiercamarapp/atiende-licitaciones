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
    discover-tenders.ts     DiscoveryJobHandler: corre un SourceConnector, escribe source_runs, ingiere;
                             Ronda 6: encola run_agent por evento de ingesta (agentEventsQueue)
    run-agent.ts             Ejecuta AgentRunner con las 8 herramientas de negocio + 5 agentes nombrados
                             (Ronda 6, ver sección dedicada abajo); FakeProvider/OpenAI
    send-agent-alert.ts      Ronda 6: handler del job `send_agent_alert` (log estructurado, sin canal real)
    mail-retry.ts            REQ-188/S7: handler del job `mail_retry` (reintento diferido de correo transaccional,
                             ver sección dedicada abajo)
  mail/                      REQ-188: piezas de @atiende/mail reimplementadas para apps/worker (ver sección dedicada)
    pg-mail-stores.ts         PgMailOutboxStore/PgMailSuppressionStore sobre mail_outbox/mail_suppressions reales
    build-mail-service.ts     buildMailServiceForWorker: MailService equivalente al de apps/api, sin linkSigner
  agents/                    Ronda 6: agentes de negocio reales (ver sección dedicada abajo)
    business-tools.ts         Las 8 ToolDefinition reales (ToolRegistry pública de @atiende/agents)
    named-agents.ts            Los 5 planes fijos de tool_calls (analista_convocatorias, analista_bases,
                                redactor_borrador, vigilante_cambios, recordatorios)
    db-context.ts               withWorkerBusinessReadContext/withWorkerPlatformReadContext/
                                 withWorkerAgentRunsInsertContext + SchemaGrantPendingError
    enqueue-agent-run.ts         Encola run_agent por evento, deduplicado, con fallback fail-open
    kill-switch.ts               WORKER_DISABLED_AGENTS: kill-switch por agente
    system-actor.ts              SYSTEM_ACTOR_ID/ROLE para corridas autónomas disparadas por evento
  scheduler/
    schedule-config.ts     SourceScheduleConfig, DEFAULT_SCHEDULES, loadScheduleConfig
    scheduler.ts            Scheduler: tick() encola discover_tenders sin duplicar por ventana
    deadline-reminders.ts   Ronda 6: enqueueUpcomingDeadlineReminders — recordatorios por vencimiento próximo
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
  discover-tenders-agent-events.test.ts  Ronda 6: run_agent encolado por ingesta (created/updated/unchanged)
  run-agent-handler.test.ts  run_agent (demo original) con FakeProvider; WK-08/WK-16/WK-19/WK-23
  run-agent-kill-switch.test.ts  Ronda 6: WORKER_DISABLED_AGENTS bloquea la ejecución
  business-tools.test.ts    Ronda 6: las 8 herramientas contra Postgres real (PGlite + migración 0098/E6)
  named-agents.test.ts      Ronda 6: los 5 planes fijos + validación de contexto
  kill-switch.test.ts       Ronda 6: parseDisabledAgents/assertAgentNotDisabled
  enqueue-agent-run.test.ts Ronda 6: dedupe + fail-open (simulado revocando la política de 0098/E6)
  deadline-reminders.test.ts Ronda 6: escaneo de vencimientos, dedupe por día
  agent-evals.test.ts       Ronda 6, tarea 3: evals deterministas por agente (≥5 casos c/u, FakeProvider)
  send-agent-alert.test.ts  Ronda 6: log estructurado del job de alerta
  mail-retry-handler.test.ts REQ-188/S7: éxito tras fallo, tope->dead, ya enviado, suprimido, payload
                             malformado, dos workers concurrentes, sin credenciales (sabotea fetch)
  worker-shutdown.test.ts    Cierre ordenado (SIGTERM), métricas, WK-02/WK-10/WK-14
  config.test.ts             loadConfig() con env vacío/completo/inválido
  schedule-config.test.ts    loadScheduleConfig() con WORKER_SCHEDULE_JSON válido/inválido/vacío
db-proposals/                Las 4 migraciones propuestas (0026-0028, 0098) ya están aplicadas en
                              packages/db; sus tests acompañantes ya NO son .pending/describe.skip
                              (0026-0028 activados en la ronda 4, WK-22; 0098/PROPOSAL-06 en E6) —
                              ver docs/auditoria-1/worker-cierre.md y docs/BLOQUEOS.md
                              ("E6-ciclo-agentes", CERRADA).
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
logger, ver `src/logger.ts`), donde los dos identificadores son **distintos
a propósito** (ver WK6-02 más abajo): `job_id` es el identificador TÉCNICO
de la cola (fencing, reintentos), y `correlation_id` es el identificador de
NEGOCIO del payload (`payload.correlationId`, p. ej. el `tenderId`) cuando
el job lo trae; solo si el payload no declara ninguno se cae de vuelta a
`job.id`.

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

### `run_agent` (`src/handlers/run-agent.ts`)

**Ronda 6 (docs/investigacion/paridad-producto.md "Ronda K"): ya NO es un
esqueleto de demostración.** Ejecuta un `AgentRunner` de `packages/agents`
con almacenes en memoria (`InMemoryRunStore`, `InMemoryToolCallStore` —
la corrida en sí vive solo mientras dura el job), pero ahora con **8
herramientas de negocio reales** y **5 agentes nombrados con plan fijo** —
ver la sección dedicada "Ronda 6: agentes de negocio reales" más abajo para
el detalle completo. Si el job trae `agentRunId`, el resultado FINAL
(incluido un resumen redactado de cada `tool_call`) se refleja en la fila
`agent_runs` ya existente (`packages/db/migrations/0004_agents.sql`) vía
una conexión directa a la base (ver "Seguridad" abajo).

Usa `FakeProvider` (determinista, sin red) salvo que `OPENAI_API_KEY` esté
definida, en cuyo caso usa `OpenAIResponsesProvider` real de
`packages/agents`. Sigue registrando también la herramienta de demostración
original del esqueleto (`llm_complete`) por compatibilidad: si
`job.payload.agentName` NO es uno de los 5 agentes nombrados, el
comportamiento es exactamente el de antes (un solo paso `llm_complete` con
`prompt`/`tier`) — esto es lo que siguen ejercitando
`test/run-agent-handler.test.ts` (WK-08/WK-16/WK-19/WK-23, sin tocar).

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

## REQ-188 / S7: el handler `mail_retry` (`src/handlers/mail-retry.ts`)

`docs/ACEPTACION.md` S7: "envío fallido reintenta vía job y queda
registrado con su historial de intentos". `apps/api` (`src/lib/mail/
send-transactional.ts`, fuera de este ámbito) encola `jobs.kind =
'mail_retry'` cuando `MailService.send()` agota sus propios reintentos
internos y queda `dead`; este handler es quien lo retoma.

### Piezas reutilizadas de `@atiende/mail` (sin duplicar esquema)

- `MailService` (outbox `reserve()` CAS, ML-01; lista de supresión
  fail-closed; backoff exponencial interno) es EXACTAMENTE la misma clase
  que usa `apps/api` — construida aquí por `src/mail/build-mail-service.ts`
  (`buildMailServiceForWorker`), equivalente a `apps/api/src/lib/mail/
  env.ts` pero SIN `linkSigner` (el worker nunca genera un enlace firmado
  nuevo: `job.payload.variables` ya trae el enlace firmado que `apps/api`
  calculó al primer intento).
- `PgMailOutboxStore`/`PgMailSuppressionStore` (`src/mail/pg-mail-stores.ts`)
  implementan `SendRecordStore`/`SuppressionStore` sobre las MISMAS tablas
  y funciones `SECURITY DEFINER` que `apps/api` (`mail_outbox`,
  `mail_suppressions`, 0080/0081) — DUPLICADAS a propósito en código (no
  importadas de `apps/api`, fuera de este ámbito), nunca en esquema.
- `CaptureProvider` sin credenciales (`createMailProviderFromEnv`, sin
  `MAIL_PROVIDER`): igual que `apps/api`, un despliegue sin proveedor real
  configurado nunca intenta salir a la red desde este reintento tampoco.

### El hallazgo de esquema que hizo falta corregir: reservas `dead` quedaban atascadas para siempre

Ninguna función de `mail_outbox_*` (0080) puede des-marcar una fila
`status = 'dead'`: `mail_outbox_save()` solo acepta escribir un estado
terminal (nunca `'pending'`), y `mail_outbox_reserve()`/
`mail_outbox_release()` solo tocan filas `'pending'` en su
`WHERE`/`ON CONFLICT ... WHERE`. Como un job `mail_retry` SIEMPRE apunta a
una `messageKey` que ya está `dead` (es la única condición bajo la que
`apps/api` lo encola), llamar `MailService.send()` otra vez con esa misma
llave habría visto `reserve() = false` para siempre y devuelto `dead` de
nuevo SIN volver a tocar el proveedor — el job habría sido, en la
práctica, un no-op perpetuo. `packages/db/migrations/
0087_req188_mail_retry_audit.sql` agrega `app.mail_outbox_reopen_for_retry`
(SECURITY DEFINER, transición SOLO `dead -> pending`, nunca toca `sent`
-- el correo ya se mandó -- ni `failed_permanent` -- WK-10, ya clasificado
como no-reintentable), y el handler la invoca ANTES de cada llamada a
`MailService.send()`. Ver el docstring extenso de esa función SQL para el
detalle completo.

### Auditoría (`audit_log`, sin organización posible)

Un correo de verificación/restablecimiento de contraseña no tiene sesión
NI organización — la política de `audit_log` exige `app.is_superadmin()`
quien inserte con `org_id null`, y `worker_role`/`app_role` nunca lo son.
`app.record_mail_retry_event` (mismo `0087`, mismo patrón que
`app.record_auth_event`/`app.record_security_event`) es una función
`SECURITY DEFINER` acotada a una lista fija de 7 acciones
(`mail_retry.sent`/`already_sent`/`skipped_preferences`/`suppressed`/
`dead_permanent`/`dead`/`malformed_payload`). El identificador de NEGOCIO
(patrón WK6-02: `audit_log` no tiene columna dedicada para él) es la propia
`messageKey`, guardada dentro de `after.correlationId` — nunca `job.id`
(técnico, distinto en cada intento).

### Clasificación de cada resultado de `MailService.send()`

- `sent`/`already_sent`/`skipped_preferences`/`skipped_suppressed`:
  estados FINALES exitosos — nunca se reenvía un correo ya `sent` ni se
  envía a un destinatario suprimido/con la categoría apagada. Se audita y
  el job se completa sin lanzar.
- `not_configured`: sin proveedor real configurado (estado declarado, no
  un fallo de red) — transitorio, reintenta con el backoff GENÉRICO de
  `JobQueue`/`Worker` (no un backoff propio del handler).
- `invalid_variables`/`unregistered_recipient`/`failed_permanent`:
  permanentes (WK-10) — dead-letra inmediato, sin gastar el ciclo completo
  de reintentos.
- `dead`: `MailService` agotó sus reintentos internos en ESTE intento del
  job — transitorio a nivel de job (backoff genérico); solo se audita como
  `mail_retry.dead` en el ÚLTIMO intento permitido
  (`job.attempts >= job.maxAttempts`), justo antes de que
  `JobQueue.fail()` lo dead-letre de verdad.

Payload malformado (zod, contrato documentado en `apps/api/src/lib/mail/
send-transactional.ts`): se audita como `mail_retry.malformed_payload` y
se rechaza como error PERMANENTE, sin crashear el proceso.

Ver `test/mail-retry-handler.test.ts` para los 9 casos verificados contra
Postgres real (PGlite + migraciones): éxito directo, éxito tras fallo (dos
intentos del job), tope de intentos alcanzado (dead-letter auditado),
mensaje ya enviado (no reenvía), destinatario suprimido (no envía),
destinatario no registrado/suspendido (permanente), payload malformado (sin
crash), dos invocaciones concurrentes de la misma `messageKey` (un solo
envío real al proveedor), y sin credenciales configuradas (0 llamadas de
red, `fetch` saboteado).

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

## Ronda 6: agentes de negocio reales (docs/investigacion/paridad-producto.md "Ronda K")

`run_agent` deja de ser un esqueleto de demostración: ahora ejecuta agentes
de negocio con herramientas reales sobre datos reales de Postgres,
manteniendo TODAS las garantías de `packages/agents` (autorización,
guardrail anticorrupción, no-fabricación, idempotencia, presupuesto,
prohibiciones duras) intactas — ninguna de ellas se modificó, extendió ni
se bypaseó desde `apps/worker`. Alcance estricto de esta ronda:
`apps/worker/**` y este README; no se tocó `apps/api`, `apps/web` ni
ningún `packages/*`.

### Qué es REAL en esta ronda

- **Las 8 herramientas** (`src/agents/business-tools.ts`) leen/escriben
  Postgres de verdad (PGlite en dev/tests, Postgres real en producción vía
  `DATABASE_URL`), no datos simulados:
  - `listar_convocatorias`, `leer_bases`, `leer_perfil_empresa`,
    `resumir_cambios_convocatoria`: `SELECT` reales sobre
    `tenders`/`tender_documents`/`requirement_items`/`company_profiles`/
    `capabilities`/`experience_records`/`tender_change_events`/
    `compliance_items`/`proposals`, siempre filtrados explícitamente por
    `ctx.organizationId` (nunca por un valor del modelo — `ToolRegistry.
    register()` de `packages/agents` rechazaría cualquier esquema que
    declarara `organizationId`/`orgId`/`tenantId`, y
    `test/business-tools.test.ts` prueba además que un intento de
    inyectarlos en tiempo de ejecución se descarta en la validación zod).
  - `proponer_matching`: score determinista (no aleatorio, no del LLM) por
    coincidencia real de palabras entre el título/dependencia de la
    convocatoria y las `capabilities` declaradas de la empresa.
  - `proponer_requisitos_matriz`: extracción determinista basada en reglas
    (palabras clave: "deberá", "obligatorio", "certificación", "garantía",
    etc.) sobre el texto YA extraído (`tender_documents.extracted_text`),
    citando el extracto real (`sourceExcerpt`) — nunca un número de página
    inventado (el esquema actual no guarda desglose por página a nivel de
    documento; se declara `sourcePageReason` explícito en su lugar).
  - `proponer_seccion_propuesta`: bloquea explícitamente
    (`blocked: true`, `missingData`) si no hay `experience_records.
    evidence_ref` real — nunca redacta una afirmación de experiencia sin
    evidencia. Declara `extractSensitiveValues` para que
    `NoFabricationPolicy` (packages/agents) lo verifique de verdad.
  - `programar_alerta`: encola un job REAL (`send_agent_alert`) en la
    tabla `jobs` que este worker ya posee por completo (mismo mecanismo de
    dedupe por `jobKey` que el resto del worker) — nunca envía nada a un
    tercero.
- **Los 5 agentes nombrados** (`src/agents/named-agents.ts`):
  `analista_convocatorias`, `analista_bases`, `redactor_borrador`,
  `vigilante_cambios`, `recordatorios`. El plan de `tool_calls` de cada uno
  es FIJO y se construye en código puro (`buildNamedAgentPlan`) a partir de
  `job.payload.context` — el LLM nunca decide qué herramienta ejecutar ni
  en qué orden; solo redacta texto DENTRO de una herramienta ya decidida
  (`proponer_matching`/`proponer_seccion_propuesta`).
- **Persistencia real de la "propuesta para revisión"**: cada corrida con
  `agentRunId` refleja en `agent_runs.output` (columna `jsonb` YA
  existente, sin migración nueva) un resumen redactado de cada `tool_call`
  (`toolName`, `status`, `authorizationDecision`, `missingSourcedFields`,
  `error`, `inputHash`/`outputHash`) — nunca el contenido crudo. El
  resultado de un agente **nunca** es una aprobación: `needs_approval`/
  `needs_data`/`denied`/`blocked` son estados terminales que exigen
  revisión humana, y `HUMAN_REVIEW_RUN_STATUSES`
  (`src/handlers/run-agent.ts`) los marca `permanent` (WK-10: reintentar no
  los resuelve).
- **Presupuesto por organización real (REQ-128)**: `BudgetLedger`/
  `IdempotencyStore`/`TokenBucketRateLimiter`/`DependencyInvalidationRegistry`
  ahora se crean UNA VEZ por instancia de `createRunAgentHandler` (antes de
  esta ronda se recreaban en cada job, vaciando en silencio cualquier
  límite "por organización" — corregido). Cada paso de cada agente nombrado
  declara un `estimatedCostUsd` nominal (`ESTIMATED_COST_USD`,
  `named-agents.ts`) — sin esto, `BudgetLedger.reserve()` nunca se habría
  llamado (costo 0 no reserva nada) y el presupuesto configurado
  (`WORKER_AGENT_BUDGET_USD_PER_ORG`, por defecto 5 USD) no habría tenido
  ningún efecto observable.
- **Kill-switch por agente**: `WORKER_DISABLED_AGENTS` (lista separada por
  comas) bloquea la ejecución de un agente ANTES de construir el registro
  de herramientas — ningún tool_call corre, ningún presupuesto se reserva.
- **`run_agent` se encola por evento, deduplicado**:
  - Ingesta (`discover_tenders`, `agentEventsQueue`): convocatoria nueva →
    `analista_convocatorias`; convocatoria actualizada → `vigilante_cambios`
    (`enqueueAgentEventsForIngestResults`, `src/handlers/discover-tenders.ts`).
  - Vencimiento próximo (`src/scheduler/deadline-reminders.ts`,
    `enqueueUpcomingDeadlineReminders`): escanea `tenders` de TODAS las
    organizaciones cada `WORKER_POLL_INTERVAL_MS * 10` (mismo período que
    el `Scheduler` de descubrimiento) y encola `recordatorios`, deduplicado
    por `(tenderId, fecha calendario del vencimiento)`.
  - Ambos casos usan `enqueueAgentRun` (`src/agents/enqueue-agent-run.ts`),
    que intenta abrir su PROPIA fila `agent_runs` (identidad
    `SYSTEM_ACTOR_ID`/`SYSTEM_ACTOR_ROLE`, `src/agents/system-actor.ts` —
    UUID nil, nunca un usuario real) y encola el job `run_agent`
    deduplicado por `(agentName, eventKey)` — ver "E6: `PROPOSAL-06`
    incorporada como `0098`" abajo para el caso (hoy solo simulado en
    tests) sin esa política.
- **Evals deterministas con `FakeProvider`** (`test/agent-evals.test.ts`,
  26 casos: ≥5 por cada uno de los 5 agentes): no-fabricación
  (`redactor_borrador` sin evidencia → `needs_data`), guardrail
  anticorrupción (`redactor_borrador`/`recordatorios` con lenguaje de
  soborno en el único campo de texto libre de su contexto → `blocked`),
  techo de riesgo por rol (`consultor_externo` denegado en el primer paso
  "write" de 4 de los 5 agentes; permitido en `vigilante_cambios`, que es
  100% lectura), aislamiento por organización (un `tenderId` de otra
  organización nunca devuelve sus datos), idempotencia por
  `idempotencyKey` (el `LLMProvider` NO se vuelve a invocar en una segunda
  corrida idéntica), y presupuesto excedido (`budgetUsdPerOrg` mínimo →
  la corrida se detiene `failed`, nunca fabrica un resultado). Más un caso
  de sistema compartido (`AgentRunner`/`AuthorizationPolicy`) que prueba
  que un `actionKind` prohibido se deniega SIEMPRE, incluso para
  `superadmin` — ninguna de las 8 herramientas reales tiene hoy un
  `actionKind` prohibido, por diseño.

### E6: `PROPOSAL-06-agent-business-tools-grants.sql` incorporada como `packages/db/migrations/0098_e6_agent_business_tools_grants.sql`

**CERRADO** (docs/BLOQUEOS.md, "E6-ciclo-agentes"). Las lecturas de negocio
adoptan `worker_role` (mismo patrón que `updateAgentRunRow`, WK-23) y
verifican EXPLÍCITAMENTE contra el catálogo real `pg_policies` que la
política RLS de 0098 ya exista antes de correr cualquier `SELECT` de
negocio (`src/agents/db-context.ts`, `SchemaGrantPendingError`). Esto se
descubrió probando contra PGlite real, no por diseño a priori: `worker_role`
YA hereda (`grant app_role to worker_role ... inherit`, 0028) los
privilegios de TABLA por defecto de `app_role` (0001), así que un `SELECT`
crudo sin política RLS que lo reconozca NO lanza ningún error —
simplemente devuelve **cero filas en silencio** (RLS filtra, no bloquea la
sentencia). Devolver esa lista vacía como un resultado real habría sido
exactamente el tipo de fabricación de éxito que este proyecto prohíbe
(REQ-150); por eso la verificación previa contra `pg_policies` sigue siendo
obligatoria, no un adorno, incluso con la migración ya aplicada (defensa
ante un futuro drift de esquema).

`0098` ya está aplicada en `packages/db/migrations/` (verificado: una base
limpia migrada de punta a punta, incluida `0098`, queda consistente —
`packages/db/test/migrate.test.ts`) y el ciclo real
`analista_bases`→`redactor_borrador` (registro real, subida real de un
documento de bases) ya NO falla con `SchemaGrantPendingError` contra esa
base migrada:

- Las 4 herramientas de lectura y `enqueueUpcomingDeadlineReminders` ya
  pueden completar sus consultas de negocio reales contra un Postgres
  migrado con `0098` (antes fallaban explícito con
  `SchemaGrantPendingError`, `permanent: true` — ese camino de error
  SIGUE existiendo y cubierto por tests, simulado revocando la política a
  mano, para el caso de un drift de esquema real).
- `enqueueAgentRun` (disparado por eventos de ingesta/vencimiento) ya abre
  su propia fila `agent_runs` de verdad contra una base migrada; el
  fail-open (job encolado igual, sin `agentRunId`, si la política faltara)
  sigue existiendo como defensa y tiene su propio test simulando la
  ausencia.
- **Hallazgo E6 durante la reverificación**: la política adicional de 0098
  sobre `agent_runs` (`... and started_by is null`) asumía que TODA corrida
  humana fija `started_by` — falso en el código real de esa fecha (NINGÚN
  INSERT de `agent_runs`, ni en `apps/api` ni en `apps/worker`, poblaba esa
  columna). Eso colapsaba el aislamiento de WK-23 para CUALQUIER fila bajo
  una conexión `worker_role` (confirmado reproduciendo el ataque cross-tenant
  real en `packages/db/test/worker-role-and-job-proposals.test.ts`).
  Corregido poblando `started_by = actor_id` en los dos INSERT humanos
  reales (`apps/api/src/lib/agent-stores.pg.ts`,
  `apps/api/src/lib/agent-triggers.ts`) — `enqueue-agent-run.ts` (la única
  ruta autónoma) sigue dejándolo `null` a propósito.
- `test/` de este paquete ya NO aplican `PROPOSAL-06` a mano
  (`applyProposal06`/`test/proposal-06-helper.ts`, eliminado): con la
  migración real incorporada, `createMigratedDb()` la incluye siempre,
  igual que ya ocurría con `PROPOSAL-01/02/03` desde WK-22.

### Qué es FAKE (determinista, no certifica integración real)

- **`FakeProvider`** es el proveedor por defecto para las 5 corridas
  nombradas (igual que para `llm_complete`): determinista, sin red. Se usa
  para el texto narrativo de `proponer_matching`/`proponer_seccion_propuesta`
  (el score/las citas de experiencia SIEMPRE vienen de datos reales,
  calculados en código; solo la REDACCIÓN de la frase que los envuelve usa
  el proveedor). Con `FakeProvider`, esa redacción es un placeholder
  determinista (`[fake:tier:hash]`), no prosa real.

### Qué REQUIERE credenciales de OpenAI (no ejercitado esta ronda)

- Definir `OPENAI_API_KEY` activa `OpenAIResponsesProvider` real
  (`packages/agents`) para la redacción narrativa de
  `proponer_matching`/`proponer_seccion_propuesta`. **No se ejercitó
  contra la API real de OpenAI en esta ronda** (mismo límite ya documentado
  en `packages/agents/README.md`: pasar la suite con `FakeProvider` NO
  certifica esa integración).

## Correcciones de la ronda K (corrector, WK6-01..03, `docs/auditoria-2/worker-agentes.md`)

### WK6-01: aislamiento por organización verificado por CONTENIDO + prueba de mutación

La auditoría adversarial de la Ronda K encontró que la red de pruebas de
aislamiento por organización era **trivial**: quitar el filtro `org_id` de
`fetchTender()` (`src/agents/business-tools.ts`, la única lectura detrás de
`proponer_matching`) **no hacía fallar ninguno** de los 370 tests ni de los
26 evals, pese a producir una fuga cross-org real y comprobada. La causa:
la eval de aislamiento solo comprobaba `toolCall.status === 'ok'`, nunca el
`score`/`explanation`/`matchedKeywords` — exactamente donde vive la fuga.
(El código de producción era y sigue siendo correcto; lo que faltaba era la
red que atrape una regresión futura.)

Qué cambió:

- **Tests negativos directos, con dos organizaciones y datos distinguibles
  (`SECRETO-ORGA`), para las 8 herramientas de negocio**:
  `test/business-tools.test.ts`, bloque `aislamiento cross-org (WK6-01)`.
  Cada test llama al handler real desde el contexto de `orgB` con un
  identificador real de `orgA` y verifica el CONTENIDO del resultado (no
  solo que la llamada "terminó bien"), incluyendo
  `expect(JSON.stringify(output)).not.toContain(SECRET)`.
  `programar_alerta` (la única de escritura) verifica que el job encolado
  queda con el `org_id` del contexto, nunca el de la convocatoria ajena
  pasada como input.
- **La eval de aislamiento de `analista_convocatorias`**
  (`test/agent-evals.test.ts`) ahora verifica contenido además de `status`:
  `agent_runs.output.toolCalls` es un resumen REDACTADO
  (`summarizeToolCalls`) que nunca incluye el `score` real, así que la eval
  invoca además la misma herramienta con el mismo contexto y confirma que
  el resultado nunca contiene el dato de la otra organización.

### Prueba de mutación automatizada (`scripts/wk6-01-mutation-test-org-isolation.sh`)

Para que esta garantía no vuelva a degradarse en silencio, la mutación de
la auditoría es ahora **reproducible con un comando**:

```bash
apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh          # rápido: business-tools + agent-evals
apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh --full   # suite completa de apps/worker
```

El script crea un `git worktree` **desechable** en un directorio temporal,
le superpone el estado actual del árbol de trabajo de `apps/worker`
(cambios sin commitear incluidos), quita el filtro `org_id` de
`fetchTender()` **solo dentro de ese worktree**, corre la suite ahí, y
limpia el worktree pase lo que pase (`trap EXIT`). El árbol de trabajo
principal nunca se modifica.

Convención de salida, invertida respecto a un test normal:

- **exit 0 = "mutación detectada"**: la suite FALLÓ bajo la mutación, que
  es el resultado deseado — sí existe red de seguridad.
- **exit 1 = regresión de WK6-01**: la suite pasó igual sin el filtro de
  aislamiento; hay que arreglar los TESTS (el código de producción puede
  seguir siendo correcto).

Resultado real tras esta reparación (ver `docs/logs/fix-worker-k.log`): la
suite falla bajo la mutación con 2 fallos —
`business-tools.test.ts > ... > proponer_matching ...` (`expected 100 to be
null`) y la eval de aislamiento de `agent-evals.test.ts` — y el script
reporta `OK: la suite FALLÓ bajo la mutación`.

**Límite honesto**: la mutación cubierta es exactamente la de `fetchTender`
(la que la auditoría probó). Las otras 7 herramientas tienen ahora test
negativo directo, pero el script no muta sus consultas una por una; un
script de mutación exhaustivo sobre las 8 lecturas queda fuera de esta
ronda.

### WK6-02: el `correlationId` de negocio (REQ-171) ahora es durable y consultable

Antes de esta ronda, `RunAgentPayload.correlationId` (el identificador de
NEGOCIO — el `tenderId` que `enqueueAgentRun` fija desde
`discover-tenders.ts`/`deadline-reminders.ts`) llegaba correctamente a
`AgentRun.correlationId` y a cada `ToolCallTrace.correlationId` **en
memoria**, pero **se perdía al terminar el job**:

- `updateAgentRunRow()` no lo incluía en el JSON de `agent_runs.output`, y
  la tabla `agent_runs` (`packages/db/migrations/0004_agents.sql`) no tiene
  columna dedicada `correlation_id`.
- El campo `correlation_id` de cada línea de log era literalmente `job.id`
  — el identificador interno de la cola, distinto en cada job — nunca el de
  negocio.

Resultado: el criterio verificable de REQ-171 ("una consulta de auditoría
reconstruye la cadena completa a partir de un solo `correlation_id`") no
era alcanzable.

Qué cambió:

- **`src/handlers/run-agent.ts`**: `updateAgentRunRow()` persiste
  `correlationId` en `agent_runs.output`, y `summarizeToolCalls()` lo
  persiste además en cada entrada de `toolCalls`. Se usa el esquema JSONB
  **ya existente** — no requiere migración nueva (fuera de este ámbito). La
  consulta de auditoría es
  `select ... from agent_runs where output->>'correlationId' = $1`.
- **`src/queue/worker.ts`**: el logger hijo del job usa
  `correlation_id = payload.correlationId` cuando el payload lo trae (string
  no vacío) y `job.id` en cualquier otro caso; `job_id` sigue siempre
  presente por separado. `Worker` es genérico sobre cualquier `kind` de job,
  por eso el helper `businessCorrelationId()` no asume la forma de
  `RunAgentPayload`.
- **`test/run-agent-handler.test.ts`**: test nuevo que corre TRES agentes
  nombrados (`analista_convocatorias` → `analista_bases` →
  `redactor_borrador`) sobre el MISMO `tenderId` — los pasos reales de un
  expediente (convocatoria → matriz → propuesta) — y confirma que **una sola
  consulta SQL** por `output->>'correlationId'` los reconstruye en orden, y
  que cada `tool_call` individual lleva el mismo identificador de negocio.
- **`test/worker-log-correlation.test.ts`** (nuevo): afirma sobre las LÍNEAS
  REALES emitidas por pino (logger real escribiendo a un buffer, no un doble
  artesanal) — con `correlationId` de negocio en el payload cada línea lo
  lleva en `correlation_id` con el `job_id` de cola separado; dos jobs
  distintos del mismo expediente comparten `correlation_id`; y un job sin
  `correlationId` (o con cadena vacía / tipo equivocado) cae de vuelta a
  `job.id`, nunca queda sin correlación.

**Límite honesto de esta ronda (cerrado por E20, ver abajo)**: sin columna
dedicada, la consulta iba contra el JSONB (`output->>'correlationId'`) y no
había índice para ella. Las corridas abiertas por un humano vía `apps/api`
solo llevan este identificador si ese sistema fija `correlationId` en el
payload del job.

### E20: `agent_runs.correlation_id` (columna real) cierra el límite honesto de WK6-02

`docs/BACKLOG.md` ("Índice de correlation_id en agent_runs (BAJA, tras
WK6-02)"): resulta que `agent_runs.correlation_id` **ya existía** desde
`packages/db/migrations/0017_ronda2_extensions.sql`, con su propio índice
(`ix_agent_runs_correlation (org_id, correlation_id)`) — `apps/api/src/lib/
agent-stores.pg.ts` ya la puebla al CREAR una corrida. El límite honesto de
arriba describía bien el síntoma (la consulta de auditoría no tenía columna
indexada disponible) pero no la causa exacta: la columna sí existía, lo que
faltaba era que `updateAgentRunRow()` (`src/handlers/run-agent.ts`, el
UPDATE que CIERRA una corrida disparada por un job) la escribiera — antes
de esta ronda solo tocaba `status`/`output`/`finished_at`.

Qué cambió:

- **`src/handlers/run-agent.ts`**: el mismo `UPDATE` de `updateAgentRunRow()`
  ahora también fija `correlation_id = $6` (`run.correlationId ?? null`,
  idéntico al valor que ya iba dentro de `output`) — un solo viaje a la
  base, no una escritura adicional. `output->>'correlationId'` se conserva
  intacto (compatibilidad hacia atrás con cualquier lector que siga
  consultando el JSONB).
- **`packages/db/migrations/0088_e20_agent_runs_correlation_id.sql`**:
  backfill (`update ... where correlation_id is null and
  output->>'correlationId' is not null`) para filas preexistentes cerradas
  por un job ANTES de esta ronda, que quedaron con `correlation_id` en NULL
  a pesar de tenerlo en `output`. No repite el `alter table`/`create index`
  de 0017 (son `if not exists`, documentados ahí como no-op intencional).
- **`test/run-agent-handler.test.ts`** ("WK6-02/E20"): la consulta de
  auditoría de REQ-171 pasa de `output->>'correlationId' = $1` a
  `correlation_id = $1` (indexada); el test confirma que ambas coinciden.
- **`packages/db/test/e20-agent-runs-correlation-id.test.ts`** (nuevo, en
  `packages/db`): idempotencia del backfill sobre una base con filas
  preexistentes (mismo patrón "migrar hasta el corte, sembrar datos, migrar
  el resto" que `migration-0026b-duplicate-jobs-safety-net.test.ts`), y
  confirma que la RLS existente de `agent_runs` (0008) sigue aislando por
  organización una consulta por `correlation_id`.

### WK6-03: `PROPOSAL-06-...test.ts` deja de ser flaky bajo carga completa

La auditoría vio ese archivo expirar (`Test timed out in 5000ms`) en una
corrida completa de la suite y pasar en 3.1s ejecutado aislado (582ms el
test concreto). Causa: los 5 tests del archivo hacen cada uno
`createMigratedDb()` (todas las migraciones reales de `packages/db`) más
varias transacciones reales contra PGlite, y bajo la suite completa (21+
archivos con PGlite en paralelo) la contención de recursos supera el
`testTimeout` por defecto de vitest.

El timeout se sube a **20000ms para todo ese archivo** (opción del
`describe`, no `vitest.config.ts`): los 5 tests comparten el mismo trabajo
pesado y el mismo riesgo, y cuál pierde la carrera bajo contención es
arbitrario — subirlo solo en el que falló esa vez dejaría a los otros 4
igual de frágiles. El default de 5000ms se conserva para el resto de la
suite, para no enmascarar regresiones de rendimiento en otros archivos.

### WK6-04: el `correlationId` de negocio se sanea en la frontera de `apps/worker` (docs/auditoria-2/worker-agentes-reverificacion.md, MEDIA)

La reverificación de la ronda K encontró que, aunque WK6-02 ya hacía llegar
el `correlationId` de negocio al log y a `agent_runs`, **nada dentro de
`apps/worker` lo validaba ni lo saneaba**: 10 KB pasaban íntegros a cada
línea de log y a la base, un valor con salto de línea/JSON falso, un
override bidireccional RTL (U+202E) o secuencias de escape ANSI sobrevivían
verbatim en el campo `correlation_id`, y un byte NUL rompía directamente el
`INSERT` en Postgres (`unsupported Unicode escape sequence`: jsonb no admite
el byte 0x00) para cualquier productor interno que lo escribiera en un payload
nuevo. Hoy no era explotable desde fuera (`apps/api` ya sanea a UUID en su
frontera, `plugins/correlation-id.plugin.ts`, y los dos productores internos
de `run_agent` pasan UUIDs reales de la base), pero `apps/worker` no tenía
NINGUNA defensa propia ni lo declaraba.

**Contrato declarado (nuevo)**: el `correlationId` que llega en
`payload.correlationId` de cualquier job es un dato de negocio de
**confianza limitada**. `src/lib/correlation-id.ts` expone la ÚNICA función
de saneamiento (`sanitizeCorrelationId`), aplicada en las tres fronteras
donde ese valor puede cruzar hacia un log o una columna persistida:

1. **`src/queue/worker.ts`** (`businessCorrelationId`) — al LEER el payload
   de un job ya reclamado, antes de fijarlo como binding del logger hijo de
   pino.
2. **`src/agents/enqueue-agent-run.ts`** — al ESCRIBIR el payload de un job
   `run_agent` nuevo, para que un valor con NUL nunca llegue a
   `JobQueue.enqueue()` (evita el `INSERT` roto de raíz para este
   productor).
3. **`src/handlers/run-agent.ts`** — antes de construir `AgentRunRequest`,
   para que `run.correlationId`/`ToolCallTrace.correlationId`/
   `agent_runs.correlation_id` (columna real, E20) nunca reciban el valor
   crudo.

Acepta solo un **UUID** o un **token opaco** `[A-Za-z0-9._-]{1,64}`.
Cualquier otro valor se reemplaza por un **id derivado determinista**
(`sane-<16 hex de sha256 del valor crudo completo>`): el valor original
NUNCA se propaga, pero el reemplazo es estable — el mismo valor crudo
malformado siempre deriva el mismo id saneado, así que jobs relacionados del
mismo productor (p. ej. reintentos con el mismo `correlationId` corrupto)
siguen siendo agrupables entre sí. Cuando no hay NINGÚN valor usable (falta,
no es `string`, o cadena vacía), `sanitizeCorrelationId` devuelve `null` y
cada llamador conserva su propio respaldo ya existente (`job.id`, WK6-02) —
esa caída no cambia.

**Límite que sigue siendo cierto**: un byte NUL en un `correlationId`
producido por un productor FUERA de `apps/worker` (p. ej. una llamada
directa a `JobQueue.enqueue()` desde otro paquete/proceso) sigue rompiendo
el `INSERT` de Postgres — el saneamiento de este paquete no puede proteger
un `INSERT` que nunca pasa por su propio código de escritura
(`enqueueAgentRun`). `test/worker-log-correlation.test.ts` documenta este
límite con una prueba explícita (`queue.enqueue()` directo con NUL sigue
lanzando).

Tests: `test/correlation-id-sanitize.test.ts` (la función pura: UUID válido,
token corto, 10 KB, ANSI, RTL, salto de línea + JSON falso, NUL, valores
distintos derivan ids distintos, sin valor usable → `null`);
`test/worker-log-correlation.test.ts` (WK6-04, camino real de
`Worker.process()` con logger de pino real: ninguno de esos payloads
adversariales sobrevive en `correlation_id`); `test/enqueue-agent-run.test.ts`
(WK6-04: el payload escrito nunca lleva el valor crudo, un NUL nunca rompe
el `INSERT`); `test/run-agent-handler.test.ts` (WK6-04: `agent_runs.correlation_id`/
`output.correlationId` solo reciben valores saneados).

#### WK6-04, hallazgo 1 (reverificación): `agent_runs.correlation_id` quedaba NULL hasta el final de la corrida — "audit gap" en la ruta de encolado

`enqueueAgentRun()` (`src/agents/enqueue-agent-run.ts`) ya calculaba el
`correlationId` saneado para el payload del job `run_agent`, pero el
`INSERT` que abre la fila `agent_runs` (estado inicial `running`) no
escribía esa misma columna — solo lo hacía `updateAgentRunRow`
(`src/handlers/run-agent.ts`) al CERRAR la corrida. A diferencia de
`apps/api/src/lib/agent-stores.pg.ts`, que sí puebla `correlation_id` desde
su propio `INSERT` para las corridas que abre directamente, una corrida
disparada por este camino que muriera antes de terminar (proceso caído,
`fenced` por WK-02/WK-14, lease expirado) dejaba la fila en
`status = 'running'` con `correlation_id is null` de forma PERMANENTE: un
hueco real de auditoría (REQ-171 no podía encontrar, por `correlation_id`,
una corrida abierta por este camino que nunca cerró). Corregido: el mismo
`sanitizeCorrelationId(...)` ya calculado se reutiliza también en el
`INSERT` inicial, así que la fila nace correlacionable desde el primer
instante, no solo al final. Tests: `test/enqueue-agent-run.test.ts`
(describe "audit gap": `correlation_id` presente en la fila `running` recién
abierta, un valor malformado llega ya como el mismo id derivado que el
payload del job, y sin `correlationId` la columna sigue NULL sin cambio de
comportamiento).

#### WK6-04, hallazgo 2 (reverificación): una 4ª frontera sin sanear — `discover-tenders.ts` hacia `source_runs` y la cabecera `X-Correlation-Id`

El módulo de saneamiento (`src/lib/correlation-id.ts`) documentaba tres
fronteras, pero `createDiscoverTendersHandler()` (`src/handlers/discover-tenders.ts`,
REQ-171) usaba `job.payload.correlationId ?? job.id` SIN pasar por
`sanitizeCorrelationId` antes de escribirlo en `source_runs.correlation_id`
y de mandarlo tal cual como la cabecera saliente `X-Correlation-Id` hacia
`POST /internal/tenders/ingest` (`src/ingest/ingest-client.ts`). Ahí un
byte NUL rompe el mismo `INSERT` que en `agent_runs`/`jobs`, pero un salto
de línea/CR en el valor es además **inyección de cabecera HTTP** hacia
`apps/api`, no solo un dato sucio en un log. Hoy el único productor de jobs
`discover_tenders` es el scheduler (`src/scheduler/scheduler.ts`), que
nunca fija `correlationId` (cae siempre a `job.id`, un UUID real) — no
explotable en la práctica hoy, mismo perfil de riesgo que las otras tres
fronteras antes de esta corrección — pero el payload es JSONB sin esquema
forzado igual que el de `run_agent`, así que se cierra por el mismo
motivo. `src/lib/correlation-id.ts` ahora documenta esta cuarta frontera.
Tests: `test/discover-tenders-handler.test.ts` (un `correlationId` con
CRLF + 10 KB nunca llega a `source_runs.correlation_id` ni a la cabecera —
ambos terminan con el mismo id derivado —; un UUID válido sigue pasando
intacto, sin sobre-saneamiento).

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
- **`run_agent` no persiste `tool_calls` individuales en su propia tabla
  Postgres (`tool_calls`, `packages/db/migrations/0004`)** — Ronda 6 CIERRA
  PARCIALMENTE esto: cada `tool_call` SÍ queda persistido, pero como un
  resumen redactado dentro de `agent_runs.output` (esquema YA existente,
  ver sección "Ronda 6" arriba), no como filas individuales en `tool_calls`
  (ese `INSERT` requeriría un grant adicional para `worker_role` que esta
  ronda decidió NO proponer todavía, para mantener `PROPOSAL-06` acotado a
  lo estrictamente necesario). `InMemoryToolCallStore`/`InMemoryRunStore`
  de `packages/agents` siguen usándose para el ciclo de vida DENTRO del
  job, como antes.
- **Integración real con OpenAI no ejercitada**: `OpenAIResponsesProvider`
  se usa tal cual la expone `packages/agents` (que documenta lo mismo en su
  propio README); esta ronda no tuvo credenciales de producción para
  probarla contra la API real — tampoco para la redacción narrativa de los
  5 agentes nombrados nuevos (Ronda 6).
- ~~**`run_agent` solo registra una herramienta de demostración**~~
  **CERRADO (Ronda 6)**: 8 herramientas de negocio reales
  (`src/agents/business-tools.ts`) + 5 agentes nombrados con plan fijo
  (`src/agents/named-agents.ts`) — ver sección "Ronda 6: agentes de negocio
  reales" arriba. `llm_complete` se mantiene solo por compatibilidad hacia
  atrás para `agentName` fuera de esos 5.
- **Sin canal real de notificación para `programar_alerta`/
  `recordatorios`** (Ronda 6): `send_agent_alert`
  (`src/handlers/send-agent-alert.ts`) solo registra un `warn` estructurado
  en el log del proceso — no hay correo/SMS/webhook real configurado (el
  correo transaccional real ya está documentado como bloqueo externo
  pendiente de credenciales en `docs/investigacion/paridad-producto.md
  §6.2`). Añadir un canal real es una extensión de ese mismo handler, sin
  cambiar el contrato del job ni de la herramienta que lo encola.
- **Kill-switch por agente solo por variable de entorno** (Ronda 6,
  `WORKER_DISABLED_AGENTS`): una tabla dedicada para control dinámico sin
  reiniciar el proceso queda PROPUESTA, no implementada (ver
  `src/agents/kill-switch.ts`) — requeriría además un endpoint de
  administración en `apps/api`, fuera de mi ámbito esta ronda.
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
