# Re-verificación adversarial 2 (cierre) — apps/worker

**Ámbito**: la columna "Estado reparación" de `docs/auditoria-1/worker.md` para
WK-14..WK-18 (commits `ab5fa95`, `95f3a03`, `e9879f3`+`521b321`, `b6b879f`,
`7ab874c`) y las migraciones `packages/db/migrations/0026-0028` (+`0026b`) que
incorporan las 3 propuestas de `apps/worker/db-proposals/`.

**Reverificador**: agente Sonnet independiente (vuelta 2, cierre), sin
participación en la construcción ni en reparaciones previas de este paquete.
Ejecución real de `npm install`, `typecheck`/`lint`/`test`/`test:coverage`,
verificación de ancestría y `git show --stat` de los 7 commits citados, y
**18 escenarios/ataques adversariales propios** (archivos temporales
`apps/worker/test/zz-reverify2-*.test.ts`, nunca commiteados, borrados al
terminar) — todo en `git worktree add <scratchpad>/reverify2-worker HEAD`
(HEAD `c96484a`), nunca en el árbol principal. El worktree fue eliminado
(`git worktree remove --force`) al finalizar.

**Comandos y salida completa**: `docs/logs/reverify2-worker.log`.

---

## Resumen ejecutivo

Los **7 commits** citados en la nota de `worker-reverificacion.md` §1 son
ancestros reales de HEAD y sus `git show --stat` coinciden con lo declarado.
La suite oficial reproduce exactamente **79 tests / 6 skip** (8 archivos +
3 `.pending.test.ts`), typecheck/lint limpios, cobertura real
**90.41% líneas / 82.23% ramas** (umbral 85/80 — el agregado pasa el gate,
confirmado con `exit=0`). Regresión cruzada limpia: `packages/sources`,
`packages/agents` y `packages/db` typecheck sin salida.

Los **4 fixes de WK-14/16/17 resisten los ataques adicionales** pedidos por
el encargo — no se encontró ninguna forma de revertirlos:

- **WK-14 (fencing por lease token)**: 4/4 ataques fallan contra la
  protección — zombie con token viejo tras que B reclamó (heartbeat/
  complete/fail/deadLetterPermanent, los 4 rechazados sin persistir);
  mismo `workerId` reutilizado tras "reinicio" (tokens distintos, rechazo
  cruzado); job vuelto a `queued` tras `fail()` de B y A con token viejo
  intentando `complete()` (rechazado, el job permanece `queued`); y
  `workerId` con `::` propio (`pod::region-us::7`) no rompe nada porque
  `locked_by` **nunca se parsea**, solo se compara por igualdad exacta de
  cadena completa — un atacante que solo conozca el `workerId` (sin el UUID)
  no puede tocar el job. Los logs (`Worker.process()` → `childLogger`) **no
  exponen el token de lease** en ningún punto (`worker_id` sí se loguea,
  `lockedBy`/el UUID nunca).
- **WK-16 (organizationId fail-closed)**: `0`, `false`, `null`, `undefined`,
  `''` activan correctamente el guard (`!organizationId`) y lanzan
  `RunAgentMissingOrganizationError` ANTES de tocar `agent_runs` — la fila
  real nunca queda `succeeded`. `'  '` (solo espacios) y un objeto `{}`
  **bypasan el guard** (ambos son *truthy* en JS) pero **no logran corromper
  la fila real**: Postgres rechaza el cast a `uuid`
  (`invalid input syntax for type uuid`) y la fila del tenant queda
  intacta (`status` nunca pasa a `succeeded`). Es un hallazgo nuevo
  (ver WK-19 abajo) de robustez/DoS, **no** de seguridad cross-tenant.
