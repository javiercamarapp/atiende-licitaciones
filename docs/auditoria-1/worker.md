# Auditoría adversarial — apps/worker (ronda 2)

**Ámbito auditado**: `apps/worker/**` en el commit
`069f6901a4267de866cdc84f441e7005f5e697f7`
("feat(worker): apps/worker - cola de jobs, scheduler, discover_tenders y run_agent").

**Auditor**: agente Sonnet independiente, sin participación en la construcción de este
paquete. Ejecución real de: `npm install`, `typecheck`/`lint`/`test`, y **5 mutaciones
manuales** (romper SKIP LOCKED/fencing, backoff/max_attempts tras crash, dead letter,
`not_configured`, dedupe del scheduler) — todo en un `git worktree` separado
(`git worktree add <scratchpad>/audit-worker 069f690`), nunca en el árbol principal. El
worktree fue eliminado (`git worktree remove --force`) al terminar; ningún archivo de
prueba adversarial quedó commiteado.

**Comandos y salida completa**: `docs/logs/audit-worker-ronda2.log`.

---

## Resumen ejecutivo

`apps/worker` es honesto en su documentación: el README declara explícitamente sus
límites (enum `source_run_status` angosto, sin `jobKey` único, sin estado `cancelled`,
sin `worker_role`, cliente de ingesta duplicado a mano, `run_agent` sin persistencia de
`tool_calls`, OpenAI no ejercitado) y ninguno de esos pendientes aparece marcado como
"hecho" en `docs/ACEPTACION.md` (A1-A4 siguen `PENDIENTE`) ni en `docs/PROGRESO.md`
("Pendientes honestos"). La reproducibilidad es perfecta: 6 archivos / 36 pruebas en
verde, typecheck/lint limpios, igual que `docs/logs/worker-ronda2.log`.

Sin embargo, la auditoría adversarial (4 mutaciones propias con evidencia empírica
reproducible + 1 mutación sobre la suite oficial) encontró **fallas reales de
comportamiento, no solo teóricas, en exactamente las áreas de "tolerancia cero" que pide
el encargo** (concurrencia, honestidad de ingesta, dedupe del scheduler):

- **`max_attempts` NO se respeta si el proceso worker muere a mitad de un job** (crash,
  OOM-kill, SIGKILL): `claim()` incrementa `attempts` en cada reclamo por lease expirado
  sin comparar contra `max_attempts` — solo `fail()` (llamado desde el `catch` de
  `Worker.process()`, que un crash real nunca ejecuta) decide el dead-letter. Confirmado
  con una prueba propia: un job con `maxAttempts=3` llegó a `attempts=6`, estado
  `running` para siempre, tras 6 "crashes" simulados (ver WK-01).
- **No hay fencing token**: si el lease de un job expira mientras el worker original
  sigue vivo (heartbeat lento/perdido), otro worker reclama el MISMO job y ambos pueden
  ejecutar el handler con efectos secundarios reales (p. ej. dos POST a
  `apps/api`), sin que ninguno se entere — `Worker.process()` descarta el valor de
  retorno de `heartbeat()` con un `.catch()` fire-and-forget. Confirmado con una prueba
  propia (doble reclamo real, `heartbeat()` retorna `false` pero se ignora) (ver WK-02).
