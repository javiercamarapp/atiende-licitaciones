# Re-verificación adversarial independiente — apps/worker

**Ámbito**: la columna "Estado reparación" de `docs/auditoria-1/worker.md`
(hallazgos WK-01..WK-13) y las 3 propuestas SQL de
`apps/worker/db-proposals/`.

**Reverificador**: agente Sonnet independiente, sin participación en la
construcción ni en la reparación de este paquete. Ejecución real de
`npm install`, `typecheck`/`lint`/`test`/`test:coverage`, verificación de
ancestría de cada commit citado (`git merge-base --is-ancestor`), y **9
mutaciones/escenarios adversariales propios** (tests temporales en
`apps/worker/test/zz-reverify-*.test.ts`, nunca commiteados, borrados al
terminar) — todo en `git worktree add <scratchpad>/reverify-worker HEAD`,
nunca en el árbol principal. El worktree fue eliminado
(`git worktree remove --force`) al terminar.

**HEAD al momento del corte**: `d94b228` ("docs: corrección worker
completada; propuestas SQL asignadas; despacho reverificación worker").

**Comandos y salida completa**: `docs/logs/reverify-worker.log`.

---

## Resumen ejecutivo

De los 13 hallazgos originales (WK-01..WK-13), **7 se confirman CERRADOS**,
**4 quedan en PARCIAL** (la mitigación es real y correcta para el escenario
original que se confirmó, pero un escenario adyacente — pedido
explícitamente por el encargo de esta reverificación — revela un gap NO
cubierto), **1 sigue correctamente PENDIENTE_ESQUEMA** (WK-07, sin cambios
de veredicto), y **0 son NO CERRADO** (ninguna reparación revierte o
contradice lo que afirma haber corregido).

Se encontraron **5 hallazgos nuevos** (WK-14..WK-18), todos con evidencia
reproducible propia:

- **WK-14 (ALTA)**: el "fencing token" de WK-02 (`attempts` capturado en el
  claim) solo se verifica en `heartbeat()`. `complete()`/`fail()`/
  `deadLetterPermanent()` NO reciben `expectedAttempts` — bajo reutilización
  del mismo `WORKER_ID` tras un reinicio (patrón explícitamente recomendado
  por el propio README: "cada uno con su propio WORKER_ID", que en la
  práctica muchos operadores fijan de forma ESTABLE, p. ej. el nombre del
  pod en Kubernetes), un proceso "zombie" de una generación anterior puede
  completar/fallar el job de una generación NUEVA que sigue corriendo bajo
  el mismo `workerId`, contradiciendo el propio comentario del código
  ("doble verificación locked_by Y attempts... incluso en el caso extremo
  de colisión de workerId").
- **WK-16 (ALTA)**: `updateAgentRunRow` (WK-08) desactiva POR COMPLETO su
  propia verificación de `org_id` cuando `job.payload.organizationId` es
  `null` — un valor EXPLÍCITAMENTE válido según el tipo
  `RunAgentPayload.organizationId: string | null`. Un job `run_agent` con
  `agentRunId` real de cualquier tenant y `organizationId: null` sobrescribe
  esa fila sin ningún error, exactamente el comportamiento PRE-WK-08 que la
  corrección dice haber eliminado.
- **WK-15 (MEDIA)**: el test oficial de WK-04 ("2 Scheduler concurrentes x
  20 iteraciones sin duplicados") no ejercita ninguna carrera real en este
  entorno — PGlite serializa transacciones completas de punta a punta
  (confirmado con un diagnóstico propio), así que el mismo test pasaría
  IDÉNTICO sin el advisory lock. La mitigación SQL es correcta para
  Postgres real, pero la afirmación de "verificado" en el README/worker.md
  no está respaldada por evidencia de concurrencia real en este entorno.
- **WK-17 (MEDIA)**: HTTP 408 (Request Timeout, semánticamente transitorio)
  se clasifica como error PERMANENTE en `IngestApiError.permanent` y nunca
  se reintenta dentro de `TenderIngestClient.ingest()` (no está en
  `RETRYABLE_STATUS`) — un 408 real de `apps/api` mata el job en el primer
  intento en vez de reintentarlo, contradiciendo el criterio pedido
  explícitamente por esta reverificación.
- **WK-18 (BAJA, trazabilidad)**: el commit citado para WK-13 en la tabla de
  `docs/auditoria-1/worker.md` ("fix(worker): WK-13 declaredEffects
  obligatorio en tools de run_agent") no existe como commit independiente;
  la corrección real está bundleada dentro del commit `3bc21f6`
  ("docs(sources): SR-09..."), sin relación aparente por su mensaje. El
  código es correcto y está en HEAD; solo la referencia documental es
  inexacta.

WK-09 se reconfirma **CERRADO** dentro de su alcance ya declarado: la clave
de idempotencia es estable byte-a-byte, pero (confirmado con evidencia
propia) NO es estable para el mismo conjunto lógico de registros en otro
orden — esto ya estaba implícitamente disclosed ("determinista byte-a-byte
en reintentos del mismo snapshot") y no constituye una sobreclaim nueva.

Las 3 propuestas SQL son, en su lógica y sintaxis, **correctas para Postgres
real y no destructivas de datos existentes**. La propuesta 02 (índice único
+ `cancelled`) tiene 2 riesgos operacionales de despliegue no documentados
(posible fallo si ya existen duplicados activos; lock de escritura por usar
`CREATE INDEX` en vez de `CONCURRENTLY` sobre una tabla de cola en vivo) —
ver §5.

`npm run -w packages/sources typecheck` está limpio y la suite completa de
`apps/worker` (55 tests, 3 archivos `.pending.test.ts` correctamente
`skip`) sigue en verde con las correcciones ya aplicadas a `packages/sources`
(SR-03 `not_configured` para DOF sin `noteCodes`, SR-11 `eligibility` en
`MatchResult`) — ninguna regresión cruzada.

---

## 1. Reproducibilidad

```
npm run -w packages/sources typecheck   -> OK
npm run -w apps/worker typecheck        -> OK
npm run -w apps/worker lint             -> OK
npm run -w apps/worker test             -> 8 archivos / 55 tests OK, 3 archivos / 5 tests skip (db-proposals/*.pending.test.ts)
npm run -w apps/worker test:coverage    -> 93.01% líneas / 82.42% ramas (umbral 85/80... líneas por debajo pero total ponderado pasa: ver nota)
```

**Nota de cifras**: el reporte de cobertura de `v8` mostró
`All files 93.01% líneas / 82.42% ramas / 80.59% funciones`, todos por
encima de los umbrales configurados (`lines: 85, branches: 80` — el
resumen "All files" es el que evalúa el gate, no cada archivo individual;
algunos archivos concretos, p. ej. `source-runs-repository.ts` con 73.07%
líneas, quedan por debajo del umbral GLOBAL pero el agregado del paquete lo
supera). Cifras consistentes en orden de magnitud con
`docs/logs/fix-worker-ronda2.log` (92.75%/80.53%), diferencia menor
explicable por variación de qué archivos de test se ejecutaron.

Ancestría de los 6 commits citados en la tabla de hallazgos (`8f03444`,
`d7ac83a`, `a1437cc`, `a545298`, `1b656a3`, `21aadef`) confirmada con
`git merge-base --is-ancestor` — los 6 son ancestros de HEAD y sus
`git show --stat` coinciden con los archivos declarados. **Excepción**: el
commit citado para WK-13 no existe tal cual (ver WK-18, §4).

---

## 2. Hallazgos originales — veredicto por ID

| ID | Veredicto reverificación | Evidencia |
|---|---|---|
| WK-01 | **CERRADO** | `claim()` (`job-queue.ts:138-174`) dead-letra directamente en la misma sentencia UPDATE cuando `attempts+1 > max_attempts`, sin pasar por `fail()`. Test oficial "WK-01" reproduce exactamente el escenario pedido (crash con `attempts=max_attempts-1`, lease expira dos veces seguidas) y pasa. |
| WK-02 | **PARCIAL** | El fencing por `attempts` SÍ protege correctamente el escenario original confirmado (worker distinto reclama, `heartbeat()` detecta `false`, `Worker.process()` aborta el handler antes de `complete()`/`fail()` — confirmado con test oficial y 3 tests adversariales propios). PERO `complete()`/`fail()`/`deadLetterPermanent()` no verifican `expectedAttempts` — solo `locked_by` — así que bajo reutilización del mismo `workerId` (reinicio con `WORKER_ID` estático) un proceso zombie de generación anterior SÍ puede terminar el job de la generación nueva. Ver WK-14 (nuevo). |
| WK-03 | **CERRADO** | Confirmado con 4 escenarios adversariales propios (401, timeout, `TypeError` no-HTTP, `throw` de un string plano) + el test oficial de fallo a mitad de `AsyncIterable`: `source_runs` se registra SIEMPRE, sin importar el tipo de excepción de `ingest()` ni el punto de fallo de `discover()`. |
| WK-04 | **PARCIAL** | El SQL (`pg_advisory_xact_lock` transaccional) es correcto para Postgres real. Pero el test oficial de "2 Scheduler concurrentes" no demuestra protección real en este entorno: PGlite serializa transacciones completas sin intercalar (confirmado con diagnóstico propio), así que el mismo test pasaría idéntico SIN el lock. Ver WK-15 (nuevo). |
| WK-05 | **CERRADO** | Test oficial confirma `coverage.obtained=0` y `discardedAfterDiscoverFailure=1` cuando `discover()` falla a mitad de iteración; releído en código, consistente. |
| WK-06 | **CERRADO** | `coverage.expected`/`expectedReason` poblados en las 4 rutas de `recordSourceRun`, confirmado por lectura de código y test oficial "sin payload.expectedTotal, coverage.expected es null CON un motivo explícito, en las 4 rutas". |
| WK-07 | **PENDIENTE_ESQUEMA** (sin cambio) | Mitigación de código (`ingest_failed` como estado fino nuevo) ya aplicada; la ampliación real del enum sigue, correctamente, fuera del alcance de `apps/worker`. Propuesta SQL revisada y correcta (§5). |
| WK-08 | **PARCIAL** | El escenario original confirmado (agentRunId real de orgA + payload con `organizationId: orgB`, ambos NO NULOS) SÍ está protegido — confirmado por test oficial y releído en código. PERO `organizationId: null` (valor válido por tipo) desactiva por completo el `WHERE org_id = $5`, permitiendo sobrescribir la fila real sin ninguna verificación. Ver WK-16 (nuevo, reproducido con evidencia propia — este es exactamente el escenario "run_agent con job sin org_id" pedido por el encargo). |
| WK-09 | **CERRADO** (dentro de su alcance declarado) | La clave es estable byte-a-byte (confirmado); NO es estable para el mismo conjunto reordenado (confirmado con evidencia propia) — esto coincide con la limitación ya disclosed explícitamente en el propio hallazgo original, no es una sobreclaim nueva. |
| WK-10 | **PARCIAL** | 429, 400, 422, 5xx y error de red sin status se clasifican correctamente (transitorio/permanente) — confirmado con 5 escenarios adversariales propios contra servidores HTTP reales. 408 se clasifica INCORRECTAMENTE como permanente (dead-letter inmediato) cuando semánticamente es transitorio. Ver WK-17 (nuevo). |
| WK-11 | **CERRADO** | Gate de cobertura real, confirmado por mutación de umbral: subir `lines`/`branches` a 99% hace fallar `test:coverage` con `ERROR: Coverage for lines/branches ... does not meet global threshold` y código de salida distinto de 0; revertido sin dejar diff. |
| WK-12 | **CERRADO** | `JobStatus` documenta explícitamente por qué `'failed'` nunca se asigna desde este worker; confirmado que ningún código de `job-queue.ts` lo usa. |
| WK-13 | **CERRADO** (funcionalmente) | `declaredEffects: ['read_only']` presente y correcto en `run-agent.ts`; `typecheck`/`build`/`test` limpios. Trazabilidad del commit citado es incorrecta — ver WK-18 (nuevo). |

**Conteo**: CERRADO = 7 (WK-01, 03, 05, 06, 09, 11, 12) · PARCIAL = 4 (WK-02,
04, 08, 10) · PENDIENTE_ESQUEMA = 1 (WK-07) · NO CERRADO = 0.

---

## 3. Detalle de los 4 hallazgos que bajan a PARCIAL

### WK-02 — fencing real solo en `heartbeat()`, no en `complete()`/`fail()`

`heartbeat(jobId, workerId, expectedAttempts)` (`job-queue.ts:193-202`)
verifica `locked_by = workerId AND (expectedAttempts IS NULL OR attempts =
expectedAttempts)` — un fencing token de verdad. Pero `complete()`
(`job-queue.ts:204-213`), `fail()` (`job-queue.ts:220-242`) y
`deadLetterPermanent()` (`job-queue.ts:254-263`) solo verifican
`locked_by = workerId`, SIN comparar `attempts`. `Worker.process()`
(`worker.ts:154,176,173`) llama a las tres SIN pasar ningún token de
generación.

Mientras el `workerId` de dos generaciones sea DISTINTO (el caso que
confirmó la auditoría original: worker-A vs worker-B), el chequeo por
`locked_by` basta — B tiene un `workerId` distinto, así que A nunca puede
tocar la fila que B ya posee. Pero si el MISMO proceso se reinicia con el
MISMO `workerId` (patrón explícitamente sugerido por el README: "cada uno
con su propio WORKER_ID", que en despliegues reales suele ser un valor
ESTABLE — nombre de pod, hostname —, no aleatorio por arranque) y reclama de
nuevo el mismo job tras un lease expirado, `locked_by` vuelve a coincidir
con el string del proceso NUEVO. Un handler zombie de la generación
ANTERIOR (que de alguna forma sigue vivo — proceso hijo no matado, promesa
huérfana) que llame `complete()`/`fail()` con ESE MISMO `workerId` string
pasará el chequeo `locked_by = workerId`, terminando el job de la
generación NUEVA sin que ella lo sepa.

Reproducido con `JobQueue` directo (sin mocks): claim('worker-A')
attempts=1 → lease vencido → claim('worker-A') de nuevo attempts=2 → el
zombie de attempts=1 llama `complete(jobId, 'worker-A')` → **el job queda
`succeeded`**, aunque la generación 2 (attempts=2) sigue activa.

**Reparación sugerida (no aplicada)**: pasar `job.attempts` (capturado en
el `claim()` original) como parámetro adicional a `complete()`/`fail()`/
`deadLetterPermanent()`, con el mismo patrón `AND attempts = $N` que ya usa
`heartbeat()`.

### WK-04 — el test de concurrencia no demuestra concurrencia real en PGlite

Diagnóstico propio: dos `db.transaction()` lanzados con `Promise.all`
(SIN ningún lock) sobre la misma instancia PGlite se ejecutan en secuencia
COMPLETA — la transacción A corre de principio a fin (incluida una espera
artificial de 30ms) antes de que la transacción B siquiera empiece,
aunque B solo espera 5ms. Orden observado:
`A:start | A:after-select | A:after-delay | A:end | B:start | ...`.

Esto confirma que PGlite (documentado en `packages/db/README.md` como "una
sola conexión/proceso") nunca deja que dos "transacciones" concurrentes
compitan de verdad por el mismo SELECT-luego-INSERT: el test oficial de
WK-04 pasaría exactamente igual SIN el `pg_advisory_xact_lock`, porque la
carrera que ese lock previene nunca llega a ocurrir en este entorno. La
mitigación SQL en sí es textbook-correcta para Postgres real (confirmado
por lectura de código, §5), pero la frase "verificado con 2 procesos
concurrentes x 20 iteraciones sin duplicados" (README/worker.md) da a
entender una verificación empírica de seguridad ante concurrencia real que
esta suite, en este entorno, no puede dar.

**Recomendación**: repetir este test contra un Postgres real (Docker/CI)
cuando esté disponible, y mientras tanto anotar explícitamente junto a la
entrada WK-04 (no solo en la sección general "Pendientes" del README) que
la "verificación" es de LÓGICA, no de concurrencia de motor real — misma
nota que ya existe para `claim()`/`FOR UPDATE SKIP LOCKED`.

### WK-08 — `organizationId: null` desactiva el guard completo

`updateAgentRunRow` (`run-agent.ts:135-161`) construye el `WHERE` como
`id = $1 and ($5::uuid is null or org_id = $5::uuid)`. Esto es
intencional para permitir jobs "sin org" en teoría, pero el efecto real es
que CUALQUIER job con `organizationId: null` (un valor válido según el
tipo `RunAgentPayload`) y un `agentRunId` real de CUALQUIER tenant
actualiza esa fila sin ninguna verificación — exactamente el
comportamiento PRE-WK-08.

Reproducido: `agent_runs` real de orgA (con `org_id` NOT NULL en el
esquema, confirmado en `0004_agents.sql:23`), job payload con ese
`agentRunId` y `organizationId: null` → el handler completa sin error y la
fila de orgA queda `status='succeeded'` con `output` poblado, sin que
ninguna capa lo impida ni lo registre como inconsistente.

Esto es precisamente el escenario que pidió verificar esta reverificación
("run_agent con job sin org_id") y revela que la defensa de WK-08 tiene un
bypass trivial: basta con que quien construya el payload del job omita o
ponga `null` en `organizationId` (bug, dato faltante, o incluso una fuente
maliciosa que aprenda del propio código fuente) para saltarse por completo
la verificación cruzada de tenant.

**Reparación sugerida (no aplicada)**: si `agentRunId` está presente, exigir
que `organizationId` sea NO nulo (fallar explícito con un error de
validación distinto, ANTES de cualquier `UPDATE`, si viene `agentRunId` sin
`organizationId`) — el caso "fire and forget sin persistencia" (que sí
usa legítimamente `organizationId: null`, ver test oficial "sin agentRunId
en el payload...") ya no pasa por esta función porque el propio handler
solo llama `updateAgentRunRow` cuando `job.payload.agentRunId` existe
(`run-agent.ts:201-203`); no hay ningún caso legítimo hoy de
`agentRunId` presente + `organizationId: null` a la vez.

### WK-10 — 408 clasificado como permanente

`RETRYABLE_STATUS` (`ingest-client.ts:88`) = `{429, 500, 502, 503, 504}`,
sin 408. `IngestApiError.permanent` (`ingest-client.ts:68-70`) marca
permanente cualquier `status` en `[400, 500)` que no sea `retryable` — 408
cae ahí. Confirmado con servidor HTTP real: un 408 nunca se reintenta
dentro de `ingest()` (`server.hits === 1`) y `isPermanentJobError()` lo
clasifica como permanente, así que `Worker.process()` lo dead-letra en el
primer intento (`deadLetterPermanent`), sin darle ni siquiera el ciclo
normal de backoff.

Un 408 real (timeout del lado del servidor bajo carga momentánea, por
ejemplo) es semánticamente TRANSITORIO — el mismo payload probablemente
tendría éxito en un reintento inmediato — pero este worker lo trata igual
que un 400 de datos mal formados, matando el job de forma permanente en el
primer intento.

**Reparación sugerida (no aplicada)**: agregar `408` a `RETRYABLE_STATUS`
(o, como mínimo, excluirlo explícitamente de la fórmula de `.permanent`
para que caiga en el ciclo normal de backoff de `fail()` en vez de
`deadLetterPermanent()`).

---

## 4. Hallazgos nuevos (WK-14..WK-18)

| ID | Severidad | Rubro | Hallazgo | Evidencia |
|---|---|---|---|---|
| WK-14 | **ALTA** | 2. Cola / fencing | `complete()`/`fail()`/`deadLetterPermanent()` no verifican `expectedAttempts` (a diferencia de `heartbeat()`), solo `locked_by`. Bajo reutilización del mismo `WORKER_ID` tras un reinicio, un zombie de una generación anterior puede terminar el job de la generación activa. | Test propio §5 del log: `complete(jobId,'worker-A')` de la generación 1 marca `succeeded` un job que la generación 2 (mismo `workerId`, `attempts` distinto) sigue "corriendo". |
| WK-16 | **ALTA** | 6. run_agent / 7. Seguridad | `organizationId: null` en el payload de `run_agent` desactiva por completo la verificación cruzada de tenant de WK-08 (`$5::uuid is null` hace que el `WHERE` se reduzca a `id=$1`). | Test propio §8 del log: `agentRunId` real de orgA + `organizationId: null` → `UPDATE` exitoso sin error, fila de orgA sobrescrita. |
| WK-15 | MEDIA | 4. Scheduler / 8. Calidad de pruebas | El test oficial de WK-04 no demuestra protección de concurrencia real: PGlite serializa transacciones completas sin intercalar, así que el mismo test pasaría igual sin el advisory lock. | Diagnóstico propio §7b del log: orden de ejecución observado sin intercalado alguno entre dos `transaction()` concurrentes. |
| WK-17 | MEDIA | 5. Honestidad ingesta | HTTP 408 se clasifica como error PERMANENTE (dead-letter inmediato) en vez de transitorio, contradiciendo la semántica HTTP estándar y el criterio pedido explícitamente para esta reverificación. | Test propio §10 del log contra servidor HTTP real: `server.hits===1` (nunca reintentado), `.permanent===true`, `isPermanentJobError===true`. |
| WK-18 | BAJA | Trazabilidad / gobierno | El commit citado para WK-13 en la tabla de `docs/auditoria-1/worker.md` no existe; la corrección real está en el commit `3bc21f6` ("docs(sources): SR-09..."), sin relación aparente con WK-13 en su mensaje — probable artefacto de una carrera de commits concurrentes. | `git log -p -- apps/worker/src/handlers/run-agent.ts`: el bloque `declaredEffects` aparece introducido en `3bc21f6`, no en un commit "fix(worker): WK-13...". |

---

## 5. Evaluación de las 3 propuestas SQL

| Propuesta | ¿Idempotente? | ¿Correcta para Postgres real? | ¿Rompe datos existentes? | Veredicto |
|---|---|---|---|---|
| `PROPOSAL-01-widen-source-run-status.sql` | Sí (`ADD VALUE IF NOT EXISTS` x3) | Sí — sintaxis y semántica estándar; el propio archivo advierte correctamente la limitación de Postgres de no usar el valor nuevo en la misma transacción que lo agrega (no aplica aquí, el archivo solo agrega) | No — `ADD VALUE` solo extiende el enum, ninguna fila existente cambia | **Correcta, sin objeciones bloqueantes** |
| `PROPOSAL-02-jobs-dedupe-and-cancelled.sql` | Sí (`ADD VALUE IF NOT EXISTS`, `CREATE ... IF NOT EXISTS`) | Sintaxis de índice único parcial correcta | No de forma directa, PERO ver riesgos de despliegue abajo | **Correcta en lógica, con 2 riesgos operacionales no documentados en el archivo** (ver detalle) |
| `PROPOSAL-03-worker-role.sql` | Sí (`DO $$ IF NOT EXISTS $$` para el rol; `GRANT` es idempotente) | Sí — `worker_role` hereda `USAGE` de esquema vía `GRANT app_role TO worker_role` (confirmado leyendo `0001_bootstrap.sql`), no necesita `GRANT EXECUTE` explícito en funciones RLS porque Postgres otorga `EXECUTE` a `PUBLIC` por defecto y ninguna migración lo revoca | No — solo crea rol y grants nuevos, aditivo puro | **Correcta, sin objeciones bloqueantes** (password placeholder ya señalado correctamente como pendiente de reemplazo real) |

**Riesgos de `PROPOSAL-02` no documentados en el archivo**:

1. **Posible fallo de la migración si ya existen duplicados activos**:
   `CREATE UNIQUE INDEX` fallará si al momento de aplicar esta migración ya
   hay filas `jobs` duplicadas para la misma `(kind, jobKey)` en estado
   activo — escenario realista, porque es EXACTAMENTE lo que WK-04 confirmó
   que podía pasar antes de que el advisory lock se desplegara (sistemas ya
   en producción antes de esa mitigación podrían arrastrar duplicados
   históricos aún `queued`/`running`). Es una falla SEGURA (bloquea el
   despliegue, no corrompe datos), pero el archivo no indica un paso previo
   de limpieza/dedupe ni cómo detectarlo antes de intentar aplicar la
   migración.
2. **`CREATE INDEX` simple, no `CONCURRENTLY`**: sobre una tabla `jobs` en
   producción con escrituras constantes (`claim()`/`heartbeat()`/`fail()`
   de un sistema de colas EN VIVO), un `CREATE INDEX` normal toma un lock
   que bloquea escrituras concurrentes durante la construcción del índice.
   Para una tabla de cola activa esto es un riesgo operacional real de
   despliegue (ventana de bloqueo), no mencionado en el archivo.

Ninguno de los dos invalida la propuesta — ambos son matices de "cómo" y
"cuándo" aplicarla en producción, no defectos en la lógica del cambio.

Los 3 archivos `.pending.test.ts` que acompañan las propuestas son
`describe.skip` con cuerpos de test **intencionalmente vacíos** (comentario
explícito "Intencionalmente vacío" en los 3) — documentan la INTENCIÓN de
lo que se debería probar una vez aplicada cada migración, pero **no
contienen ninguna aserción ejecutable hoy**. Esto es honesto (claramente
marcados como `skip`, nunca se cuentan como "en verde" en el conteo de la
suite), no una sobreclaim, pero vale la pena que quien aplique cada
migración sepa que "acompaña su propio test" significa aquí "documenta qué
test escribir", no "ya existe un test que solo hay que des-skipear sin más
trabajo" (en la mayoría de los 3 casos sí basta con eso; en el caso de
`worker_role` (PROPOSAL-03) hace falta además una conexión real como ese
rol, no solo aplicar la migración).

---

## 6. Regresión cruzada con `packages/sources`

```
npm run -w packages/sources typecheck   -> OK, sin salida
npm run -w apps/worker test              -> 55/55 tests en verde (3 archivos/5 tests skip por diseño)
```

Los 5 conectores reales de `buildDefaultConnectorRegistry()` (incluido
`createDofConnector()`, afectado por SR-03) siguen produciendo
`not_configured` explícito en los 3 tests A4 de
`discover-tenders-handler.test.ts` — SR-03 (que hace que DOF sin
`noteCodes` lance `SourceNotConfiguredError` en vez de iterar 0 veces en
silencio) es compatible con la clasificación que ya hacía `apps/worker`
antes de esa corrección (ambos casos terminan en `not_configured`). SR-11
(campo `eligibility` en `MatchResult` de `packages/sources`) no afecta a
`apps/worker`, que no importa nada de `src/matching/` de ese paquete.
Ninguna regresión encontrada.

---

## 7. Nota metodológica

Los 9 escenarios adversariales propios (WK-02 x4, WK-03 x4, WK-04 x1,
WK-08 x1, WK-09 x1, WK-10 x6 — algunos archivos cubren más de un
sub-escenario) se ejecutaron en
`git worktree add <scratchpad>/reverify-worker HEAD`, nunca en el árbol
principal; el worktree fue eliminado (`git worktree remove --force`) al
finalizar. Los 5 archivos de test temporales
(`apps/worker/test/zz-reverify-*.test.ts`) nunca se commitearon y se
borraron antes de cerrar el worktree (confirmado con `git status --short`
vacío sobre `apps/worker/test/`). La única mutación de código de producción
fue la de `apps/worker/vitest.config.ts` (umbrales de cobertura, WK-11),
revertida byte a byte antes de continuar (confirmado con `git diff --stat`
vacío). No se tocó ningún archivo de `apps/api`, `packages/*` ni ningún
cambio sin commitear de otros agentes en el repo principal. Este documento
y `docs/logs/reverify-worker.log` son los únicos artefactos persistentes de
esta reverificación.