- **WK-17 (408/425 transitorios)**: barrido completo de los 200 códigos
  400-599 (no solo la muestra de 12 del test oficial) confirma la
  invariante `retryable && permanent` nunca ambos `true`. Se encontró una
  **zona gris real de 96 códigos** (501 y 505-599, fuera de
  `RETRYABLE_STATUS` pero también fuera de `[400,500)`): ni retryable ni
  permanent — el `Worker` los trata como error transitorio genérico
  (`fail()` con backoff normal), nunca como permanente. No es una regresión
  de WK-17 (esos códigos ya estaban así antes de esa ronda), es un hallazgo
  nuevo (WK-20). También se confirmó que **HTTP 407** hace que el runtime
  `fetch` de Node (undici) lance un error de RED (`TypeError: fetch failed`)
  en vez de entregar un `Response`, así que ese código nunca llega a la rama
  de clasificación por status — cae en la rama de red genérica (retryable,
  no permanente): comportamiento correcto por accidente, documentado como
  WK-21. ECONNRESET, timeout (servidor que nunca responde), DNS
  (`ENOTFOUND`) y `abort()` externo se comportan todos correctamente
  (transitorio, no cuelga el proceso, se propaga como `IngestApiError`).

**Hallazgo significativo nuevo (WK-22, ALTA)**: se ejecutaron los cuerpos
REALES descritos en los 3 `.pending.test.ts` (no solo quitar `.skip`, que
dejaría pasar trivialmente tests vacíos) contra `createMigratedDb()`, que ya
aplica 0026-0028. **2 de 3 propuestas tienen el ESQUEMA listo pero el CÓDIGO
de aplicación nunca se actualizó para usarlo**:

- `toDbStatus()` (`source-run-status.ts`) sigue proyectando
  `rate_limited`/`not_configured`/`ingest_failed` → `'failed'`, pese a que
  el enum real ya tiene esos 3 valores desde 0026. `recordSourceRun(...,
  fineState:'rate_limited')` persiste `status='failed'`, NO `'rate_limited'`
  (confirmado, el test falla).
- `JobQueue.cancel()` sigue escribiendo `status='dead'` con
  `last_error='cancelado: ...'`, pese a que `'cancelled'` existe en el enum
  `job_status` desde 0027. El test falla igual: `cancelled().status ===
  'dead'`, no `'cancelled'`.
- El índice único (`ux_jobs_kind_jobkey_active`) SÍ existe y SÍ protege (un
  `INSERT` directo duplicado, sin pasar por `enqueue()`, lanza `23505`); el
  código de `enqueue()` sigue usando advisory lock + SELECT-luego-INSERT,
  NUNCA `ON CONFLICT` — coexisten sin contradecirse (el índice es una
  defensa en profundidad adicional), pero la simplificación que la propia
  migración 0027 sugería en su comentario nunca se aplicó.

**Conclusión sobre los `.pending.test.ts`**: NO deben activarse tal cual
(pasarían trivialmente por estar vacíos, y si se les da contenido real, 2 de
3 fallan hoy). Documentan correctamente una intención que requiere trabajo
de código adicional en `apps/worker` (actualizar `toDbStatus()` y
`JobQueue.cancel()`) antes de poder cerrarse en verde — WK-07 y la mitad de
WK-04 deben permanecer PENDIENTE_ESQUEMA/PARCIAL, con la precisión de que
ahora es "pendiente de código", no "pendiente de esquema" (el esquema ya
está).

**Hallazgo nuevo más importante de esta ronda (WK-23, ALTA, forward-looking)**:
se probó la RLS real de `worker_role` (PROPOSAL-03) contra `agent_runs`
combinada con el código EXACTO que hoy escribe `updateAgentRunRow()`
(`run-agent.ts`): fija `app.current_org_id` pero **nunca**
`app.current_user_id`. La política RLS de `agent_runs` (heredada de
`app.apply_org_rls`, 0007/0008) exige `org_id = current_org_id() AND
has_role(org_id, write_roles)`, y `has_role` depende de
`app.current_user_id()`. Confirmado con `SET LOCAL ROLE worker_role` (que sí
funciona en PGlite sin necesitar una conexión autenticada nueva, contrario a
lo asumido en la reverificación anterior): con `org_id` CORRECTO pero sin
`current_user_id`, el `UPDATE` real de una fila LEGÍTIMA del tenant correcto
devuelve `rowCount=0` — **RLS bloquearía toda actualización de `agent_runs`,
incluida la correcta**, el día que `apps/worker` adopte `worker_role`. El
código actual interpretaría ese `rowCount=0` como `AgentRunOrgMismatchError`
("otro tenant"), un falso positivo que rompería `run_agent` por completo. Con
`org_id` Y `current_user_id` (del actor real de la corrida) correctos, sí
funciona. Este es un gap de integración entre dos correcciones
independientemente cerradas (WK-08 código + PROPOSAL-03 esquema) que nunca
se probaron juntas hasta ahora.

