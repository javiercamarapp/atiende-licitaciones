# Auditoría adversarial — `apps/worker` Ronda 6 (agentes de negocio reales, "Ronda K")

Fecha: 2026-09-06. Agente: auditor adversarial independiente, contexto
separado del proyecto. Rol: **SOLO encuentra** — ningún código de
`apps/worker`, `packages/agents`, `packages/db` ni de cualquier otro
paquete fue modificado en el repositorio principal por este agente.

**Metodología**: `git worktree add <scratchpad>/audit-worker-k HEAD` sobre
`cef35a4` (HEAD real del repo principal al iniciar) + `npm install` real
(818 paquetes). El árbol principal nunca se tocó con comandos destructivos
(`git reset`/`checkout <commit>`/`stash`/`rebase`/`add -A` — ninguno se
ejecutó). Para verificar comportamiento real (no solo lectura de código) se
aplicaron **mutaciones de código temporales** dentro del worktree
(guardrail forzado a "nunca bloquea", techo de rol de `consultor_externo`
elevado a `irreversible`, filtro `org_id` eliminado de `fetchTender`), se
corrió la suite real contra cada mutación, y se revirtió cada una
(`diff`/`cp` de respaldo, confirmado idéntico byte a byte) antes de la
siguiente. Se escribieron y ejecutaron 5 archivos de prueba adversariales
temporales (`zz-audit-*.test.ts`) para probar registro de herramientas
maliciosas, fuga cross-org, fabricación por proveedor comprometido, y
tormenta de 1000 eventos; los 5 se **borraron** al terminar (confirmado con
`git status` limpio en el worktree antes de descartarlo). Evidencia de
comandos/salidas reales en `docs/logs/audit-worker-k.log`. Un corte por
límite de tasa (429) interrumpió la sesión a mitad de un PoC (el archivo de
prueba nunca llegó a escribirse en disco antes del corte); al reanudar se
re-verificó el estado del worktree (limpio, sin archivos huérfanos) antes
de continuar, así que no hay evidencia contaminada por el corte.

Documentos base leídos: `apps/worker/README.md` completo (secciones de
ronda 2/4/6), `apps/worker/src/agents/{business-tools,named-agents,
db-context,kill-switch,enqueue-agent-run,system-actor}.ts`,
`apps/worker/src/handlers/run-agent.ts`, `apps/worker/db-proposals/
PROPOSAL-06-agent-business-tools-grants.sql`, `docs/logs/worker-ronda6.log`
(no encontrado como tal; se usó la sección "Ronda 6" del propio README y
`docs/logs/worker-ronda2.log` como referencia de estilo — ver nota en
Rubro 1), `packages/agents/README.md` completo (prohibiciones duras,
`actionKind`, `NoFabricationPolicy`, presupuesto, límites AG-05/AG-12/AG-19/
AG-21 ya documentados), `docs/REQUISITOS.md` §13/§24/§26/§33
(REQ-164..171), y las secciones §3-9 de `docs/AMPLIACION-BACKOFFICE.md`
citadas por el propio código (el archivo íntegro no se releyó completo por
tiempo; las citas puntuales del código se verificaron contra su contenido
real donde fue relevante — perfil de empresa/matching/no-fabricación).

---

## Resumen ejecutivo

El código de la Ronda 6 reproduce limpio: **370/370 tests** de
`apps/worker` (con 1 timeout aislado bajo carga completa de la suite, ver
WK6-03 — no reproducible en ejecución aislada ni en una segunda corrida
completa), cobertura por encima de los umbrales configurados
(93.02%/84.76%/88.98%/93.02%), `typecheck` limpio, y **263/263** tests de
`packages/agents`. Los **26 evals** de `test/agent-evals.test.ts` existen,
son deterministas (`FakeProvider`, sin red) y **no son triviales para 2 de
3 reglas mutadas**: deshabilitar el guardrail anticorrupción hace fallar 2
evals, y elevar el techo de riesgo de `consultor_externo` hace fallar 4 —
ambas mutaciones fueron detectadas correctamente. La tercera mutación
(quitar el filtro `org_id` de `fetchTender`, la única lectura detrás de
`proponer_matching`) **no hizo fallar ningún test ni eval de los 370/26
existentes**, y una prueba dirigida confirmó una fuga real de datos
cross-org bajo esa mutación (WK6-01, ALTA) — el código en producción hoy
es correcto (el filtro existe), pero no hay red de seguridad de pruebas
para una regresión futura ahí. Se encontró además que el identificador de
correlación de negocio (`correlationId`/`tenderId`, exigido por REQ-171)
nunca se persiste en `agent_runs.output` ni se registra en los logs
estructurados del job — se pierde al terminar la corrida (WK6-02, ALTA).
El resto de la superficie auditada — prohibiciones duras por nombre/
`actionKind` (incluidos homoglifos Unicode y variantes normalizadas),
rechazo de `organizationId` del modelo en cualquier profundidad de
esquema, grants mínimos de `PROPOSAL-06`, no-fabricación con un proveedor
LLM deliberadamente malicioso, presupuesto excedido sin efectos
parciales, kill-switch por agente, y una tormenta real de 1000 eventos
concurrentes (mismo evento → dedupe correcto; eventos distintos → 1000
jobs sin bloqueo) — se comprobó **correcta**, con evidencia en vivo.