- **`discover_tenders` no registra `source_runs` cuando el envío a `apps/api` falla
  después de un `discover()` exitoso** — viola literalmente el contrato que el propio
  handler documenta ("Registra SIEMPRE una fila en `source_runs`... incluso si el job
  termina en error"). Confirmado empíricamente: `0` filas en `source_runs` tras una
  ingesta fallida con datos ya descubiertos (ver WK-03). Esto es justo el antipatrón de
  silencio que REQ-148/REQ-149 prohíben.
- **El `Scheduler` NO deduplica bajo dos procesos worker concurrentes** — que es
  precisamente el modo de escalar horizontalmente que el propio README recomienda ("cada
  uno con su propio `WORKER_ID`"). `enqueue()` hace lectura-luego-inserción sin
  transacción/bloqueo y no hay índice único `(kind, jobKey)`. Confirmado 5/5 veces:
  dos `Scheduler` sobre la misma ventana producen 2 jobs `discover_tenders` duplicados
  para la misma fuente, contradiciendo la garantía documentada de unicidad por
  `(tipo, fuente, ventana)` (ver WK-04).

Por el lado positivo, el reclamo atómico (`SKIP LOCKED`), el backoff exponencial acotado,
el dead-letter con conservación de error, el reloj inyectable, el cierre ordenado
(SIGTERM/doble señal), el cliente de ingesta (reintentos 5xx, no-reintento en 401/403,
timeout+abort) y la honestidad de A4 (fuente no verificada → `not_configured` explícito,
nunca "0 nuevas" silencioso) están bien implementados y bien probados — ver "Comprobado
correcto".

---

## 1. Reproducibilidad

Reproducido en worktree limpio (`npm install`, 641 paquetes añadidos):

```
npm run -w apps/worker typecheck   -> OK (tsc --noEmit sin salida)
npm run -w apps/worker lint        -> OK (eslint src test sin salida)
npm run -w apps/worker test        -> 6 archivos / 36 tests OK
```

Idéntico a `docs/logs/worker-ronda2.log` (mismos 6 archivos, mismo conteo de 36 tests,
mismos nombres de test). **Veredicto: CUMPLE.**

---

## 2. Cola (`JobQueue`/`Worker`)

**Reclamo atómico**: `claim()` (`src/queue/job-queue.ts:83-106`) es una única sentencia
`UPDATE jobs SET status='running', ... WHERE id = (SELECT id FROM jobs WHERE ... FOR
UPDATE SKIP LOCKED LIMIT 1)` — patrón correcto, exclusividad verificada por el test
oficial "N workers > M jobs: cada job se reclama como máximo una vez" (`job-queue.test.ts`,
pasa). **CUMPLE** en el camino feliz (workers vivos, heartbeat funcionando).

**WK-01 (crash a mitad, `max_attempts` no respetado)**: ver tabla de hallazgos. La
misma sentencia de `claim()` reclama tanto jobs `queued` como jobs `running` con
`locked_at` vencido, e incrementa `attempts` en AMBOS casos sin comparar contra
`max_attempts`. El único lugar que compara `attempts >= maxAttempts` es `fail()`
(`job-queue.ts:134`), y `fail()` solo se invoca desde el `catch` de
`Worker.process()` — que un proceso que muere de verdad (OOM, SIGKILL, panic síncrono)
nunca ejecuta. Resultado: un job que causa crashes repetidos se re-reclama para siempre,
sin límite real, nunca llega a `dead`. **Veredicto: FALLA** (contradice el propio
comentario del código: "decide entre reprogramar... o `dead`... según `attempts >=
max_attempts`" — eso solo es cierto en el camino de excepción manejada, no en crash real).

**WK-02 (fencing token ausente, doble ejecución no detectada)**: ver tabla. La
"recuperación de lease expirado" que el README presenta como diseño deliberado
(`locked_at` + `leaseSeconds`) no tiene ningún mecanismo para que el worker despojado se
entere de que perdió el lease MIENTRAS sigue ejecutando el handler. `heartbeat()` sí
retorna `boolean` (`false` si ya no es dueño), pero `Worker.process()`
(`src/queue/worker.ts:110-112`) descarta ese valor:
`queue.heartbeat(job.id, workerId).catch((err) => ...)` — nunca mira el resultado exitoso.
**Veredicto: PARCIAL/FALLA** en el sentido estricto de "exclusividad real" bajo lease
expirado con worker original vivo (que es justo el escenario que el rubro pide
comprobar); el README es honesto sobre no tener `lease_until` dedicado, pero NO menciona
este gap de detección (heartbeat ignorado), que es indepediente de la falta de columna.

**Idempotencia por `jobKey` (dedupe bajo escritores concurrentes)**: `enqueue()`
(`job-queue.ts:41-69`) hace `SELECT ... WHERE kind=$1 AND payload->>'jobKey'=$2 AND
status IN ('queued','running')` y solo si no hay fila, `INSERT`. No hay transacción ni
índice único `(kind, payload->>'jobKey')` (confirmado: `packages/db/migrations/
0003_system_tables.sql` solo indexa `(status, next_run_at)` y `(org_id)`). El README
downplaya el riesgo ("en la práctica el Scheduler es la única fuente de jobKey hoy y
corre secuencialmente") — pero esa premisa es FALSA en el propio diseño de
`src/index.ts`, que arranca un `Scheduler` por proceso sin coordinación (ver rubro 4,
WK-04): el riesgo real no es bajo, es directamente reproducible. **Veredicto: FALLA**
en el supuesto que sostiene la baja severidad declarada.

**Backoff exponencial acotado**: `computeBackoffDelayMs` (`src/queue/backoff.ts`) usa
`Math.min(maxMs, base*factor^(attempt-1))` con jitter simétrico ±20%; test oficial
verifica el rango. **CUMPLE.**

**Dead letter conserva error**: confirmado por test oficial (`lastError` = 'boom-final'
tras la última falla) y por mutación propia (ver "Mutación 5/5" abajo: al desactivar la
condición `attempts >= maxAttempts` en `fail()`, el test oficial falla de inmediato).
**CUMPLE**, con la salvedad de WK-01 (el camino de crash real nunca pasa por `fail()`).

**Cancelación**: no hay estado `cancelled` propio; se reusa `dead` con `last_error`
descriptivo (`cancelado: <motivo>`) — declarado honestamente en README. **CUMPLE** dado
el alcance declarado (no hay ambigüedad: el texto del error distingue cancelación de
fallo real, aunque un consultor que solo mire `status='dead'` sin leer `last_error` no
podría distinguir un dead-letter por reintentos agotados de una cancelación explícita).

**Reloj inyectable coherente**: `claim()`/`heartbeat()`/`fail()` comparan siempre contra
`this.now()` (JS inyectable), nunca `now()` de SQL — verificado en código y en que todos
los tests usan `vi` fake timers o relojes inyectados sin necesitar avanzar el reloj real
de PGlite. **CUMPLE.**

---

## 3. Cierre ordenado (SIGTERM)

`Worker.stop()` dej a de reclamar de inmediato (incluye despertar el `sleep` del poll),
espera al job en curso hasta `shutdownTimeoutMs`, y si el handler ignora `AbortSignal`,
resuelve de todas formas sin colgar el proceso — todo confirmado por los 4 tests de
`worker-shutdown.test.ts` (incluye el caso explícito de handler terco). `stop()` es
idempotente (test oficial: llamarlo dos veces no falla). `src/index.ts` protege contra
doble señal (SIGTERM+SIGINT casi simultáneos) con la bandera `shuttingDown`.

**Observación (no un bug, matiz sobre el "cierre limpio")**: cuando el timeout se cumple
y el handler terco sigue vivo, `src/index.ts` continúa inmediatamente con
`await db.close()` seguido de `process.exit(0)` (líneas 65-68). Esto significa que el
job terco no solo "sigue corriendo en segundo plano" como dice el README — el proceso
completo termina (`process.exit(0)`), así que en la práctica el handler terco NUNCA llega
a completar ni a liberar su lock: el job queda `running` con lock stale hasta que otro
proceso lo recupere por lease expirado (que retoma el problema de WK-01/WK-02 si ese
job vuelve a crashear/tardar). El README no documenta esta interacción específica
(`db.close()`+`process.exit(0)` truncando al handler terco), aunque el resultado neto
(no colgarse) es el comportamiento buscado. **Veredicto: CUMPLE** el objetivo declarado
("nunca cuelga el apagado"), con una nota de precisión documental menor.

---

## 4. Scheduler

**WK-04 (dedupe falla bajo 2 procesos concurrentes)** — ver Resumen ejecutivo y tabla.
Confirmado 5/5 veces con dos instancias de `Scheduler`/`JobQueue` (mismo reloj, misma
DB) llamando `tick()` con `Promise.all`: ambas reportan `enqueued: 1` para la misma
fuente+ventana, resultando en 2 jobs `discover_tenders` en la tabla en vez de 1. Esto
reproduce exactamente el escenario de dos procesos `apps/worker` en producción (el modo
de escalado horizontal que el propio README recomienda, `src/index.ts:53` arranca un
`Scheduler` por proceso sin leader-election). **Veredicto: FALLA** frente a la garantía
documentada ("nunca produce un segundo job mientras el primero siga activo") y frente a
REQ-146/REQ-150 en el escenario de múltiples procesos.

**Cambio de cadencia en caliente**: `loadScheduleConfig()` lee `WORKER_SCHEDULE_JSON` una
sola vez al arrancar `main()` (`src/index.ts:53`); no hay recarga en caliente ni
suscripción a cambios — cambiar la cadencia de una fuente requiere reiniciar el proceso.
No documentado explícitamente como pendiente (el README solo declara pendiente el
soporte de cron real, no la recarga en caliente de intervalos). **Veredicto: PARCIAL**
(funcional pero con un pendiente no declarado).

**Ventanas TZ America/Mexico_City vs UTC**: la ventana se calcula con
`Math.floor(now.getTime()/intervalMs)*intervalMs` — aritmética sobre epoch ms, agnóstica
de zona horaria por diseño (correcto: no hay conversión de TZ que pueda fallar aquí,
a diferencia de lo encontrado en `packages/sources` para fechas de convocatoria). Todas
las columnas usadas (`next_run_at`, `started_at`, etc.) son `timestamptz`, TZ-agnósticas
en almacenamiento. **CUMPLE.**

**Fuente deshabilitada**: `config.enabled === false` se salta explícitamente antes de
encolar — test oficial lo confirma (0 jobs). **CUMPLE.**

---

## 5. Honestidad de ingesta (A4) y cliente HTTP

**A4 — `verified:false` → `not_configured`**: confirmado en código
(`discover-tenders.ts:128-143`) y por 3 tests oficiales dedicados, incluyendo los 5
conectores reales de `packages/sources` (ninguno verificado hoy). Ninguna ruta observada
produce "ok" con 0 registros para una fuente NO verificada o sin conector — el único "ok"
con 0 registros ocurre para una fuente SÍ verificada sin novedades reales (test oficial
"una corrida sin registros nuevos... sí queda ok", comportamiento correcto y
diferenciado). **CUMPLE.**

**WK-03 (source_runs no se escribe si el POST de ingesta falla tras discover() exitoso)**
— ver Resumen ejecutivo y tabla. Confirmado empíricamente. **Veredicto: FALLA** frente al
contrato explícito documentado por el propio handler y frente a REQ-147/148/149
("registra SIEMPRE... incluso si el job termina en error"; "nunca se interpreta el
silencio como cero oportunidades" — aquí el silencio no es de la fuente sino de
`source_runs` mismo, que es la tabla que el back office de frescura consultaría).

**WK-05 (`coverage.obtained` engañoso en corridas fallidas)**: cuando `discover()` lanza
a mitad de la iteración, el `catch` (`discover-tenders.ts:155-167`) registra
`coverage: { obtained: tenders.length }` con los registros YA extraídos antes del error
— pero esos registros nunca se envían a `ingestClient` (el `ingest()` solo ocurre después
del `try/catch`, si no hubo excepción). Un consumidor de `source_runs.coverage` vería
"obtenido: N" en una corrida marcada como fallida, sin que esos N registros existan en
ningún lado del sistema. **Veredicto: PARCIAL** (el estado se reporta correctamente como
no-ok, pero el número de "obtenido" es engañoso).

**WK-06 (`coverage.expected` siempre `null`)**: en las 4 rutas de `recordSourceRun`
(`discover-tenders.ts`), `coverage.expected` nunca se completa. REQ-147 pide cobertura
"esperado vs. obtenido"; hoy solo existe la mitad ("obtenido"). **Veredicto: PARCIAL**
(no es un pendiente declarado en el README; el README solo declara pendiente el ANCHO del
enum de estado, no la cobertura esperado/obtenido).

**WK-07 (proyección de estados finos a `failed` pierde granularidad de contrato)**:
`toDbStatus()` (`source-run-status.ts:32-46`) colapsa `rate_limited` y `not_configured`
a `status='failed'`; el estado fino real solo vive en `evidence.fineState` (jsonb sin
schema). Confirmado con `grep -rn "source_runs\|fineState" apps/api apps/web` en el
repositorio principal (incluye cambios sin commitear de otros agentes): **hoy no existe
ningún consumidor** de esta tabla en `apps/api`/`apps/web`, así que no hay bug activo,
pero el riesgo señalado por el rubro es real y queda sin mitigar: cualquier UI/API futura
que filtre por `status = 'failed'` sin inspeccionar `evidence.fineState` no podrá
distinguir "fuente nunca verificada" (requiere acción de gobierno/verificación puntual)
de "rate limited" (transitorio) o de un fallo de red real. El README documenta el ancho
del enum como pendiente de `packages/db`, pero no advierte explícitamente este riesgo de
contrato para consumidores futuros. **Veredicto: PARCIAL** (disclosed en general, no en
el detalle de riesgo de contrato).

**Cliente de ingesta (`TenderIngestClient`)**:
- Reintentos en 5xx/429 con backoff (`RETRYABLE_STATUS`), confirmado por test con
  servidor HTTP real (`fail-then-ok`, `always-500`: agota `maxRetries+1` intentos).
  **CUMPLE.**
- 401/403 NO se reintenta, se propaga de inmediato como `IngestApiError`. Confirmado por
  test dedicado. **CUMPLE.**
- Timeout configurable vía `AbortController` + honra `signal` externo del job (cierre
  ordenado). **CUMPLE.**
- **WK-09 (sin `Idempotency-Key` de transporte)**: la cabecera enviada es solo
  `x-platform-api-key`; no existe ninguna cabecera `Idempotency-Key`/similar. La
  idempotencia real depende enteramente de que `apps/api` deduplique por contenido
  (`source, externalId, sourceVersion`), fuera del control de este cliente. El propio
  test de replay (`discover-tenders-handler.test.ts`) lo reconoce explícitamente en un
  comentario. **Veredicto: PARCIAL** (funciona hoy porque el payload es determinista
  byte-a-byte en reintentos del mismo snapshot, pero es una capa de defensa menos si el
  contrato de `apps/api` cambia).
- **Tamaño de lote**: sin límite ni paginación — todos los `tenders` descubiertos van en
  un único `POST` (`discover-tenders.ts:169-178`); solo `job.payload.limit` acota el lado
  del conector, no el tamaño del `body` HTTP. Riesgo de payloads grandes/timeouts en
  fuentes de alto volumen. No declarado en README. **Veredicto: PARCIAL** (bajo riesgo
  hoy porque ningún conector real está verificado, pero sin mitigación si cambia).
- **Fuga de API key en logs**: `grep` sobre `apps/worker/src` no encontró ningún
  `console.log`/`logger.*` que incluya `apiKey`/`platformApiKey`/el valor de la cabecera;
  los mensajes de error de `IngestApiError` incluyen el CUERPO de la respuesta de
  `apps/api` (`text`), no la clave enviada. **CUMPLE** (sin fuga de secretos propios;
  nota menor: el cuerpo de respuesta ajeno se persiste tal cual en `last_error`/logs sin
  sanitizar, aceptable dado que es contenido que `apps/api` decide devolver).

---

## 6. `run_agent`

Esqueleto declarado como tal, sin sobreclaim: `FakeProvider` por defecto,
`OpenAIResponsesProvider` real solo si `OPENAI_API_KEY` está definida — y tanto el README
de `apps/worker` como el de `packages/agents` documentan que esa ruta real NO fue
ejercitada contra la API real de OpenAI en esta ronda. `run-agent-handler.test.ts` (3
tests) solo ejercita `FakeProvider`, consistente con esa declaración. **CUMPLE** (sin
sobreclaim).

`correlationId` sí se propaga: `request.correlationId = job.id`
(`run-agent.ts:147`), igual que el `correlation_id` del logger del `Worker`
(`worker.ts:96`) — trazabilidad consistente entre logs y la corrida del agente.
**CUMPLE.**

`tool_calls` NO se persisten individualmente (solo el resultado final en `agent_runs`,
vía `updateAgentRunRow`) — declarado explícitamente como pendiente en el README
("responsabilidad de `apps/api`"). **CUMPLE** en el sentido de que es un pendiente
DECLARADO, no un hallazgo oculto; ver sin embargo WK-08 sobre el riesgo de seguridad de
esa misma función.

---

## 7. Seguridad

`apps/worker` usa `createDbClientFromEnv(process.env)` (`packages/db/src/driver.ts:119-
133`) — es decir, exactamente la cadena de `DATABASE_URL` configurada, sin ningún
`SET ROLE`/conexión de menor privilegio propia. El README lo enmarca como "conexión
propietaria de las migraciones, sin `withTenantContext`", limitando el riesgo declarado a
`jobs`/`source_runs`/`agent_runs`.

**WK-08 (el riesgo real es más amplio que el declarado)**: `packages/db/migrations/
0007_rls_functions.sql` documenta explícitamente que el rol propietario/migraciones "NO
tiene FORCE ROW LEVEL SECURITY aplicado sobre esas [tablas]" — es decir, con esa conexión
el worker puede leer/escribir SIN RLS cualquier tabla del esquema, de cualquier tenant,
no solo las 3 tablas de plataforma que el README menciona. Esto por sí solo es una
decisión de arquitectura ya usada también por el runner de migraciones (no exclusiva de
este worker), pero el README de `apps/worker` la presenta con un alcance más acotado del
que realmente tiene la conexión. Adicionalmente, `updateAgentRunRow`
(`run-agent.ts:100-112`) ejecuta `UPDATE agent_runs SET ... WHERE id = $1` sin verificar
que `job.payload.organizationId` corresponda al `organization_id` real de esa fila —
con esta conexión sin RLS, un job `run_agent` con `agentRunId`/`organizationId`
inconsistentes (por bug/dato corrupto en quien encola el job, fuera del alcance de este
worker) podría sobrescribir en silencio el resultado de la corrida de OTRO tenant sin que
ninguna capa lo impida. **Veredicto: PARCIAL** (el patrón general está declarado; el
alcance completo del riesgo y la falta de verificación cruzada en `run_agent` no lo
están).

Variables de entorno (`.env.example`): sin secretos reales por defecto, comentarios
explican el propósito y "pendiente" de rotación de `PLATFORM_API_KEY`. **CUMPLE.**

Logs con datos de tenant: `Worker.process()` solo adjunta `job_id/correlation_id/kind/
attempts` al logger hijo, nunca el `payload` completo del job (que podría incluir
`prompt`/datos de negocio en `run_agent`) — confirmado por lectura de
`src/queue/worker.ts:96,115,119,122`. **CUMPLE** (buena práctica, aunque no hay
`redact` configurado en pino por si en el futuro se agrega un log con el payload
completo).

---

## 8. Calidad de pruebas

**5 mutaciones manuales ejecutadas** (todas en worktree, ninguna commiteada):

1. **Crash a mitad / `max_attempts`**: prueba propia que simula 6 "crashes" (reclamo tras
   lease expirado, nunca `complete`/`fail`) sobre un job con `maxAttempts=3`. Resultado:
   `attempts=6`, `status='running'` — **la suite oficial NO cubre este caso** (ningún
   test de `job-queue.test.ts` simula reclamos repetidos sin `fail()`/`complete()`
   intermedios). Bug real encontrado (WK-01).
2. **Fencing/lease expirado con worker vivo**: prueba propia con dos `JobQueue`
   independientes; confirma doble reclamo real y que `heartbeat()===false` se ignora en
   `Worker.process()`. **No cubierto por la suite oficial** (el test oficial de "lease
   expirado se recupera" solo verifica que SE RECUPERA, no qué pasa con el worker
   original). Bug real encontrado (WK-02).
3. **Ingesta falla tras discover() exitoso**: prueba propia con `TenderIngestClient`
   apuntando a un puerto cerrado. Confirma `0` filas en `source_runs`. **No cubierto por
   la suite oficial** (`discover-tenders-handler.test.ts` solo prueba servidores de
   ingesta que SIEMPRE responden 200; `ingest-client.test.ts` prueba el cliente aislado,
   nunca integrado con el handler). Bug real encontrado (WK-03).
4. **Dos Scheduler concurrentes**: prueba propia con `Promise.all` sobre dos
   `Scheduler`/`JobQueue`. Confirma 2 jobs duplicados, reproducido 5/5 veces. **No
   cubierto por la suite oficial** (`scheduler.test.ts` solo llama `tick()`
   secuencialmente sobre una única instancia). Bug real encontrado (WK-04).
5. **Dead-letter (control positivo)**: se desactivó manualmente la condición
   `attempts >= maxAttempts` en `fail()` (`if (false && ...)`) — la suite oficial
   **SÍ detectó la mutación** de inmediato (`job-queue.test.ts` falla con
   `expected 'queued' to be 'dead'`). Confirma que esta regla concreta SÍ está bien
   protegida por tests (contraste positivo frente a las 4 mutaciones anteriores).

**Resultado de la mutación manual: 1 de 5 reglas detectada por la suite oficial, 4 de 5
NO detectadas** (y las 4 no detectadas corresponden a bugs reales, no falsos positivos
del auditor — ver evidencia en `docs/logs/audit-worker-ronda2.log`).

**Cobertura real**: no hay `@vitest/coverage-v8` instalado ni script `test:coverage`;
`npx vitest run --coverage` falla con `MISSING DEPENDENCY`. No es posible cuantificar
cobertura de líneas/branches, solo conteo de tests (36) + la mutación manual de esta
auditoría. **Veredicto: PARCIAL.**

**Trazabilidad REQ**: el README cita explícitamente REQ-146/147/148/150/077/016 en los
lugares correctos del código; `test/discover-tenders-handler.test.ts` referencia A1/A2/A4
de `docs/ACEPTACION.md` en sus `describe()`. No se encontró ningún pendiente declarado
marcado como "hecho" en `docs/ACEPTACION.md` (A1-A4 siguen `PENDIENTE`) ni en
`docs/PROGRESO.md`. **CUMPLE.**

---

## Tabla de hallazgos

| ID | Severidad | Rubro | Hallazgo (evidencia) | Reparación sugerida (separada, no aplicada) | Estado reparación |
|---|---|---|---|---|---|
| WK-01 | **ALTA** | 2. Cola | `claim()` (`src/queue/job-queue.ts:83-106`) incrementa `attempts` en CADA reclamo (inicial o por lease expirado) sin comparar contra `max_attempts`; solo `fail()` (invocado desde el `catch` de `Worker.process()`, nunca ejecutado si el proceso muere de verdad) decide el dead-letter. Confirmado con prueba propia: 6 "crashes" simulados sobre un job `maxAttempts=3` producen `attempts=6`, `status='running'` para siempre (nunca `dead`). Riesgo: un job que causa crashes repetidos (bug del handler, OOM, etc.) consume workers indefinidamente sin límite real. | Comparar `attempts` contra `max_attempts` también dentro del propio `UPDATE` de `claim()` (p. ej. no reclamar/marcar `dead` directamente si `attempts >= max_attempts` al momento de la recuperación por lease), o añadir un chequeo explícito post-claim que dead-letre inmediatamente jobs que ya agotaron intentos antes de ejecutar el handler de nuevo. | **HECHO** (commit `8f03444` "fix(worker): WK-01/WK-02/WK-04/WK-10/WK-12 cola de jobs"; test `test/job-queue.test.ts` "WK-01") |
| WK-02 | **ALTA** | 2. Cola / 3. Cierre | Sin fencing token: si el lease de un job expira mientras el worker original sigue vivo, otro worker lo reclama (`claim()` no distingue "lease expiró porque el proceso murió" de "lease expiró porque el heartbeat tardó/falló con el proceso vivo"). `Worker.process()` (`src/queue/worker.ts:110-112`) descarta el resultado booleano de `heartbeat()` con `.catch()` fire-and-forget, así que el worker despojado JAMÁS se entera y sigue ejecutando el handler (incluyendo efectos secundarios reales como HTTP a `apps/api`). Confirmado con prueba propia: doble reclamo real, `heartbeat()` retorna `false` pero nada lo consume. `complete()`/`fail()` del worker despojado son no-op silenciosos (protegen la DB pero no evitan la doble ejecución del handler ya en curso). | Introducir un fencing token real: `claim()` retorna una versión/generación (p. ej. columna `lease_generation` incrementada en cada claim); el handler recibe esa generación y, antes de cualquier efecto secundario irreversible (HTTP externo), verifica vía `heartbeat()` que sigue vigente; si `heartbeat()` retorna `false`, `Worker.process()` debe abortar el handler (vía el mismo `AbortSignal` que ya existe) en vez de solo loguear una advertencia. | **HECHO** (commit `8f03444`; test `test/worker-shutdown.test.ts` "WK-02") |
| WK-03 | **ALTA** | 5. Honestidad ingesta | `discover-tenders.ts:169-196`: el `try/catch` solo envuelve la iteración del conector (líneas 146-167); la llamada a `deps.ingestClient.ingest(...)` (línea 171) y el `recordSourceRun` final "ok" (línea 180) quedan FUERA de cualquier manejo de error. Si `ingest()` lanza (después de agotar sus propios reintentos en 5xx, o por 401/403, o timeout), la excepción se propaga sin que se registre NINGUNA fila en `source_runs` para esa corrida — viola el contrato documentado por el propio handler ("Registra SIEMPRE... incluso si el job termina en error") y REQ-147/148/149. Confirmado empíricamente: `source_runs` queda con `0` filas tras una corrida que sí descubrió 1 registro pero falló al ingerir. | Envolver también la llamada a `ingestClient.ingest()` en el manejo de error existente, registrando un `source_run` con `fineState` apropiado (p. ej. `down`/`failed` con `evidence.message` describiendo el fallo de ingesta, distinto del fallo de descubrimiento) antes de re-lanzar, igual que ya se hace para errores del conector. | **HECHO** (commit `d7ac83a` "fix(worker): WK-03/WK-05/WK-06 discover_tenders..."; test `test/discover-tenders-handler.test.ts` "WK-03") |
| WK-04 | **ALTA** | 4. Scheduler | `Scheduler.tick()`/`JobQueue.enqueue()` (`src/scheduler/scheduler.ts`, `src/queue/job-queue.ts:41-69`) deduplican con lectura-luego-inserción sin transacción ni índice único `(kind, payload->>'jobKey')` (confirmado: `packages/db/migrations/0003_system_tables.sql` no tiene tal índice). `src/index.ts:53` arranca un `Scheduler` por proceso sin coordinación entre procesos, exactamente el modo de escalado horizontal que el README recomienda. Confirmado 5/5 veces con dos `Scheduler` concurrentes (`Promise.all`) sobre la misma ventana: ambos reportan `enqueued:1`, resultando en 2 jobs `discover_tenders` duplicados para la misma fuente+ventana — contradice la garantía documentada de unicidad y el supuesto del README ("el Scheduler... corre secuencialmente", falso con >1 proceso). | Migración futura (fuera de alcance de `packages/db` en esta ronda, pero recomendación directa): índice único parcial `(kind, (payload->>'jobKey')) WHERE status IN ('queued','running')` + `enqueue()` usando `INSERT ... ON CONFLICT DO NOTHING RETURNING *` (o capturar la violación de unicidad) en vez de SELECT-luego-INSERT. Mientras tanto, documentar en el README que el escalado horizontal con más de un proceso SÍ puede duplicar jobs del scheduler (corrige la afirmación actual de "riesgo real bajo"). | **HECHO** mitigación funcional (advisory lock transaccional, commit `8f03444`; test `test/scheduler.test.ts` "WK-04", 2 procesos x 20 iteraciones sin duplicados) + **PENDIENTE esquema** índice único parcial (propuesta `db-proposals/PROPOSAL-02-jobs-dedupe-and-cancelled.sql`, commit `21aadef`) |
| WK-05 | MEDIA | 5. Honestidad ingesta | `discover-tenders.ts:155-166`: en el `catch` de un fallo de `discover()` a mitad de iteración, `coverage: { obtained: tenders.length }` reporta los registros YA EXTRAÍDOS antes del error, pero esos registros nunca llegan a `ingestClient.ingest()` (que solo se invoca si el `try` completó sin excepción). Un consumidor de `source_runs.coverage` vería "obtenido: N>0" en una corrida marcada como fallida, sin que esos N registros existan en ningún otro lugar del sistema (ni `tenders`, ni logs de éxito). | Distinguir en `evidence`/`coverage` "extraído localmente antes del fallo" de "efectivamente enviado/persistido"; o reintentar el envío de los registros ya extraídos antes de reportar el fallo total, si el fallo fue solo del resto de la iteración. | **HECHO** (commit `d7ac83a`; test `test/discover-tenders-handler.test.ts` "WK-05") |
| WK-06 | MEDIA | 5. Honestidad ingesta | `coverage.expected` es SIEMPRE `null` en las 4 rutas de `recordSourceRun` de `discover-tenders.ts` (éxito y los 3 casos de error). REQ-147 exige cobertura "esperado vs. obtenido"; hoy solo existe la mitad ("obtenido"), en todos los escenarios, no solo en los declarados como pendientes por el README. | Poblar `coverage.expected` cuando el conector/fuente declare un total esperado (p. ej. de un header de paginación o de un conteo previo), o documentar explícitamente en README que "expected" queda pendiente de forma honesta (hoy no se menciona). | **HECHO** (commit `d7ac83a`; test `test/discover-tenders-handler.test.ts` "WK-06") |
| WK-07 | MEDIA | 5. Honestidad ingesta / contrato con packages/db | `toDbStatus()` (`source-run-status.ts:32-46`) proyecta `not_configured` y `rate_limited` a `status='failed'`; el detalle real solo vive en `evidence.fineState` (jsonb sin schema). Verificado con `grep` en el repo principal: hoy ningún código de `apps/api`/`apps/web` lee `source_runs`/`fineState`, así que no hay bug activo, pero cualquier consumidor futuro que filtre por `status='failed'` sin inspeccionar `evidence.fineState` perderá la distinción entre "nunca verificado" (acción de gobierno) y "limitado por tasa"/"fallo real" (transitorio/operativo). | Antes de construir la UI de back office que consuma esta tabla (REQ-148/149), o bien ampliar el enum `source_run_status` (recomendación ya presente en el README) o documentar explícitamente en el contrato de API/back office que `status` NUNCA debe leerse sin `evidence.fineState` quando `status='failed'`. | **PENDIENTE esquema** (propuesta `db-proposals/PROPOSAL-01-widen-source-run-status.sql`, commit `21aadef`); mitigación parcial en código: nuevo estado fino `ingest_failed` para WK-03 ya distingue ese caso (commit `d7ac83a`) |
| WK-08 | MEDIA | 7. Seguridad | La conexión "propietaria" del worker (`createDbClientFromEnv`) no tiene `FORCE ROW LEVEL SECURITY` en NINGUNA tabla (confirmado en `packages/db/migrations/0007_rls_functions.sql`), por lo que el alcance real de acceso sin RLS es TODO el esquema (todos los tenants, todas las tablas), no solo `jobs`/`source_runs`/`agent_runs` como sugiere la sección "Seguridad" del README. Además, `updateAgentRunRow` (`run-agent.ts:100-112`) hace `UPDATE agent_runs SET ... WHERE id = $1` sin verificar que `job.payload.organizationId` coincida con el `organization_id` real de esa fila; con esta conexión sin RLS, un job `run_agent` con datos de payload inconsistentes podría sobrescribir en silencio el resultado de la corrida de OTRO tenant. | Documentar el alcance REAL de la conexión (todo el esquema, no solo 3 tablas) mientras no exista `worker_role` dedicado (ya recomendado en README); en el corto plazo, añadir una verificación `WHERE id = $1 AND organization_id = $2` (o un `SELECT` previo que compare) en `updateAgentRunRow` como defensa en profundidad, incluso con la conexión sin RLS. | **HECHO** defensa en profundidad en código (filtro `org_id` explícito + `set_config`, commit `a545298`; test `test/run-agent-handler.test.ts` "WK-08") + **PENDIENTE esquema** `worker_role` dedicado (propuesta `db-proposals/PROPOSAL-03-worker-role.sql`, commit `21aadef`) |
| WK-09 | BAJA | 5. Honestidad ingesta | `TenderIngestClient.ingest()` no envía ninguna cabecera `Idempotency-Key`/equivalente de transporte; la idempotencia depende enteramente de que `apps/api` deduplique por contenido (`source, externalId, sourceVersion`). Riesgo bajo hoy (el payload es determinista byte-a-byte en reintentos del mismo snapshot, confirmado por test), pero es una capa de defensa menos si el contrato de deduplicación de `apps/api` cambiara. | Añadir una cabecera `Idempotency-Key` derivada determinísticamente del lote (p. ej. hash de `sourceId + ventana + lista ordenada de sourceVersion`), independiente de la deduplicación por contenido de `apps/api`. | **HECHO** (commit `a1437cc` "fix(worker): WK-09 Idempotency-Key en TenderIngestClient"; test `test/ingest-client.test.ts` "WK-09") |
| WK-10 | BAJA | 2. Cola / 5. Ingesta | `NotConfiguredError` (fuente sin conector o sin `liveVerification.verified`) se trata igual que cualquier error transitorio: se reprograma con backoff exponencial hasta agotar `max_attempts` antes de caer a `dead`. Estos son errores PERMANENTES (no cambian hasta una verificación humana explícita), así que los reintentos son puro desperdicio de capacidad de worker. | Distinguir en el handler errores permanentes (`NotConfiguredError`) de transitorios, y para los permanentes usar un `maxAttempts` bajo (p. ej. 1) o marcar directamente `dead` sin pasar por el ciclo completo de backoff. | **HECHO** (commit `8f03444`; test `test/worker-shutdown.test.ts`/`test/job-queue.test.ts` "WK-10") |
| WK-11 | BAJA | 8. Calidad de pruebas | No hay `@vitest/coverage-v8` instalado ni script `test:coverage`; `npx vitest run --coverage` falla con `MISSING DEPENDENCY`. No es posible cuantificar cobertura de líneas/branches más allá del conteo de 36 tests y la mutación manual de esta auditoría. | Agregar `@vitest/coverage-v8` y un script `test:coverage` con umbral mínimo, igual que se recomendó para `packages/sources` (ver `docs/auditoria-1/sources.md`, SR-08). | **HECHO** (commit `1b656a3` "fix(worker): WK-11 vitest --coverage con umbrales"; cobertura real 92.75% líneas / 80.53% ramas, ver `docs/logs/fix-worker-ronda2.log`) |
| WK-12 | BAJA | 2. Cola (higiene) | El tipo `JobStatus` (`src/queue/types.ts:2`) incluye `'failed'`, pero ningún código de `job-queue.ts` asigna jamás ese valor (solo usa `'queued'`, `'running'`, `'succeeded'`, `'dead'`). Un job que falló y está pendiente de reintento queda en `'queued'`, indistinguible a primera vista (sin mirar `attempts`/`last_error`) de un job recién creado. | Documentar en el propio tipo por qué `'failed'` nunca se usa desde `apps/worker` (el enum de DB lo define pero el diseño de reintentos de este worker no lo necesita), o eliminar el valor del tipo si es confirmado como muerto en todo el monorepo. | **HECHO** (commit `8f03444`; documentado en `src/queue/types.ts`) |
| WK-13 | **ALTA** (regresión) | 6. run_agent / dependencia packages/agents | Origen: re-verificación de `packages/agents` (`docs/auditoria-1/agents-reverificacion.md`). El commit `480d183` (`fix(agents): AG-05 declaredEffects obligatorio y consistente con riskLevel`) volvió `declaredEffects` un campo OBLIGATORIO de `ToolDefinition` (`packages/agents/src/tool-registry.ts`). `apps/worker/src/handlers/run-agent.ts` registraba la herramienta de demostración `llm_complete` sin ese campo, así que `npm run -w apps/worker typecheck`/`build` rompían (`TS2345: Property 'declaredEffects' is missing`) y 3/36 tests de `apps/worker` fallaban en cascada (cualquier test que importe `run-agent.ts`, que a su vez es importado por `src/index.ts` y por `test/run-agent-handler.test.ts`). | Declarar `declaredEffects: ['read_only']` en el registro de `llm_complete` (coherente con `riskLevel: 'read'`/`actionKind: 'read'`: la herramienta solo pasa un prompt al proveedor y regresa texto, sin escritura ni efecto externo real). | **HECHO** (commit `fix(worker): WK-13 declaredEffects obligatorio en tools de run_agent`) |

---

## Comprobado correcto

- **Reproducibilidad exacta**: 6 archivos / 36 pruebas en verde, typecheck/lint limpios,
  igual que `docs/logs/worker-ronda2.log` (§1).
- **Reclamo atómico exclusivo en el camino feliz**: `UPDATE ... WHERE id = (SELECT ...
  FOR UPDATE SKIP LOCKED LIMIT 1)` en una sola sentencia; test oficial "N workers > M
  jobs" confirma cero reclamos duplicados cuando los workers están vivos y hacen
  heartbeat normalmente (§2).
- **Backoff exponencial acotado con jitter simétrico**: `computeBackoffDelayMs` respeta
  `maxMs`, jitter ±20% verificado por test oficial y por lectura de código (§2).
- **Dead letter conserva el último error**: confirmado por test oficial Y por mutación
  propia (desactivar la condición de dead-letter rompe el test oficial de inmediato,
  "Mutación 5/5") (§2, §8).
- **Reloj inyectable coherente**: `claim()`/`heartbeat()`/`fail()` usan siempre
  `this.now()` (JS), nunca `now()` de SQL — verificado en código; permite pruebas
  deterministas con fake timers (§2).
- **A4 — honestidad de fuente no verificada**: los 5 conectores reales, todos con
  `liveVerification.verified=false` hoy, producen `not_configured` explícito, NUNCA "ok"
  con "0 nuevas" — confirmado en código y por 3 tests oficiales dedicados (§5).
- **Cliente de ingesta — reintentos y clasificación de errores**: reintenta 429/5xx con
  backoff (confirmado con servidor HTTP real, no mock de `fetch`); NO reintenta 401/403
  (propagación inmediata); honra timeout y `AbortSignal` externo — 6/6 tests dedicados,
  todos contra un servidor `node:http` real (§5).
- **Sin fuga de API keys en logs del worker**: `grep` sobre `apps/worker/src` no
  encontró ningún log que incluya el valor de `apiKey`/`platformApiKey`; el logger hijo
  del `Worker` solo adjunta `job_id/correlation_id/kind/attempts`, nunca el `payload`
  completo del job (§5, §7).
- **Cierre ordenado (SIGTERM)**: deja de reclamar de inmediato (incluso despertando un
  `sleep` en curso), espera al job actual hasta el timeout, resuelve sin colgarse si el
  handler ignora `AbortSignal`, es idempotente ante `stop()` doble, y `src/index.ts`
  protege contra doble señal (SIGTERM+SIGINT) con una bandera — 4/4 tests oficiales
  dedicados, incluyendo el caso explícito de handler terco (§3).
- **`run_agent` sin sobreclaim**: `FakeProvider` por defecto, `OpenAIResponsesProvider`
  real solo con `OPENAI_API_KEY`, y tanto el README de `apps/worker` como el de
  `packages/agents` declaran honestamente que esa ruta real no fue ejercitada con
  credenciales de producción; `correlationId` se propaga consistentemente
  (`job.id` = `correlationId` = `correlation_id` del logger) (§6).
- **Ventanas del scheduler correctas frente a TZ**: el cálculo de ventana usa aritmética
  de epoch ms (agnóstica de zona horaria por diseño), y todas las columnas de tiempo
  relevantes son `timestamptz` — no se encontró ningún caso de doble conversión o
  interpretación local incorrecta, a diferencia de lo hallado en `packages/sources` para
  fechas de convocatoria (§4).
- **Ningún pendiente declarado aparece marcado como "hecho"**: `docs/ACEPTACION.md`
  mantiene A1-A4 en `PENDIENTE` pese a que existen tests que los ejercitan;
  `docs/PROGRESO.md` (ronda 2, `069f690`) lista explícitamente los mismos pendientes que
  el README de `apps/worker`, bajo el título honesto "Pendientes honestos" (§8).

---

## Nota metodológica

Las 5 mutaciones y la reproducción de `typecheck`/`lint`/`test` se ejecutaron en
`git worktree add <scratchpad>/audit-worker 069f690`, nunca en el árbol principal; el
worktree fue eliminado (`git worktree remove --force`) al finalizar. Los 4 archivos de
prueba adversarial creados (`test/zz-audit-*.test.ts`) nunca se commitearon y se
eliminaron junto con el worktree; la quinta mutación (dead-letter) modificó
temporalmente `src/queue/job-queue.ts` dentro del worktree y se revirtió byte a byte
antes de continuar (confirmado con `git diff` vacío tras revertir). No se tocó ningún
archivo de `apps/api`, `packages/*` ni ningún cambio sin commitear de otros agentes; el
único `grep` cruzado a `apps/api`/`apps/web` (para WK-07) fue de solo lectura. Este
documento y `docs/logs/audit-worker-ronda2.log` son los únicos artefactos persistentes de
esta auditoría.