---

## 1. Ancestría y `git show --stat`

| Commit | Mensaje | Archivos | Ancestro de HEAD |
|---|---|---|---|
| `ab5fa95` | fix(worker): WK-14 fencing real por lease token | `errors.ts`, `job-queue.ts`, `worker.ts`, `test/job-queue.test.ts`, `test/worker-shutdown.test.ts` (5 archivos, +334/-96) | OK |
| `95f3a03` | fix(worker): WK-16 fail-closed en run_agent | `run-agent.ts`, `test/run-agent-handler.test.ts` (2 archivos, +118/-4) | OK |
| `e9879f3` | fix(worker): WK-17 408/425 transitorios | `ingest-client.ts`, `test/ingest-client.test.ts` (2 archivos, +97/-2) | OK |
| `521b321` | fix(worker): typecheck tabla WK-17 | `test/ingest-client.test.ts` (1 archivo, +1/-1) | OK |
| `b6b879f` | docs(worker): WK-15 honestidad concurrencia | `README.md`, `test/scheduler.test.ts` (2 archivos, +176/-25) | OK |
| `7ab874c` | docs(worker): PROPOSAL-02 riesgos despliegue | `PROPOSAL-02*.sql`, `*.pending.test.ts` (2 archivos, +120/-8) | OK |
| `d88d334` | docs(worker): columna Estado reparación ronda 3 | `worker-reverificacion.md`, `docs/logs/fix-worker-ronda3.log` (2 archivos, +255/-7) | OK |

Los 7 son ancestros reales de HEAD (`git merge-base --is-ancestor`, todos
`OK`), y sus archivos modificados coinciden exactamente con lo declarado en
`docs/auditoria-1/worker-reverificacion.md`. HEAD verificado: `c96484a`
(commits posteriores en el repo principal, de otros agentes trabajando en
paralelo, tocan `apps/api`/`apps/web`/`packages/db` migraciones nuevas
(`0033`) sin relación con `apps/worker`; confirmado con
`git log c96484a..HEAD -- apps/worker` vacío).

---

## 2. Reproducibilidad

```
npm run -w apps/worker typecheck   -> OK
npm run -w apps/worker lint        -> OK
npm run -w apps/worker test        -> 8 archivos / 79 tests OK, 3 archivos / 6 tests skip (db-proposals/*.pending.test.ts)
npm run -w apps/worker test:coverage -> 90.41% líneas / 82.23% ramas / 81.42% funciones (umbral 85/80, exit=0)
npm run -w packages/sources typecheck -> OK
npm run -w packages/agents typecheck  -> OK
npm run -w packages/db typecheck      -> OK
```

Idéntico en conteo a lo declarado en `worker-reverificacion.md` §1 (79
tests/6 skip). Ver `docs/logs/reverify2-worker.log` para la salida completa.

---

## 3. Ataques finales por hallazgo

### WK-14 — fencing por lease token

4 escenarios, los 4 confirman que el fix resiste:

1. **Zombie con token viejo tras reclamo de B**: `heartbeat()` retorna
   `false`; `complete()`/`fail()`/`deadLetterPermanent()` con el token de A
   lanzan `StaleLeaseError` en los 3 casos, **sin persistir ningún cambio**
   (`status`/`lockedBy`/`lastError` de la fila permanecen los de B en todo
   momento). B, con su token real, sí puede completar.