---

## Hallazgos

### WK6-01 — ALTA. La eval/test de "aislamiento por organización" de `proponer_matching` no verifica contenido; una regresión real de aislamiento pasaría desapercibida por los 370 tests + 26 evals

**Rubro**: 6 (evals no triviales) / 2 (aislamiento, REQ-167).

**Evidencia**: `apps/worker/src/agents/business-tools.ts`, función
`fetchTender` (línea 82-89), es la única consulta detrás de la herramienta
`proponer_matching`:

```ts
async function fetchTender(tx: DbExecutor, orgId: string, tenderId: string): Promise<TenderRow | undefined> {
  const { rows } = await tx.query<TenderRow>(
    `select id, title, status, contracting_body, cpv_codes, budget_amount, currency, submission_deadline, source
     from tenders where id = $1 and org_id = $2`,
    [tenderId, orgId],
  );
  return rows[0];
}
```

Se mutó temporalmente esa consulta a `where id = $1` (sin `org_id`) y se
corrió la suite completa relevante:

- `test/agent-evals.test.ts` (26 tests, incluida "aislamiento por org: un
  tenderId de otra organización nunca se lee ni se usa para matching" para
  `analista_convocatorias`) → **26/26 pasan igual**, sin ningún fallo.
- `test/business-tools.test.ts` (11 tests) → **11/11 pasan igual**.

Razón: la eval de aislamiento (`test/agent-evals.test.ts` línea 111-129)
solo verifica:

```ts
const matchingCall = row.output.toolCalls.find((t) => t.toolName === 'proponer_matching');
expect(matchingCall?.status).toBe('ok');
// La convocatoria es de orgA: proponer_matching de orgB nunca la encuentra ("no evaluable"), nunca filtra datos de orgA.
```

El comentario afirma la garantía, pero la aserción real solo comprueba que
el `tool_call` terminó con `status: 'ok'` — **nunca inspecciona
`score`/`explanation`/`matchedKeywords`**, que es exactamente donde
viviría una fuga. `test/business-tools.test.ts` tampoco tiene un caso de
aislamiento cross-org dedicado para `proponer_matching` (sí lo tiene
`listar_convocatorias`, ver línea 73-84 de ese archivo).

Con la mutación activa se escribió una prueba dirigida
(`zz-audit-isolation-poc.test.ts`, borrada al terminar) que llama
directamente al handler de `proponer_matching` con `ctx.organizationId =
orgB` y un `tenderId` real de `orgA` (título `"SECRETO obra civil orgA"`,
`contracting_body: "Municipio Secreto"`), habiendo declarado la
`capability` `"obra civil"` en `orgB`. Resultado real:

```json
{"tenderId":"...","score":100,"explanation":"[fake:economico:...]","matchedKeywords":["obra civil"],"missingProfileFields":[]}
```

`orgB` obtuvo un `score: 100` y `matchedKeywords` derivados del
`title`/`contracting_body` reales de la convocatoria de `orgA` — una fuga
cross-org completa, confirmada empíricamente, mientras la mutación estuvo
activa. Se revirtió la mutación inmediatamente después (`diff` confirmó
archivo idéntico al original).

**Nota de honestidad**: el código **hoy en producción es correcto** — el
filtro `org_id = $2` existe y `id` es un UUID global (clave primaria),
así que sin ese filtro cualquier `tenderId` conocido de cualquier
organización es alcanzable. Esto no es un hallazgo de "hay una fuga hoy",
sino de "la red de pruebas que debería atrapar una futura regresión aquí
no lo hace" — un cambio futuro (refactor, copiar/pegar, merge conflictivo)
que reintroduzca este bug pasaría los 370 tests y 26 evals sin ningún
fallo.