2. **A y B con el MISMO `workerId`** (simulación de reinicio con
   `WORKER_ID` estático, patrón recomendado por el propio README): los
   tokens (`${workerId}::${uuid}`) son distintos porque el UUID es aleatorio
   por `claim()`; el zombie de la generación 1 es rechazado al intentar
   `complete()` sobre el job de la generación 2.
3. **Job vuelto a `queued` tras `fail()` de B; A (token viejo, de ANTES de
   que B reclamara) intenta `complete()`**: rechazado (`StaleLeaseError`),
   el job permanece `queued` esperando su reintento normal, sin que A pueda
   marcarlo `succeeded` por error.
4. **`workerId` con `::` propio** (`pod::region-us::7`, un nombre de pod de
   Kubernetes realista podría incluir separadores): el fencing sigue siendo
   robusto porque `locked_by` **nunca se parsea/divide** en ningún punto del
   código (confirmado por lectura de `job-queue.ts`/`worker.ts`/`errors.ts`
   completos) — la comparación es SIEMPRE por igualdad de cadena exacta
   contra el valor devuelto por `claim()`. Un atacante que conozca el
   `workerId` pero no el UUID del token no puede completar/fallar el job.

**Logs**: `childLogger` (`Worker.process()`) solo adjunta
`job_id/correlation_id/kind/attempts/worker_id` — el token de lease
(`leaseToken`/`job.lockedBy`, con el UUID) **nunca aparece en ningún
`logger.info/warn/error`** del archivo. Confirmado por `grep` dirigido sobre
`src/queue/worker.ts`. **Sin fuga.**

**Veredicto: WK-14 CONFIRMADO CERRADO**, sin nuevos gaps.

### WK-16 — organizationId fail-closed

5 escenarios (los pedidos explícitamente: `"  "`, `0`, `false`, objeto, y el
caso de `discover_tenders` sin org):

- `0`, `false`: el guard `!job.payload.organizationId` los captura
  correctamente (ambos son *falsy* en JS) → `RunAgentMissingOrganizationError`
  ANTES de tocar `agent_runs`. Fila real intacta.
- `"  "` (espacios) y `{ maliciously: 'crafted' }` (objeto): **ambos son
  *truthy*** en JS, así que **bypasan el guard fail-closed** — llegan hasta
  el `UPDATE agent_runs ... where id=$1 and org_id=$5::uuid`. Postgres
  rechaza el cast (`invalid input syntax for type uuid: "  "` /
  `"[object Object]"`), lanzando una excepción **genérica** (no
  `AgentRunOrgMismatchError`, no marcada `permanent`). La fila real
  **nunca queda `succeeded`** (no hay corrupción cross-tenant), pero el
  job se clasifica como error transitorio y se reintenta con backoff
  normal hasta agotar `max_attempts` — desperdicio de reintentos en vez de
  un fallo rápido y explícito. **Nuevo hallazgo WK-19 (BAJA/MEDIA,
  robustez — no seguridad)**: el guard de WK-16 usa `!organizationId`, que
  captura `null`/`undefined`/`''`/`0`/`false` pero no captura "string no
  vacío mal formado" ni "objeto". Recomendación: validar con
  `typeof organizationId === 'string' && organizationId.trim().length > 0`
  (o un `z.string().uuid()`), no solo truthy-check.
- `discover_tenders` (job de plataforma, sin `organizationId` en absoluto):
  no aplica ningún guard de este tipo — criterio correcto por diseño
  (`jobs.org_id` es NULLABLE, es un job de plataforma sin fila de tenant
  que sobrescribir por confusión de organización; no se encontró código que
  mezcle ambos contratos). **No es un hallazgo.**

**Veredicto: WK-16 CONFIRMADO CERRADO** en su alcance declarado
(null/undefined/''); **WK-19 nuevo** documenta el borde no cubierto
(valores truthy-pero-inválidos), de severidad baja porque no hay corrupción
de datos, solo reintentos desperdiciados.