**Reparación** (no aplicada, fuera de mi rol): añadir una aserción de
contenido a la eval de aislamiento existente
(`expect(matchingCall.output.score).toBeNull()` o equivalente sobre
`explanation`/`matchedKeywords`, no solo `status`), y/o un test dedicado en
`business-tools.test.ts` para `proponer_matching` con dos organizaciones
reales (mismo patrón que ya existe para `listar_convocatorias`).

---

### WK6-02 — ALTA. El `correlationId` de negocio (REQ-171) nunca se persiste en `agent_runs.output` ni se registra en el log del job; se pierde al terminar la corrida

**Rubro**: 4 (trazabilidad de la corrida) / 8 (trazabilidad y pendientes honestos).

**Evidencia**: `RunAgentPayload.correlationId` (`apps/worker/src/handlers/
run-agent.ts` línea 60) documenta explícitamente: *"Enlaza la corrida a la
convocatoria/expediente de origen"*. Cuando se dispara por evento de
plataforma, `enqueueAgentRun` SÍ lo fija correctamente al `tenderId` real:

- `apps/worker/src/handlers/discover-tenders.ts:118` → `correlationId: result.tenderId`
- `apps/worker/src/scheduler/deadline-reminders.ts:76` → `correlationId: row.id`

Ese valor llega a `AgentRunRequest.correlationId` (línea 440 de
`run-agent.ts`) y `packages/agents` lo guarda correctamente en memoria:
`AgentRun.correlationId` y cada `ToolCallTrace.correlationId`
(`packages/agents/src/agent-runner.ts` líneas 117/491,
`packages/agents/src/stores.ts` línea 126, con métodos dedicados
`listByCorrelationId` en ambos stores).

Sin embargo, `updateAgentRunRow` (`run-agent.ts` líneas 282-292) construye
el JSON que se persiste en `agent_runs.output` así:

```ts
const output = JSON.stringify({
  richStatus: run.status,
  error: run.error ?? null,
  completedSteps: run.completedSteps,
  totalSteps: run.totalSteps,
  toolCalls: summarizeToolCalls(toolCalls),
});
```

Ni `run.correlationId` ni `t.correlationId` (dentro de
`summarizeToolCalls`, líneas 249-261) aparecen en ningún lugar de ese
objeto. La tabla `agent_runs` (`packages/db/migrations/0004_agents.sql`)
tampoco tiene una columna dedicada `correlation_id` — solo `input`/`output`
jsonb genéricos.

Además, el logger estructurado del job (`apps/worker/src/queue/worker.ts`
líneas 96-101) fija:

```ts
const childLogger = logger.child({
  job_id: job.id,
  correlation_id: job.id,   // <- el ID del JOB de cola, no job.payload.correlationId
  kind: job.kind,
  attempts: job.attempts,
  worker_id: workerId,
});
```

es decir, el campo `correlation_id` de cada línea de log es el
identificador **interno de la cola** (`job.id`, distinto para cada job/
corrida), no el identificador de **negocio** (`tenderId`) que permitiría
agrupar en una sola consulta todas las corridas relacionadas con la misma
convocatoria. Y `createRunAgentHandler` (el handler de `run_agent`) nunca
llama a `ctx.logger` en absoluto — no hay ninguna línea de log dentro de
`run-agent.ts` que mencione `job.payload.correlationId`.

Resultado: tras terminar un job `run_agent`, el identificador de negocio
que enlazaría esa corrida con el resto del expediente
(matriz→propuesta→paquete→archivo, per REQ-171) **no queda en ningún
lugar durable y consultable que este worker controle**. El único rastro
parcial es `agent_runs.input.context.tenderId` (presente solo para
corridas abiertas por el propio worker vía `enqueueAgentRun`, cuando
`PROPOSAL-06` está aplicada — ver `enqueue-agent-run.ts` línea 51 — y
ausente para corridas solicitadas por un humano vía `apps/api`, cuyo
formato de `input` decide ese otro sistema, fuera de este ámbito). El
criterio verificable de REQ-171 ("Consulta de auditoría reconstruye la
cadena completa... a partir de un solo `correlation_id`") no es alcanzable
hoy con una sola consulta sobre `agent_runs`.

Se confirmó con `grep` que este límite **no está declarado** en el README
de este paquete (que sí documenta honestamente otros límites similares,
como "`tool_calls` no persiste en Postgres" o el fail-open de
`enqueueAgentRun`) — el único texto relacionado (línea 212 del README)
afirma sin matiz que *"cada línea de log del job lleva `job_id`/
`correlation_id`"*, dando a entender (sin serlo) que eso cubre la
trazabilidad de negocio de REQ-171.

**Reparación** (no aplicada): incluir `run.correlationId` en el objeto
`output` de `updateAgentRunRow` (y opcionalmente en cada entrada de
`summarizeToolCalls`), y/o hacer que `createRunAgentHandler` derive un
logger hijo con `correlation_id: job.payload.correlationId ?? job.id` en
vez de depender solo del `correlation_id` genérico de `worker.ts`.

---

### WK6-03 — BAJA. `PROPOSAL-06-agent-business-tools-grants.test.ts` es flaky bajo carga completa de la suite (timeout fijo de 5000ms)

**Rubro**: 1 (reproducibilidad).

**Evidencia**: primera corrida de `npm run -w apps/worker test` (370
tests): 369 pasan, 1 falla —
`db-proposals/PROPOSAL-06-agent-business-tools-grants.test.ts > ... SIN la
propuesta aplicada, withWorkerBusinessReadContext SÍ falla explícito...`
con `Error: Test timed out in 5000ms`. Ejecutando **solo ese archivo**
inmediatamente después: 5/5 pasan en 3.1s (el test específico que había
fallado tarda 582ms aislado). Una segunda corrida completa de
`npm run -w apps/worker test:coverage` (370 tests) pasó **370/370** sin
ningún fallo. El total de 370 tests coincide exactamente con lo declarado
en `apps/worker/README.md`; los 26 evals de `test/agent-evals.test.ts`
también coinciden con lo declarado.

No es un defecto funcional del código auditado — es contención de
recursos del entorno (21 archivos de test corriendo PGlite en paralelo)
contra un timeout fijo de 5000ms de vitest en un test que hace varias
migraciones/transacciones reales. En un runner de CI compartido/con más
contención esto podría producir falsos rojos intermitentes.

**Reparación** (no aplicada): subir el `testTimeout` para ese archivo (o
globalmente) a un valor con más margen (p. ej. 15000ms), o reducir la
concurrencia de vitest en CI.

---

## Comprobado correcto

### Rubro 1 — Reproducibilidad

- **370/370 tests** de `apps/worker` reproducen (ver WK6-03 sobre el único
  timeout aislado, no reproducible en corridas repetidas ni aisladas).
- **Cobertura** con `npm run -w apps/worker test:coverage`: 93.02%
  statements, 84.76% branches, 88.98% funciones, 93.02% líneas —
  por encima de los umbrales declarados en el README (líneas≥85%,
  ramas≥80%).
- `npm run -w apps/worker typecheck` limpio.
- `packages/agents`: **263/263** tests pasan.
- **26 evals** en `test/agent-evals.test.ts`, ≥5 por cada uno de los 5
  agentes nombrados, confirmados existentes y deterministas (ver Rubro 6).
- No se encontró `docs/logs/worker-ronda6.log` como archivo — el registro
  de la ronda vive dentro de `apps/worker/README.md` (sección "Ronda 6") en
  vez de un log separado; se documenta como discrepancia menor de
  nomenclatura respecto a la petición original, sin impacto en el
  contenido verificado.

### Rubro 2 — Prohibiciones duras desde el worker

- **Nombre homoglifo**: se registró una herramienta con el nombre
  `presentar_oferta` sustituyendo la `a` latina por `а` cirílica (U+0430,
  visualmente idéntica) — `ToolRegistry.register()` la **rechazó**
  (`VALID_TOOL_NAME = /^[a-z0-9_]+$/`, AG-02).
- **`organizationId` del modelo, anidado profundo**: se registró una
  herramienta con `organizationId` dentro de
  `z.array(z.object({wrapper: z.object({organizationId: z.string()})}))`
  (arreglo de objetos de objetos) — **rechazada** en el registro
  (AG-11/AG-20/AG-22). Las 8 herramientas reales de negocio también se
  confirmaron limpias por el test existente
  (`business-tools.test.ts`: "ninguna de las 8 herramientas acepta
  organizationId/orgId/tenantId del modelo").
- **`actionKind` obligatorio**: registrar sin `actionKind` **lanza** en
  `register()`.
- **Prohibición dura por NOMBRE, para todo rol incluido superadmin/system**:
  `AuthorizationPolicy.decide()` con `toolName: 'submit_proposal_to_portal'`
  devuelve `denied` para `superadmin`, `system`, `consultor_externo` y
  `licitador` por igual — ninguno puede ejecutarla ni pedir aprobación.
  Variantes normalizadas (`Submit-Proposal-To-Portal`,
  `SUBMIT_PROPOSAL_TO_PORTAL`, `submit.proposal.to.portal`) también se
  deniegan (`normalizeToolName`, AG-02/AG-23 aplicado por analogía).
- **Límite conocido AG-05 reproducido (no es un hallazgo nuevo, ya
  documentado en `packages/agents/README.md`)**: se registró una
  herramienta `inocuo_guardar_borrador` con `riskLevel: 'write'`,
  `actionKind: 'write'`, `declaredEffects: ['internal_write']` — todos
  metadatos consistentes entre sí pero potencialmente falsos respecto al
  comportamiento real del handler (que en un caso real podría hacer un
  `fetch` externo). `AuthorizationPolicy.decide()` la resuelve `auto` (sin
  aprobación humana), confirmando exactamente el límite arquitectónico que
  el propio README ya admite: un gate basado en metadatos autodeclarados no
  puede detectar una herramienta que miente en todos sus campos a la vez.
  Se confirma que la mitigación declarada (revisión humana de cada
  `ToolDefinition.handler` antes de merge) sigue siendo la única defensa
  real — correctamente calificada como límite, no como bug.
- **`PROPOSAL-06-agent-business-tools-grants.sql` revisada línea por
  línea**: los `grant select` se limitan exactamente a las 10 tablas que
  las herramientas de lectura necesitan (`tenders`, `tender_documents`,
  `tender_versions`, `tender_change_events`, `requirement_items`,
  `company_profiles`, `capabilities`, `experience_records`,
  `compliance_items`, `proposals`) — ninguna tabla de escritura sensible
  adicional. El único `grant insert` (`agent_runs`) va acompañado de una
  política RLS restringida explícitamente a `started_by is null`
  (corridas abiertas por el propio worker por evento, nunca las de un
  humano vía `apps/api`, que siempre fijan `started_by`) — el propio
  archivo SQL documenta por qué una política sin esa condición habría
  revertido la garantía WK-23 (RLS combina políticas PERMISSIVE con OR).
  Los 5 tests de `PROPOSAL-06-agent-business-tools-grants.test.ts`
  confirman ambas direcciones: `worker_role` puede leer/insertar bajo esas
  condiciones, y un miembro humano real de la organización sigue pudiendo
  leer sus propios datos sin que la política adicional interfiera.
- **Escritura sin `worker_role`**: las 4 herramientas de lectura y
  `enqueueUpcomingDeadlineReminders` fallan explícito con
  `SchemaGrantPendingError` (nunca una lista vacía fabricada) si la
  política RLS de `PROPOSAL-06` no existe — confirmado por
  `db-context.ts` y sus tests. No se encontró ninguna ruta de código que
  omita `set local role worker_role` para estas operaciones.
- **Resultado de agente que "aprueba"**: `HUMAN_REVIEW_RUN_STATUSES`
  (`denied`/`blocked`/`needs_approval`/`needs_data`/`invalidated`) se
  marcan `permanent: true` — revisión de código confirma que ninguna ruta
  de `run-agent.ts` produce un estado de "aprobado" para una acción de
  negocio; el único estado de éxito real es `completed` (una propuesta
  calculada, nunca una decisión ejecutada), y las prohibiciones duras
  (`submit_proposal_to_portal` y análogas) ni siquiera llegan a
  `pendingApprovals` (packages/agents README, confirmado por código: no
  hay ruta de `resume('approve')` que las alcance).
- **Nota menor (no numerada como hallazgo, informativa)**:
  `DependencyInvalidationRegistry.dependsOn` nunca se declara en ninguno de
  los 5 planes fijos de `named-agents.ts` (`buildNamedAgentPlan`) — la
  garantía de "una aprobación humana tras un cambio de bases nunca ejecuta
  sobre datos obsoletos" de `packages/agents` no se ejercita en Ronda 6
  porque ninguna de las 8 herramientas de negocio actuales alcanza nunca un
  paso `pending`/`needs_approval` (ninguna tiene `riskLevel: irreversible/
  external` ni un nombre en `DEFAULT_PROHIBITED_ACTIONS`). La garantía de
  "nunca reaprobar sobre bases invalidadas" para `vigilante_cambios`
  descansa hoy por completo en el trigger de base de datos
  (`app.invalidate_tender_dependents`), no en este mecanismo de
  `packages/agents`. No es un defecto — es una capacidad sin caso de uso
  todavía — pero cualquier agente nombrado futuro que sí produzca un paso
  `pending` de larga vida debería declarar `dependsOn` explícitamente.

### Rubro 3 — No fabricación

- **Perfil vacío / sin datos**: `proponer_matching` sin `capabilities`
  devuelve `score: null` y `missingProfileFields: ['capabilities']`
  (nunca un score inventado); `proponer_seccion_propuesta` sin
  `experience_records.evidence_ref` devuelve `blocked: true` y
  `missingData: ['experience_records.evidence_ref']` — confirmado por
  `business-tools.test.ts` y por el eval "no fabricación" de
  `redactor_borrador".
- **Precios/vigencias solo con `approved_source_ref`**: las 4 herramientas
  que declaran `extractSensitiveValues` (`leer_bases`,
  `proponer_requisitos_matriz`, `proponer_seccion_propuesta`,
  `resumir_cambios_convocatoria`) citan siempre un `docId`/`capturedAt`
  real derivado de filas reales de Postgres — revisión de código confirma
  que ningún `approvedSourceRef` se construye con un valor inventado.
- **Proveedor LLM malicioso/comprometido que inventa un precio**: se
  escribió un `LLMProvider` de prueba cuyo único propósito es devolver, en
  texto libre, *"El precio unitario ofertado será de $1,250,000.00 MXN,
  vigente hasta el 31/12/2026."* como `explanation` de `proponer_matching`
  (que no declara `extractSensitiveValues`, así que depende enteramente del
  escaneo por defecto AG-10). Resultado real de una corrida completa de
  `analista_convocatorias` con ese proveedor: la corrida se detiene en
  `needs_data` (`datos_sin_fuente_aprobada:$.explanation`), el tool_call
  correspondiente queda `pending_no_fabrication`, y el resumen persistido
  en `agent_runs.output` **nunca contiene el precio inventado** (solo el
  path `$.explanation` como campo faltante) — confirma en vivo tanto el
  escaneo por defecto (AG-10) como la redacción del resumen
  (`summarizeToolCalls`, que nunca vuelca el output crudo).

### Rubro 4 — Presupuesto / idempotencia / kill-switch / correlación

- **Presupuesto excedido sin efectos parciales**: revisión de
  `AgentRunner.executeAuthorized`
  (`packages/agents/src/agent-runner.ts`) confirma que
  `budgetLedger.reserve()` se invoca **antes** de llamar al handler de la
  herramienta; si la reserva falla (`BudgetExceededError`), el paso se
  registra `status: "error"` con `attempts: 0` y la corrida se detiene
  `failed` sin que el handler real se haya ejecutado nunca — confirmado
  también por los 5 evals "presupuesto excedido" (uno por agente nombrado).
- **Idempotencia por `idempotencyKey`**: confirmado por evals dedicados
  (p. ej. `analista_convocatorias`: dos corridas del mismo `tenderId+org`
  invocan el `LLMProvider` una sola vez).
- **Kill-switch por agente**: `WORKER_DISABLED_AGENTS` bloquea ANTES de
  construir el registro de herramientas — ningún tool_call corre, ningún
  presupuesto se reserva (confirmado por `run-agent-kill-switch.test.ts`).
  `parseDisabledAgents(env)` lee `env.WORKER_DISABLED_AGENTS` en cada
  invocación del handler (no cachea el valor al construir el handler), así
  que **estructuralmente** sí soporta apagar "en caliente" si algo muta
  `process.env` en el proceso vivo — pero, como el propio README ya
  documenta honestamente en "Pendientes", **no existe ningún mecanismo en
  este código** (endpoint de administración, señal, recarga de config) que
  permita mutar esa variable de un proceso ya arrancado en producción sin
  reiniciarlo. Se confirma el límite ya declarado, no se encontró nada
  adicional.
- **`correlation_id` en `agent_runs`/`tool_calls`**: ver **WK6-02** — no se
  persiste hoy.

### Rubro 5 — Encolado por evento

- **Dedupe por `(agentName, eventKey)`**: confirmado por los 3 tests
  existentes de `enqueue-agent-run.test.ts` y por una prueba de tormenta
  propia: **1000 llamadas concurrentes** (`Promise.all`) a
  `enqueueAgentRun` con el **mismo** `eventKey` produjeron exactamente
  **1 job** activo (999/1000 marcadas `deduped: true`), en 1.9s, sin
  bloquear el proceso. **1000 llamadas concurrentes con eventos
  DISTINTOS** produjeron exactamente **1000 jobs únicos** (sin
  duplicados), en 2.1s.
- **Caveat de honestidad (consistente con B-03, ya documentado en el
  README para todo el resto del paquete)**: PGlite es de una sola
  conexión/proceso, así que esta prueba confirma la **lógica** de
  deduplicación bajo `Promise.all` (mismo patrón que el resto de la suite
  de este worker), no concurrencia real de conexiones de sistema operativo
  compitiendo — la misma limitación que ya aplica a `JobQueue.enqueue()` en
  general.

### Rubro 6 — Evals: ¿deterministas y no triviales?

Se mutaron 3 reglas reales del sistema y se corrió `test/agent-evals.test.ts`
contra cada una, revirtiendo después de cada corrida:

| Mutación | Resultado esperado | Resultado real |
|---|---|---|
| `AntiCorruptionGuardrail.check()` forzado a `{blocked: false}` siempre | Evals de guardrail fallan | **2/26 fallan** (`redactor_borrador`, `recordatorios`) — CORRECTO |
| `ROLE_RISK_CEILING.consultor_externo` de `"read"` a `"irreversible"` | Evals de techo de rol fallan | **4/26 fallan** (`analista_convocatorias`, `analista_bases`, `redactor_borrador`, `recordatorios`) — CORRECTO |
| `fetchTender` sin filtro `org_id` (aislamiento) | Eval de aislamiento de `analista_convocatorias` falla | **0/26 fallan** — INCORRECTO, ver **WK6-01** |

Conclusión: las evals son deterministas (mismo resultado en corridas
repetidas, sin red) y genuinamente no triviales para guardrail y techo de
rol — no son un teatro de pruebas que siempre pasa. Para aislamiento por
organización específicamente en `proponer_matching`, la eval es ciega al
contenido (ver WK6-01).

### Rubro 7 — OpenAI real

- **Sin `OPENAI_API_KEY`, cero llamadas de red**: se instanció
  `OpenAIResponsesProvider` con `apiKey: undefined` y un `fetchImpl` espía;
  `complete()` lanza `MissingCredentialsError` **antes** de invocar
  `fetchImpl` — el espía nunca se llamó (`toHaveBeenCalled()` falso).
- **Con clave falsa, error controlado sin fuga de la clave**: se simuló una
  respuesta 401 real de OpenAI (`fetchImpl` capturó el header
  `Authorization: Bearer sk-test-super-secreta-...` para confirmar que la
  clave SÍ se usa) y se verificó que el `Error` lanzado
  (`OpenAI Responses API respondió 401: {"error":{"message":"Invalid API
  key provided"}}`) **no contiene la clave** en ningún punto —
  `message`, `JSON.stringify(thrown)` y el mensaje persistido en
  `describeError()`/`agent_runs.output` (que solo usa `error.name`/
  `error.message`) están todos limpios. `pino` no tiene `redact`
  configurado en `logger.ts`, pero no se encontró ninguna ruta de código
  que loguee un objeto de error/request completo (con headers) en vez del
  mensaje ya sanitizado — el riesgo es teórico (código futuro que loguee
  `err` crudo con propiedades no estándar), no confirmado hoy.

### Rubro 8 — Trazabilidad y pendientes honestos

- El README de `apps/worker` (sección "Ronda 6" y "Pendientes") es, en
  general, honesto y específico: documenta explícitamente `PROPOSAL-06`
  pendiente con su mitigación fail-closed real, el fail-open deliberado de
  `enqueueAgentRun` (con su razón), el kill-switch "solo por variable de
  entorno" como limitación reconocida, el límite de `FakeProvider`/
  `OpenAIResponsesProvider` no ejercitado contra credenciales reales, y la
  falta de persistencia de `tool_calls` individuales en su propia tabla.
  La única omisión encontrada es **WK6-02** (`correlationId` no
  persistido) — el resto de lo revisado coincide con el código real.

---

## Reproducción

Ver `docs/logs/audit-worker-k.log` para la secuencia completa de comandos
y salidas reales (instalación, `test`, `test:coverage`, `typecheck`,
mutaciones, PoCs adversariales, reversión y limpieza del worktree).

**Entorno**: Node v25.6.1, npm 11.12.1, macOS (Darwin 24.6.0). Worktree
creado sobre el commit `cef35a4` del repositorio principal (HEAD al
iniciar esta auditoría); el repositorio principal avanzó a otros commits
de forma concurrente durante la sesión (otros agentes trabajando en
paralelo) — este informe se basa exclusivamente en el código congelado del
worktree, no en el HEAD posterior del repositorio principal.

---

## Estado de reparación (agente corrector, post-auditoría)

Un commit por hallazgo (`git log`, mensajes `fix(worker): WK6-nn ...`);
evidencia real de comandos y salidas en `docs/logs/fix-worker-k.log`.

| Hallazgo | Severidad | Estado reparación |
|---|---|---|
| WK6-01 | ALTA | **REPARADO**. Las evals/tests de aislamiento ahora verifican CONTENIDO, no solo `status`. Nuevo bloque `aislamiento cross-org (WK6-01)` en `apps/worker/test/business-tools.test.ts`: un test negativo directo por cada una de las **8** herramientas de negocio, con dos organizaciones reales y datos distinguibles (`SECRETO-ORGA`), que confirma que el resultado de `orgB` nunca contiene título/score/explicación/evidencia de `orgA` (`expect(JSON.stringify(output)).not.toContain(SECRET)`); `programar_alerta` (la única de escritura) verifica que el job encolado queda con el `org_id` del contexto, nunca el de la convocatoria ajena. La eval de `analista_convocatorias` en `test/agent-evals.test.ts` añade la misma verificación de contenido (necesaria porque `agent_runs.output.toolCalls` es un resumen redactado que no incluye el `score`). Script de mutación nuevo y ejecutable: `apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh` (worktree desechable + superposición del árbol de trabajo actual + mutación de `fetchTender` + limpieza garantizada; `exit 0` = mutación detectada). **Verificado en vivo**: con la mutación aplicada la suite falla con 2 fallos (`expected 100 to be null` en `proponer_matching` y la eval de aislamiento), frente a los 0 fallos que producía antes de esta reparación — el falso "mutación no detectada" de la primera corrida del script (que aún leía solo HEAD) se corrigió superponiendo el árbol de trabajo. Documentado en `apps/worker/README.md`, sección "Correcciones de la ronda K". |
| WK6-02 | ALTA | **REPARADO**. `updateAgentRunRow()` (`apps/worker/src/handlers/run-agent.ts`) persiste ahora `correlationId` en `agent_runs.output`, y `summarizeToolCalls()` lo persiste también en cada entrada de `toolCalls` — usando el esquema JSONB YA EXISTENTE, sin migración nueva (fuera del ámbito de `apps/worker`). `src/queue/worker.ts` deja de fijar `correlation_id = job.id` a ciegas: el logger hijo usa el identificador de NEGOCIO del payload cuando existe (`businessCorrelationId()`, string no vacío) y `job.id` en cualquier otro caso, con `job_id` siempre presente por separado. Tests: `test/run-agent-handler.test.ts` corre TRES agentes nombrados (`analista_convocatorias` → `analista_bases` → `redactor_borrador`) sobre el MISMO `tenderId` y confirma que **una sola consulta** (`select ... from agent_runs where output->>'correlationId' = $1 order by created_at`) reconstruye convocatoria → matriz → propuesta en orden, y que cada `tool_call` lleva el mismo identificador; `test/worker-log-correlation.test.ts` (nuevo, 4 tests) afirma sobre las líneas REALES de pino: `correlation_id` = negocio con `job_id` separado, dos jobs del mismo expediente agrupados por una sola búsqueda, y caída de vuelta a `job.id` si el payload no trae uno usable. **Límite honesto documentado en el README**: sin columna dedicada la consulta va contra el JSONB y no hay índice; con volumen alto conviene una migración `agent_runs.correlation_id` indexada (requiere `packages/db`). |
| WK6-03 | BAJA | **REPARADO**. `testTimeout` de `db-proposals/PROPOSAL-06-agent-business-tools-grants.test.ts` subido de los 5000ms por defecto a **20000ms para todo el archivo** (opción del `describe`, no `vitest.config.ts`): los 5 tests hacen cada uno `createMigratedDb()` con todas las migraciones reales más varias transacciones PGlite, comparten el mismo riesgo bajo la contención de la suite completa, y cuál pierde la carrera es arbitrario — subirlo solo en el que falló esa vez habría dejado a los otros 4 igual de frágiles. 20000ms son >30x el tiempo medido aislado (582ms) y 4x el default: margen para la contención observada sin ocultar un timeout genuino. El default de 5000ms se conserva para el resto de la suite. **Corridas verdes**: 4 corridas COMPLETAS consecutivas de la suite en la verificación final (`test` y `test:coverage`, dos pasadas), **383/383 tests, 22/22 archivos, 0 fallos y 0 timeouts** en las cuatro, con cobertura 93.05% statements / 84.63-84.73% branches / 89.07% funciones / 93.05% líneas (umbrales: líneas ≥85%, ramas ≥80%). Salidas reales completas en `docs/logs/fix-worker-k.log`. |