### WK-17 — clasificación transitorio/permanente por HTTP

Barrido de los 200 códigos 400-599 (no solo la muestra de 12 del test
oficial), más ECONNRESET, timeout, DNS y abort:

- Invariante `retryable && permanent` nunca ambos `true`: se cumple en los
  200 códigos.
- **Zona gris confirmada (WK-20, MEDIA, nueva)**: 501 y 505-599 (96 códigos
  en total) quedan fuera de `RETRYABLE_STATUS` (`{408,425,429,500,502,503,
  504}`) Y fuera del rango `[400,500)` que exige `.permanent`. El cliente
  NO los reintenta dentro de `ingest()` (una sola llamada HTTP), pero
  tampoco los dead-letra inmediatamente — `Worker.process()` los trata como
  fallo transitorio GENÉRICO y aplica el ciclo normal de `fail()`/backoff
  a nivel de JOB (no de llamada HTTP). No es incorrecto por sí solo (más
  seguro que dead-letrar de inmediato un 5xx real), pero es inconsistente
  con la intención declarada del diseño ("4xx no-429 = permanente, resto =
  transitorio") y no está documentado.
- **HTTP 407 (WK-21, BAJA, nueva, curiosidad de plataforma)**: el runtime
  `fetch` de Node (undici) lanza `TypeError: fetch failed` para respuestas
  407 en vez de entregar un `Response` (confirmado con un repro aislado sin
  el cliente del worker: `fetch()` contra un servidor que responde 407
  lanza directamente). El cliente del worker cae en la rama de "fallo de
  red" (retryable=true, permanent=false, status=undefined) — el resultado
  final es correcto (transitorio) pero por una vía distinta a la
  clasificación por status que el código pretende, y `caught.status` queda
  `undefined` en vez de `407`. Anecdótico (ningún servidor real de
  `apps/api` respondería 407, es un código de proxy), documentado por
  completitud del barrido pedido.
- ECONNRESET, timeout (servidor que nunca responde), DNS (`ENOTFOUND`),
  abort externo: los 4 se comportan correctamente (`IngestApiError`
  transitorio, no permanente, no cuelgan el proceso).

**Veredicto: WK-17 CONFIRMADO CERRADO** para 408/425 (el objetivo explícito
de esa corrección); **WK-20/WK-21 nuevos**, ambos de severidad baja/media,
sin impacto de seguridad ni de corrupción de datos.

### WK-15 — dedupe: SQL real vs. migración 0027 aplicada

- El índice único parcial `ux_jobs_kind_jobkey_active` **existe realmente**
  en la DB migrada (`pg_indexes`, confirmado).
- `'cancelled'` **existe realmente** como valor del enum `job_status`
  (`pg_enum`, confirmado).
- Un `INSERT` directo duplicado (bypaseando `enqueue()`/el advisory lock)
  con la misma `(kind, jobKey)` activa **lanza `23505`** (violación de
  restricción única) — el índice protege de verdad, incluso sin el
  advisory lock.
- Tras `succeeded`, la misma clave se puede reutilizar (índice parcial,
  confirmado).
- **`JobQueue.enqueue()` SIGUE usando `SELECT`-luego-`INSERT` con
  `pg_advisory_xact_lock`, NUNCA `INSERT ... ON CONFLICT DO NOTHING`**
  (confirmado por lectura de código): la migración 0027 sugiere esa
  simplificación en su comentario, pero nunca se aplicó al código de
  aplicación. Es **coherente y seguro** (el índice es una defensa en
  profundidad adicional sobre el advisory lock: si el lock alguna vez
  fallara, el índice evitaría el duplicado con una excepción en vez de
  datos corruptos silenciosos), pero es trabajo pendiente no reflejado en
  ninguna tabla de hallazgos hoy.
- **`JobQueue.cancel()` SIGUE usando `status='dead'`, NUNCA `'cancelled'`**
  (confirmado: `cancelled().status === 'dead'`), pese a que el enum ya
  tiene el valor desde 0027. Ver WK-22 abajo (mismo patrón que el punto
  anterior: esquema listo, código no actualizado).

**Veredicto: WK-15 CONFIRMADO** (la nota de honestidad sobre PGlite sigue
siendo correcta y necesaria); la migración 0027 en sí es correcta y ya
protege de verdad contra duplicados incluso en Postgres real vía el índice.
El gap de código (`enqueue()`/`cancel()` no aprovechan el esquema nuevo) se
documenta como WK-22.

### Activación de los `.pending.test.ts` (WK-22, ALTA, nuevo)

Se implementaron los cuerpos reales descritos en los 3 archivos (no solo
quitar `.skip`) y se ejecutaron contra `createMigratedDb()` (que ya aplica
0026-0028):

| Propuesta | Aserción del test pendiente | Resultado real | ¿Debe activarse? |
|---|---|---|---|
| PROPOSAL-01 (WK-07) | `recordSourceRun(fineState:'rate_limited')` → `status='rate_limited'` | **FALLA**: `status='failed'` (código `toDbStatus()` no actualizado) | NO todavía — requiere actualizar `source-run-status.ts` primero |
| PROPOSAL-01 (WK-07) | ídem `not_configured` | **FALLA**: `status='failed'` | NO todavía |
| PROPOSAL-02 (WK-04) | `INSERT` directo duplicado → `23505` | **PASA** | SÍ, este caso concreto puede activarse ya |
| PROPOSAL-02 (WK-04) | `cancel()` → `status='cancelled'` | **FALLA**: `status='dead'` (código `JobQueue.cancel()` no actualizado) | NO todavía — requiere actualizar `job-queue.ts` primero |
| PROPOSAL-02 (WK-15) | Paso 0: 0 duplicados en DB fresca | **PASA** (trivial en DB vacía) | SÍ, aunque de valor limitado (no ejercita el caso con datos previos) |
| PROPOSAL-03 (WK-08) | rol `worker_role` existe | **PASA** | SÍ |
| PROPOSAL-03 (WK-08) | grants exactos sobre 3 tablas | **PASA** | SÍ |
| PROPOSAL-03 (WK-08) | RLS bloquea `agentRunId` de otro tenant | **PASA** (ver WK-23) | Con matiz — ver WK-23 |

**Conclusión**: los `.pending.test.ts` NO deben activarse tal cual (sus
cuerpos siguen "intencionalmente vacíos"; activarlos hoy sin contenido
pasaría trivialmente y sería una sobreclaim de cobertura). 2 de las 3
propuestas necesitan trabajo de código adicional en `apps/worker`
(`toDbStatus()`, `JobQueue.cancel()`) antes de poder escribirse en verde
con aserciones reales — el esquema ya está listo desde hace una ronda, el
código de aplicación se quedó atrás. Recomendación: nuevo hallazgo WK-22
(ALTA, por ser exactamente el tipo de "reparación declarada pero no
aplicada" que este encargo pide encontrar) para que el corrector actualice
ambas funciones y entonces sí active/complete los 2 tests pendientes
correspondientes.

### WK-23 (ALTA, nuevo) — RLS de `agent_runs` bajo `worker_role` bloquearía incluso updates legítimos

Ver Resumen ejecutivo. Confirmado con `SET LOCAL ROLE worker_role` (funciona
en PGlite sin necesitar una conexión nueva autenticada, dato metodológico
nuevo frente a lo asumido por la reverificación anterior) + 3 variantes:
org incorrecto (bloqueado, correcto), org correcto sin `current_user_id`
(**bloqueado, INCORRECTO** — es exactamente lo que hace
`updateAgentRunRow()` hoy), org + `current_user_id` correctos
(permitido). Este hallazgo es forward-looking (aplica el día que
`apps/worker` migre su conexión a `worker_role`, que hoy NO ha ocurrido —
la conexión real sigue siendo la propietaria de las migraciones, sin RLS
forzada, ver WK-08 original), pero debe corregirse ANTES de esa migración
de conexión, no después, o `run_agent` se rompería en producción con un
falso positivo de "otro tenant" en el 100% de los casos.

---

## 4. Veredicto consolidado por hallazgo (WK-01..23)

| ID | Veredicto final | Nota |
|---|---|---|
| WK-01 | CERRADO | Sin cambios desde la reverificación anterior |
| WK-02 | CERRADO (vía WK-14) | El fencing por lease token reemplaza y mejora el de `attempts` |
| WK-03 | CERRADO | Sin cambios |
| WK-04 | **PARCIAL** (mitigación funcional CERRADA; esquema aplicado; código de `cancel()` sin actualizar) | Ver WK-22 |
| WK-05 | CERRADO | Sin cambios |
| WK-06 | CERRADO | Sin cambios |
| WK-07 | **PENDIENTE_CÓDIGO** (ya no PENDIENTE_ESQUEMA: el esquema 0026 está aplicado, falta `toDbStatus()`) | Ver WK-22 |
| WK-08 | **PARCIAL** (defensa en código CERRADA para null/otro-tenant no-nulo; RLS futura tiene un gap de integración) | Ver WK-23 |
| WK-09 | CERRADO | Sin cambios |
| WK-10 | CERRADO (vía WK-17 para 408/425) | Ver WK-20 para la zona gris residual |
| WK-11 | CERRADO | Gate de cobertura confirmado activo (exit=0, 90.41/82.23 sobre 85/80) |
| WK-12 | CERRADO | Sin cambios |
| WK-13 | CERRADO | Sin cambios (trazabilidad ya corregida por WK-18) |
| WK-14 | **CERRADO** | 4/4 ataques nuevos resistidos; sin fuga de token en logs |
| WK-15 | CERRADO (documental) | SQL correcto y ya protegido por índice real; gap de código no cubierto por WK-15 en sí (ver WK-22) |
| WK-16 | **CERRADO** en su alcance declarado (null/undefined/'') | WK-19 nuevo documenta el borde truthy-pero-inválido |
| WK-17 | **CERRADO** para 408/425 | WK-20/WK-21 nuevos, ambos menores |
| WK-18 | CERRADO | Documental, sin cambios |
| WK-19 (nuevo) | ABIERTO, BAJA/MEDIA | Guard de WK-16 no cubre `"  "`/objeto; sin corrupción de datos, solo reintentos desperdiciados |
| WK-20 (nuevo) | ABIERTO, MEDIA | Zona gris de 96 códigos HTTP (501, 505-599): ni retryable ni permanent explícitos |
| WK-21 (nuevo) | ABIERTO, BAJA | HTTP 407 clasificado por la rama de red de undici, no por status; resultado final correcto mismo así |
| WK-22 (nuevo) | ABIERTO, **ALTA** | `toDbStatus()`/`JobQueue.cancel()` no aprovechan el esquema 0026/0027 ya aplicado — "reparación declarada, código no actualizado" |
| WK-23 (nuevo) | ABIERTO, **ALTA** | RLS de `agent_runs` bajo `worker_role` bloquearía updates legítimos porque `updateAgentRunRow()` nunca fija `app.current_user_id` |

**Balance del paquete**: de 23 hallazgos totales acumulados en las 3 rondas
de auditoría/reverificación, **16 CERRADOS**, **2 PARCIAL** (WK-04, WK-08 —
ambos con su mitigación principal cerrada y un residual documentado), **5
ABIERTOS nuevos de esta ronda** (WK-19 baja, WK-20 media, WK-21 baja, WK-22
alta, WK-23 alta). Ningún hallazgo previamente CERRADO se reabre por
regresión (WK-22/WK-23 son gaps
NUEVOS descubiertos al ejercitar escenarios que ninguna ronda anterior
había probado — el esquema aplicándose sin el código correspondiente, y la
RLS real combinada con el código de `updateAgentRunRow()` — no
contradicciones de lo ya verificado).

**Límites aceptados con causa (sin cambio de veredicto)**:
- Concurrencia de motor real (PGlite de una sola conexión) sigue sin poder
  demostrarse en este entorno — la mitigación SQL (advisory lock, y ahora
  además el índice único real) es correcta por lectura de código y por la
  violación de restricción confirmada con Postgres real (PGlite SÍ aplica
  restricciones únicas reales, a diferencia de la concurrencia de
  transacciones). **Ligado a B-03** (Postgres de pruebas en CI), fuera del
  alcance de `apps/worker`.
- `run_agent` contra OpenAI real sigue sin ejercitarse con credenciales de
  producción (declarado honestamente, sin cambios).

**REQ candidatos a CUMPLIDO para el orquestador** (no se edita
`docs/ACEPTACION.md`, solo se reporta la recomendación):
- **REQ-146/REQ-150** (unicidad de scheduler por tipo/fuente/ventana):
  candidato a CUMPLIDO — la mitigación funcional (advisory lock) más la
  defensa estructural real (índice único, confirmada con violación
  `23505` contra Postgres real vía PGlite) cubren el escenario que
  originalmente falló (WK-04). Matiz: recomendar dejar constancia de que
  `enqueue()` no usa aún `ON CONFLICT` (redundante pero no bloqueante).
- **REQ-147/148/149** (honestidad de `source_runs`, registro siempre,
  cobertura): candidato a CUMPLIDO para el REGISTRO SIEMPRE (WK-03/05/06,
  sin cambios desde la ronda anterior). **NO candidato a CUMPLIDO todavía**
  para la granularidad completa de estados (WK-07/WK-22): el enum de DB ya
  soporta los 3 estados finos nuevos, pero `apps/worker` los sigue
  proyectando a `'failed'` en la columna real — cualquier backoffice que
  ya cuente con lectura de `source_runs.status` (confirmar con `apps/api`/
  `apps/web` si ya existe, ver WK-07 original) seguiría sin poder
  distinguirlos sin leer `evidence.fineState`.
- Ningún otro REQ de `apps/worker` cambia de candidatura respecto a la
  ronda anterior.

---

## 5. Regresión

```
npm run -w packages/sources typecheck   -> OK, sin salida
npm run -w packages/agents typecheck    -> OK, sin salida
npm run -w packages/db typecheck        -> OK, sin salida
npm run -w apps/worker test (suite oficial, sin archivos zz-*) -> 79 passed, 6 skipped (85), 8 archivos + 3 skip
```

Sin regresiones. `git status --short` sobre `apps/worker/test/` y
`apps/worker/db-proposals/` vacío tras eliminar los archivos temporales.

---

## 6. Nota metodológica

Los 18 escenarios adversariales (WK-14 x4, WK-16 x4, WK-17 x205 incluyendo
el barrido completo 400-599 + red + abort, WK-15 x5, pending-proposals x11)
se ejecutaron en `git worktree add <scratchpad>/reverify2-worker HEAD`
(HEAD `c96484a`), nunca en el árbol principal. El worktree fue eliminado
(`git worktree remove --force`) al finalizar. Los 5 archivos de test
temporales (`apps/worker/test/zz-reverify2-*.test.ts`) nunca se
commitearon y se borraron antes de cerrar el worktree (confirmado con
`git status --short` vacío). No se modificó ningún archivo de producción
del worktree de forma permanente. No se tocó ningún archivo de `apps/api`,
`packages/*` ni ningún cambio sin commitear de otros agentes en el repo
principal (confirmado: el repo principal avanzó con commits de otros
agentes —`apps/api`, `packages/db` migración `0033`— durante esta
reverificación, sin relación con `apps/worker`, verificado con
`git log c96484a..HEAD -- apps/worker` vacío). Este documento y
`docs/logs/reverify2-worker.log` son los únicos artefactos persistentes de
esta reverificación.
