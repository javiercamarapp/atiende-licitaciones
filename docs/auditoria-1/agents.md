# Auditoría adversarial — packages/agents (ronda 1)

**Ámbito auditado**: `packages/agents/**` en el commit `c56e20f37f8f89640329c1e9a2e551433e5e9561`
("feat(agents): ToolRegistry, AuthorizationPolicy, guardrails y AgentRunner").
`packages/agents` no cambió entre `c56e20f` y `HEAD` (`67b28886a9728e919d7642272964f669a359251e`
al momento de esta auditoría; verificado con `git diff --stat c56e20f HEAD -- packages/agents`
→ vacío), así que los hallazgos aplican igual a ambos.

**Auditor**: agente Sonnet independiente, sin participación en la construcción de este paquete.
Ejecución real de: `npm install`, `typecheck`/`lint`/`test`/`build`, `vitest --coverage`,
24 pruebas adversariales propias y 5 mutaciones manuales de reglas clave — todo en un
`git worktree` separado (`git worktree add`), nunca en el árbol principal. El worktree fue
eliminado (`git worktree remove --force`) al terminar; no queda ningún archivo de prueba
adversarial en el repositorio.

**Comandos y salida completa**: `docs/logs/audit-agents-ronda1.log`.

---

## Resumen ejecutivo

`packages/agents` es una librería honesta y con una arquitectura sólida en su capa
determinista (idempotencia en proceso, backoff con jitter acotado y cancelación por
`AbortSignal`, aislamiento de presupuesto/rate-limit por organización, invalidación por
dependencia, trazas con `correlationId` y hashes en vez de payloads crudos). El
`README.md` es inusualmente transparente sobre sus propios límites ("Pendientes"): admite
que no se ha ejercitado contra OpenAI real, que el streaming no está implementado y que la
verificación LLM del guardrail y la validación de rol del aprobador quedan para `apps/api`.
La reproducibilidad es perfecta: 13 archivos / 127 pruebas en verde, typecheck/lint/build
limpios, igual que `docs/logs/agents-ronda1.log`. El incidente reportado por el
implementador (borrado accidental de `test/llm/*` restaurado) se verificó: los 3 archivos
están en el commit, son coherentes y no triviales, y sus 31 pruebas pasan.

Sin embargo, la auditoría adversarial encontró que **varias garantías descritas como
"tolerancia cero" en el propio código y en `docs/REQUISITOS.md` son en realidad
configurables o evadibles**, no invariantes de código:

- Las **prohibiciones duras** (`AuthorizationPolicy`) se comparan por nombre exacto de
  herramienta contra un `Set` que (a) no está congelado, (b) es 100% reemplazable por
  configuración del llamador, y (c) no normaliza mayúsculas/unicode — un alias, un
  homoglifo, o una configuración por tenant desactivan por completo REQ-165 sin que
  `AgentRunner` lo impida.
- La **tolerancia cero de proveedores LLM** (REQ-125, los 5 componentes críticos) es, de
  la misma forma, una opción de constructor de `ProviderRouter` (`zeroToleranceComponents`,
  `requiredCountry`) sin ningún mínimo impuesto — y el propio test oficial del paquete
  demuestra y "certifica" esa desactivación como funcionalidad válida.
- **`NoFabricationPolicy`** solo actúa sobre lo que cada herramienta declara
  explícitamente vía `extractSensitiveValues`; un valor sensible bajo otro nombre de
  campo o anidado en un array simplemente no se evalúa nunca y la corrida termina
  `completed` — contradice literalmente el criterio "tolerancia cero" de REQ-164.
- `BudgetLedger` y `TokenBucketRateLimiter` no validan signo/finitud de los montos que
  reciben (`reserve(-1000)`, `tryConsume(org, -1000)` corrompen o rellenan el ledger/bucket
  sin control), aunque la ruta feliz de `AgentRunner` mitiga parcialmente el caso de
  presupuesto.

Ninguno de estos hallazgos es explotable hoy por el LLM directamente (los nombres de tool,
la configuración de `ProviderRouter` y los montos de costo/rate-limit los define el código
integrador, no el modelo), pero **la defensa vive enteramente en disciplina de
configuración de `apps/api`, no en una invariante que `packages/agents` imponga por
diseño** — que es justo lo que REQ-165/REQ-125/REQ-164 exigen como "tolerancia cero" y
"sin excepción, sin importar el rol/config".

**Conteo de hallazgos por severidad**: CRÍTICA: 2 · ALTA: 4 · MEDIA: 6 · BAJA: 4 → **16 hallazgos** (AG-01 a AG-16).

---

## 1. Reproducibilidad

| Paso | Resultado | Evidencia |
|---|---|---|
| `npm install` (raíz y worktree) | OK, sin cambios de dependencias inesperados | log líneas 1-25 |
| `npm run -w packages/agents typecheck` | OK, sin errores | log |
| `npm run -w packages/agents lint` | OK, sin hallazgos | log |
| `npm run -w packages/agents test` | **13 archivos / 127 pruebas, todas en verde** | log; igual a `docs/logs/agents-ronda1.log` |
| `npm run -w packages/agents build` | OK | log |
| `vitest run --coverage` (no está en el script oficial) | Statements 89.87% · Branches 84.51% · Funcs 89.62% · Lines 92.59% | log, sección "vitest --coverage" |

**Veredicto: CUMPLE.** La ronda es reproducible byte-a-byte contra el log entregado por el
implementador (mismo conteo de archivos/tests, mismos nombres). Ver AG-14 por la ausencia
de un umbral de cobertura exigido en CI.

---

## 2. Prohibiciones duras (AuthorizationPolicy)

**Veredicto: PARCIAL.** El comportamiento *declarado y probado por el implementador* es
correcto (los 8 roles, incluido `superadmin`, quedan `denied` para los nombres exactos de
`DEFAULT_HARD_PROHIBITED_ACTIONS`, sin ruta de `resume()`). La auditoría adversarial
encontró que esa protección es evadible por varias vías no obvias — ver AG-01 a AG-05.

## 3. NoFabrication

**Veredicto: PARCIAL.** `NoFabricationPolicy.evaluate()` en sí misma es correcta e
íntegra sobre los valores que recibe (confirmado con prueba propia aislada). El problema es
que es 100% opt-in por herramienta — ver AG-10.

## 4. Guardrail anticorrupción

**Veredicto: PARCIAL.** El mecanismo (patrones + hooks que nunca lanzan, bitácora
auditable) está bien construido y el propio README no pretende que sea más de lo que es.
La suite ">200 prompts" es sintética/circular (generada con el mismo vocabulario de los
regex) y no cubre ofuscación real — ver AG-12. Verificamos 0% de falsos positivos en
lenguaje legítimo de licitaciones ("garantía de cumplimiento", "penalizaciones", "fianzas"),
lo cual sí cumple lo declarado.

## 5. Idempotencia, reintentos, presupuesto, rate limit, timeout/cancelación

**Veredicto: PARCIAL.** El diseño central (retry con backoff+jitter acotado que respeta
`AbortSignal`, idempotencia en proceso que resiste condiciones de carrera reales gracias al
`check-then-set` síncrono, liberación de reserva de presupuesto tras fallo) es correcto y
lo confirmamos con pruebas propias de concurrencia real (`Promise.all`), no solo
secuenciales. El defecto es la falta de validación de entrada (signo/finitud) en
`BudgetLedger`/`TokenBucketRateLimiter` — ver AG-08, AG-09.

## 6. ProviderRouter / OpenAIResponsesProvider

**Veredicto: PARCIAL.** `OpenAIResponsesProvider` construye la solicitud correctamente
(headers, `tools`, `max_output_tokens`, modelo por tier configurable), clasifica 429/5xx
como reintentable y 4xx como no-reintentable, y **no filtra secretos**: no hay ningún
`console.log`/traza que incluya el API key, y `ToolCallTrace` solo persiste hashes sha256
de input/output, nunca el payload completo. El defecto real está en `ProviderRouter`: la
tolerancia cero y el país exigido SÍ se pueden desactivar por configuración — ver AG-06. Un
gap menor de higiene de datos personales en `GuardrailEvent.input` (texto crudo sin hashear,
a diferencia de `ToolCallTrace`) — ver AG-07.

## 7. Calidad de pruebas / mutación

**Veredicto: CUMPLE** en las 5 reglas mutadas (mutation score 5/5): quitar el chequeo de
prohibición dura, desactivar el bloqueo de `organizationId` en el esquema, dejar de exigir
`approvedSourceRef`, ignorar `AbortSignal` en retry, y quitar la guarda de concurrencia de
idempotencia — las 5 mutaciones hicieron fallar la suite oficial (`docs/logs/audit-agents-ronda1.log`,
sección "MUTATION TESTING"). Gaps menores: no hay prueba oficial de concurrencia real a
nivel de `AgentRunner.run()` (solo a nivel de `IdempotencyStore` aislado) — ver AG-13 — y no
hay cobertura ni umbral configurado en CI — ver AG-14.

## 8. Trazabilidad REQ / incidente reportado

**Veredicto: CUMPLE** para el incidente reportado (ver AG-16, sección "Comprobado
correcto"). **PARCIAL** para la trazabilidad formal de REQ-166/168/169/170 de la sección 33,
que no aplican a este paquete pero tampoco están explícitamente descartados por REQ
individual en `docs/ACEPTACION.md` — ver AG-15.

---

## Tabla de hallazgos

| ID | Severidad | Rubro | Hallazgo (evidencia) | Reparación sugerida (separada, no aplicada) | Estado reparación |
|---|---|---|---|---|---|
| AG-01 | ALTA | 2. Prohibiciones duras | `AuthorizationPolicy.decide()` compara `toolName` contra `DEFAULT_HARD_PROHIBITED_ACTIONS` por **nombre exacto**. Una tool registrada con un alias/sinónimo no listado (p. ej. `enviar_paquete_final_al_comprador`) y `riskLevel: "read"` cuyo handler internamente hace lo mismo que `submit_proposal_to_comprasmx` ejecuta libremente. Evidencia: `packages/agents/src/authorization.ts:15-27,98-100`; prueba adversarial propia confirmó `run.status === "completed"` y el handler invocado. | Basar la detección en una categoría de acción declarada explícitamente en `ToolDefinition` (no inferible del nombre libre), o exigir revisión humana de cada `ToolDefinition` nueva contra una allowlist cerrada de nombres/categorías antes de registrar en producción. | **Corregido** — commit `df9f6dc` (nota: aterrizó bundleado dentro del commit de otro agente concurrente en este repo compartido sin worktrees aislados — contenido verificado byte-a-byte idéntico al intentado, ver `git show df9f6dc -- packages/agents`). `actionKind` (enum cerrado) obligatorio en `ToolDefinition`; `AuthorizationPolicy.decide()` deniega por categoría semántica, no solo por nombre. Test: `test/authorization.test.ts` casos "AG-01"; `test/tool-registry.test.ts` describe "AG-01: actionKind obligatorio"; `test/agent-runner.test.ts` "AG-01 (ALTA): un alias con nombre inocuo...". |
| AG-02 | ALTA | 2. Prohibiciones duras | La comparación de `toolName` no normaliza mayúsculas ni Unicode. `Sign_Document` (case distinto) y `ѕign_document` (con "s" cirílica U+0455) no coinciden con `sign_document` y ejecutan sin autorización. Evidencia: `authorization.ts:98`; pruebas adversariales confirmadas para ambos casos. | Normalizar (`toLowerCase()` + NFKC) el `toolName` antes de comparar contra el Set, y hacer que `ToolRegistry.register()` rechace nombres fuera de `[a-z0-9_]` (ASCII, snake_case). | **Corregido** — commit `6d15186`. `AuthorizationPolicy` normaliza (NFKC + minúsculas + sin separadores) antes de comparar; `ToolRegistry.register()` rechaza nombres fuera de ASCII snake_case (cierra el caso homoglifo en origen, ya que NFKC no unifica alfabetos distintos). Test: `test/authorization.test.ts` caso "AG-02 (ALTA)"; `test/tool-registry.test.ts` describe "AG-02 (ALTA): nombres de herramienta ASCII snake_case estrictos". |
| AG-03 | **CRÍTICA** | 2. Prohibiciones duras | `AuthorizationPolicy` acepta `hardProhibitedActions` en su constructor **sin ningún mínimo impuesto**; `new AuthorizationPolicy({ hardProhibitedActions: [] })` desactiva TODAS las prohibiciones duras (enviar oferta, firmar, actuar en portal, contactar terceros) para ese runner, y `AgentRunner` no exige ni verifica ningún suelo. Contradice literalmente REQ-165 ("sin importar el rol... sin ruta de aprobación") interpretado como invariante de sistema, no de configuración. Evidencia: `authorization.ts:84-92`; prueba adversarial confirmó `sign_document` ejecutándose tras reconfigurar. | `AuthorizationPolicy`/`AgentRunner` deben **fusionar siempre** (unión, nunca reemplazo) cualquier `hardProhibitedActions` de opciones con `DEFAULT_HARD_PROHIBITED_ACTIONS`, o lanzar en el constructor si el resultado no es superconjunto del default. | **Corregido** — commit `114a2fb`. El constructor ahora fusiona SIEMPRE (unión) con los defaults congelados; `hardProhibitedActions: []` (o cualquier iterable) ya no reduce el conjunto resultante. Invariante de código, no configuración. Test: `test/authorization.test.ts` casos "AG-03" (incluye el intento con `[]` y con un `Set` de reemplazo completo). |
| AG-04 | MEDIA | 2. Prohibiciones duras | `DEFAULT_HARD_PROHIBITED_ACTIONS` está tipado `ReadonlySet<string>` pero es un `Set` mutable real en runtime (sin `Object.freeze`, y `Set` tampoco respeta `freeze` para sus propios métodos). Cualquier código con una referencia al módulo puede `.delete()`/`.add()` sobre el mismo objeto compartido, afectando a toda `AuthorizationPolicy` nueva construida con valores por defecto en el resto del proceso. Evidencia: `authorization.ts:15`; prueba adversarial confirmó mutación persistente y su efecto en una policy nueva. | Exponer una función `getDefaultHardProhibitedActions()` que retorne una copia nueva (`new Set([...])`) en cada llamada, en vez de una referencia compartida mutable. | **Corregido** (con un mecanismo más fuerte que el sugerido) — commit `01550ad`. En vez de solo retornar copias, `DEFAULT_HARD_PROHIBITED_ACTIONS`/`DEFAULT_PROHIBITED_ACTIONS` se exponen vía un `Proxy` que intercepta `add`/`delete`/`clear` y lanza — inmutabilidad real en runtime, no solo de tipos. Test: `test/authorization.test.ts` casos "AG-04" (confirma que `.add()`/`.delete()`/`.clear()` lanzan y el contenido queda intacto). |
| AG-05 | MEDIA | 2. Prohibiciones duras (límite de diseño) | `AgentRunner` solo evalúa el nombre de la tool_call de nivel superior; un handler "envoltorio" con nombre inocuo puede ejecutar internamente lógica equivalente a firmar/enviar sin pasar nunca por `AuthorizationPolicy` para esa sub-acción. Es un límite arquitectónico inherente a cualquier gate por nombre de tool, no un bug puntual de código. Evidencia: `agent-runner.ts` (`executeStep` solo usa `step.toolName`); prueba adversarial confirmó ejecución de "firma interna" sin autorización. | Checklist de revisión humana obligatoria de cada `ToolDefinition.handler` antes de merge a producción (¿llama a algo que envía/firma/actúa en un portal?), y/o instrumentar un límite de red saliente por `riskLevel` a nivel de proceso/sandbox. | **Mitigado parcialmente (límite arquitectónico reconocido, no resoluble por completo en este paquete)** — commit `480d183`. `ToolDefinition.declaredEffects` (enum cerrado) es obligatorio; `ToolRegistry.register()` rechaza un `riskLevel: "read"` que declare un efecto fuera de `read_only` (contradicción explícita detectada). El caso en que el autor miente en AMBOS campos a la vez sigue sin poder detectarse por código — documentado explícitamente en README, sección "Límite conocido (AG-05)", con la mitigación recomendada (checklist humano/sandbox de red) delegada a `apps/api`. Test: `test/tool-registry.test.ts` describe "AG-05 (MEDIA): declaredEffects obligatorio y consistente con riskLevel". |
| AG-06 | **CRÍTICA** | 6. ProviderRouter | Los 5 componentes de "tolerancia cero" (REQ-125) y el país exigido (`requiredCountry`) son opciones de constructor de `ProviderRouter`. `zeroToleranceComponents: []` hace que `auditor_juez` (y los otros 4) dejen de tratarse como críticos y se enruten a un proveedor no-EE.UU. con solo aportar `gateEvidence`; `requiredCountry: "EU"` permite que el "proveedor por defecto" de tolerancia cero no sea EE.UU. El propio test oficial (`test/llm/router.test.ts:174-187`) demuestra y documenta esta desactivación como comportamiento soportado. Evidencia: `packages/agents/src/llm/router.ts:82-114`; 2 pruebas adversariales confirmadas. | Los 5 componentes de REQ-125 y `requiredCountry: "US"` deben ser **constantes no configurables** del núcleo de `ProviderRouter` (eliminar las opciones), o al menos exigir unión con el default nunca reemplazo, igual que AG-03. | **Corregido** — commit `f8ef82f`. `requiredCountry` ya no existe como opción (país fijo `REQUIRED_COUNTRY_FOR_ZERO_TOLERANCE = "US"`, nunca leído de `options`); `zeroToleranceComponents` solo puede AÑADIR componentes, nunca reemplazar los 5 de REQ-125. Se actualizó el test oficial que demostraba la desactivación (`test/llm/router.test.ts`, antes "permite personalizar la lista..."). Test: casos "AG-06" en `test/llm/router.test.ts`. |
| AG-07 | MEDIA | 6. ProviderRouter / trazabilidad | `GuardrailEvent.input` almacena el texto **completo sin redactar/hashear** del tool_call bloqueado, a diferencia de `ToolCallTrace` (que solo persiste sha256 de input/output). Cualquier dato personal dentro de un intento bloqueado queda en texto plano indefinidamente en memoria, expuesto vía `getAuditLog()`. Evidencia: `packages/agents/src/guardrails/anticorruption.ts:36,134`. | Persistir `inputHash` (sha256, mismo patrón que `ToolCallTrace`) en vez del texto completo, o truncar/redactar antes de guardar en la bitácora auditable persistente. | **Corregido** — commit `f41d3ce`. `GuardrailEvent` ya no tiene el campo `input` con texto crudo: persiste `inputHash` (sha256) e `inputExcerpt` (truncado a 160 caracteres, secuencias de 4+ dígitos enmascaradas). Test: `test/guardrails.test.ts` describe "AG-07 (MEDIA): GuardrailEvent guarda hash + extracto redactado, no el texto crudo". |
| AG-08 | ALTA | 5. Presupuesto | `BudgetLedger.reserve()`/`.consume()` no validan signo ni finitud del monto. Un monto negativo pasa `amountUsd > available` e **incrementa** el presupuesto disponible en vez de gastarlo; un monto `NaN` pasa silenciosamente (`NaN > x` es `false`) y corrompe el ledger de forma permanente. Mitigación parcial: `AgentRunner.executeAuthorized` solo reserva si `costUsd > 0` (`agent-runner.ts:304`), así que la ruta feliz normal no dispara el bug con `estimatedCostUsd` negativo desde un paso — pero la traza persiste el costo negativo sin sanear, y cualquier llamador directo de `BudgetLedger` queda expuesto. Evidencia: `packages/agents/src/budget-ledger.ts:58-78`; 3 pruebas adversariales confirmadas (negativo, NaN, traza sin sanear). | `reserve()`/`consume()` deben lanzar si el monto es `< 0`, `NaN` o no finito; `AgentRunner` debe sanear/rechazar `estimatedCostUsd` negativo antes de persistir la traza. | **Corregido** — commit `4731139`. `reserve()`/`consume()`/`setLimit()` lanzan `InvalidAmountError` si el monto es negativo, `NaN` o infinito (setLimit permite `Infinity` deliberadamente para "sin límite"); `AgentRunner` sanea `estimatedCostUsd` antes de reservar/persistir la traza (el paso falla explícitamente en vez de completar con un costo corrupto). Test: `test/budget-ledger.test.ts` describe "AG-08 (ALTA)"; `test/agent-runner.test.ts` describe "AgentRunner: presupuesto — AG-08 saneamiento de costo negativo/NaN". |
| AG-09 | MEDIA | 5. Rate limit | `TokenBucketRateLimiter.tryConsume()` no valida `tokens >= 0`. Un valor negativo resta un negativo (`bucket.tokens -= tokens`), rellenando el bucket a capacidad máxima al instante sin esperar el refill natural — bypass total del rate limit para esa organización en esa ventana. Explotabilidad actual limitada: `rateLimitTokensPerStep` en `AgentRunRequest` lo define el código integrador, no el modelo. Evidencia: `packages/agents/src/rate-limiter.ts:39-44`; prueba adversarial confirmada (bucket a 0 con refill=0 → vuelve a capacidad completa tras `tryConsume(org,-1000)`). | `tryConsume()` debe rechazar (lanzar o retornar `false`) si `tokens < 0` o no es finito. | **Corregido** — commit `f6a89f1`. `tryConsume()` lanza `InvalidAmountError` si `tokens` es negativo, `NaN`, infinito o no entero. Test: `test/rate-limiter.test.ts` describe "AG-09 (MEDIA): validación de signo/finitud/enteros en tryConsume()". |
| AG-10 | ALTA | 3. NoFabrication | La verificación de no-fabricación es enteramente **opt-in** por herramienta vía `ToolDefinition.extractSensitiveValues`; no existe ningún escaneo automático del `output` en busca de campos sensibles bajo otros nombres (`costo`, `importe`, `vigente_hasta`), anidados en objetos/arrays, o expresados como números en texto libre. Si el autor de una tool omite declarar `extractSensitiveValues`, el valor sensible sin fuente aprobada pasa como `run.status: "completed"` sin ninguna alerta — contradice el criterio "tolerancia cero" de REQ-164 leído de forma literal. Evidencia: `agent-runner.ts:388-407` (el chequeo solo corre `if (tool.extractSensitiveValues)`); prueba adversarial confirmó `compute_price_leaky` (con `costo`/`vigente_hasta` sin fuente, anidados en un array, sin declarar `extractSensitiveValues`) terminando `completed`. No está mencionado en la sección "Pendientes" del README. | Agregar un escaneo heurístico obligatorio (recursivo) del `output` completo que busque las claves conocidas de `SENSITIVE_FIELD_KINDS`/sinónimos configurables y fuerce declaración explícita o bloquee si aparecen sin cobertura; documentar explícitamente en README este riesgo residual mientras no se implemente. | **Corregido** — commit `5dff06e`. `AgentRunner` corre siempre (no opt-in) `scanForUnsourcedSensitiveData()`: recorrido recursivo de objetos/arrays/strings con diccionario de sinónimos y detección de números/fechas sospechosos en texto libre; sin `approvedSourceRef` → `pendiente_no_evaluable`/`needs_data`. Test: `test/no-fabrication.test.ts` describe "AG-10 (ALTA): scanForUnsourcedSensitiveData"; `test/agent-runner.test.ts` describe "AgentRunner: no-fabricación — AG-10 evaluación por defecto" (reproduce `compute_price_leaky` del hallazgo original). |
| AG-11 | MEDIA | 2. Aislamiento de tenant | `ToolRegistry.assertNoForbiddenFields()`/`getZodObjectShape()` solo inspecciona el **primer nivel** del shape del `inputSchema`. Un esquema con `organizationId` anidado en un objeto hijo (p. ej. `z.object({ meta: z.object({ organizationId: z.string() }) } )`) se registra sin lanzar `UnauthorizedToolInputError`, contradiciendo la garantía documentada en el README ("rechaza cualquier esquema de entrada que declare organizationId... o variantes"). No se demostró explotación end-to-end (ningún handler de ejemplo lee ese campo), pero la garantía es más débil de lo documentado. Evidencia: `packages/agents/src/tool-registry.ts:71-79,116-126`; prueba adversarial confirmó el registro sin error. | `assertNoForbiddenFields` debe recorrer recursivamente todas las `ZodObject` anidadas del shape, no solo el nivel raíz. | **Corregido** — commit `b300521`. `findForbiddenFieldRecursive()` recorre recursivamente todas las `ZodObject` anidadas (objetos hijos, arrays de objetos, envolturas optional/nullable/default/effects), no solo el nivel raíz. Test: `test/tool-registry.test.ts` casos "AG-11 (MEDIA)". |
| AG-12 | BAJA | 4. Guardrail | La suite ">200 prompts maliciosos / >100 legítimos" (REQ-072/REQ-114) es sintética y circular: generada por combinación cartesiana de un vocabulario que calca casi literalmente las palabras de los propios `DEFAULT_PATTERNS` que se están probando. No cubre eufemismos fuera de ese vocabulario, inglés más allá de 2 sustantivos aislados, instrucciones partidas en varios pasos/mensajes, ni ofuscación. Evidencia: `test/guardrails.test.ts:84-178`; 4 pruebas adversariales propias confirmaron 0% de detección en eufemismos, inglés natural, instrucción partida en 2 mensajes, y coordinación de precios sin las 3 palabras clave exactas. El propio README es honesto al respecto ("no sustituye un clasificador semántico/LLM... debe añadirse en apps/api"). | Ninguna reparación de código en este paquete puro (correctamente delegado por diseño); en `apps/api` es obligatorio el hook de clasificador semántico antes de considerar cumplido REQ-072/REQ-114 en producción. Adicionalmente, generar la suite de prompts con vocabulario independiente del regex (o con un LLM/tercero) para que la métrica de ≥99% no sea tautológica. | **Test agregado; sin cambio de código en `AntiCorruptionGuardrail` (correctamente delegado, per la propia reparación sugerida)** — commit `1acf087`. Suite de ≥30 casos con vocabulario independiente (eufemismos, ofuscación ortográfica, inglés natural, contextos alternos, mensajes partidos en 2 turnos); detección real reportada sin inflar: **~3% (1/31)**, **0% en los 3 casos partidos**. Brecha documentada en README, sección "Límite conocido (AG-12)". El hook de clasificador LLM/juez calibrado sigue pendiente en `apps/api`. Test: `test/guardrails.test.ts` describe "AG-12 (BAJA): suite adversarial INDEPENDIENTE del vocabulario de los regex". |
| AG-13 | BAJA | 7. Calidad de pruebas | No hay prueba oficial de condición de carrera **real** (`Promise.all`) a nivel de `AgentRunner.run()` con la misma `idempotencyKey`; `agent-runner.test.ts:222-237` solo prueba dos llamadas secuenciales. (`idempotency.test.ts:38-52` sí prueba concurrencia real, pero solo a nivel de `IdempotencyStore` aislado.) Verificamos con una prueba propia vía `Promise.all` que el comportamiento real de `AgentRunner` es correcto (el handler se invoca una sola vez), pero esa garantía no está protegida por ningún test oficial a ese nivel. Evidencia: `packages/agents/test/agent-runner.test.ts:222-237`. | Agregar a `agent-runner.test.ts` un caso con `Promise.all([runner.run(reqA), runner.run(reqB)])` con la misma `idempotencyKey`, para detectar una futura regresión en el orden síncrono de `withIdempotency`. | **Test agregado; sin cambio de código (el comportamiento ya era correcto, era una prueba faltante, no un bug)** — commit `b5c8a38`. Caso `Promise.all([runner.run(reqA), runner.run(reqB)])` con la misma `idempotencyKey` y handler instrumentado (`maxConcurrent`); confirmado estable en 5 corridas repetidas. Test: `test/agent-runner.test.ts` caso "AG-13 (BAJA): condición de carrera REAL vía Promise.all...". |
| AG-14 | BAJA | 1. Reproducibilidad / 7. Calidad de pruebas | El script `test` no incluye `--coverage`; no hay `vitest.config.ts` con umbral mínimo ni gate de CI por cobertura. Cobertura real medida manualmente: Statements 89.87%, Branches 84.51%, Functions 89.62%, Lines 92.59% (razonable, pero `agent-runner.ts` en 74.72% de ramas). Evidencia: `docs/logs/audit-agents-ronda1.log`, sección "vitest --coverage". | Agregar `@vitest/coverage-v8`, un `coverage.thresholds` en `vitest.config.ts` (p. ej. 85% líneas/funciones, 75% ramas) y un script `test:coverage` invocado en CI. | **Corregido (gate de cobertura); CI no aplica — no existe `.github/workflows` en el repo**  — commit `6e0be34`. `@vitest/coverage-v8` agregado; `vitest.config.ts` con `coverage.thresholds` (líneas ≥85%, ramas ≥80%, funciones ≥85%, statements ≥85%); script `test:coverage`. Se verificó que el gate realmente falla (probado con umbral 99.9% → código de salida 1) antes de fijar los valores de producción (código de salida 0 contra la cobertura real: 94.44%/91.28%/93.54%/94.44%). Sin pipeline de CI en el repo para invocarlo automáticamente; documentado en README. |
| AG-15 | BAJA | 8. Trazabilidad REQ | REQ-166 ("elegible=true nunca inventado"), REQ-168 (relevancia/elegibilidad separadas), REQ-169 (métricas honestas) y REQ-170 (6 módulos de back office) —mapeados a la sección 33 del despacho de este paquete— no tienen evidencia dentro de `packages/agents` (esta librería no implementa matching, elegibilidad ni dashboards). No es un defecto del paquete, pero `docs/ACEPTACION.md` no anota explícitamente por REQ qué paquete concentra la evidencia primaria, lo que puede llevar a doble conteo o falsos "cumplidos" al consolidar auditorías de distintos paquetes. | Agregar a `docs/ACEPTACION.md` una columna "paquete responsable" por REQ, coordinada entre los despachos de `packages/agents`, `packages/expediente`, `apps/api` y `apps/web`. | **No corregido — fuera de mi ámbito de corrección.** La reparación exige editar `docs/ACEPTACION.md`, archivo fuera de mi mandato exclusivo (`packages/agents/**` + `docs/logs/fix-agents-*.log` + esta única columna de esta tabla); coordinarlo requiere un despacho transversal entre los agentes de `packages/agents`, `packages/expediente`, `apps/api` y `apps/web`, no una corrección unilateral de este paquete. |
| AG-16 | INFORMATIVO (sin severidad — hallazgo de verificación, no defecto) | 8. Incidente reportado | Se verificó el incidente declarado por el implementador en `docs/PROGRESO.md` línea 32 ("Incidente: borrado accidental de test/llm restaurado y reverificado antes del commit"). Los 3 archivos (`test/llm/fake-provider.test.ts`, `test/llm/openai-responses-provider.test.ts`, `test/llm/router.test.ts`) están presentes en el commit `c56e20f` (63/137/188 líneas respectivamente, confirmado con `git show --stat`), son coherentes (prueban construcción real de request HTTP, mapeo de payload, clasificación 429/5xx, tolerancia cero y 5 gates — no son stubs triviales), y sus 31 pruebas (9+16+6) pasan en la corrida reproducida. Sin indicios de contenido "gutted" tras el restore. | N/A — se registra como verificación positiva, ver "Comprobado correcto". | **N/A — no es un defecto, verificación positiva sin acción de corrección.** |

---

## Comprobado correcto

- **Reproducibilidad exacta**: 13 archivos / 127 pruebas en verde, typecheck/lint/build
  limpios, igual a `docs/logs/agents-ronda1.log` (§1).
- **Incidente de restore de `test/llm/*` verificado sin anomalías** (AG-16).
- **`resume()` de una prohibición dura nunca reactiva la ejecución**, ni con
  `approverId` de rol `superadmin`, para los nombres exactos ya listados en el Set por
  defecto sin reconfigurar (comportamiento base correcto; ver AG-01-04 para las vías de
  evasión del propio Set).
- **Idempotencia en proceso resiste condiciones de carrera reales**: el `check-then-set`
  síncrono de `IdempotencyStore.withIdempotency()` (sin `await` de por medio) hace que una
  segunda llamada concurrente vía `Promise.all` con la misma clave reciba
  `IdempotencyInProgressError` en vez de duplicar el efecto; confirmado con prueba propia a
  nivel de `AgentRunner.run()`, no solo `IdempotencyStore` aislado.
- **Reserva de presupuesto se libera correctamente tras fallo** de la herramienta,
  timeout, cancelación o error de validación de salida (`agent-runner.ts`, todos los
  `catch` relevantes llaman `budgetLedger.release(reservation.id)`).
- **`RetryPolicy` respeta `AbortSignal`** tanto antes del primer intento como durante la
  espera de backoff, con backoff exponencial acotado a `maxDelayMs` y jitter completo
  (`0..delay`) — confirmado con `computeDelay()` y con mutación (AG mutación 4).
- **Aislamiento por organización** en `BudgetLedger` y `TokenBucketRateLimiter` (`org-1`
  agotado no afecta a `org-2`; `null` = ledger/bucket de plataforma propio).
- **`OpenAIResponsesProvider` no filtra secretos**: ningún log/traza incluye el API key;
  `ToolCallTrace` solo persiste sha256 de input/output, nunca el payload completo. Clasifica
  correctamente 429/5xx como reintentable y 4xx como no-reintentable, y nunca llama a
  `fetch` si falta `OPENAI_API_KEY`.
- **Guardrail: 0% de falsos positivos** en lenguaje legítimo de licitaciones verificado con
  prompts propios ("garantía de cumplimiento", "penalizaciones", "fianzas del contrato").
  Un hook que lanza excepción nunca tumba la verificación (`try/catch` silencioso,
  confirmado con test propio adicional al oficial).
- **Mutation testing 5/5**: mutar (1) el chequeo de prohibición dura, (2) el bloqueo de
  `organizationId` en el esquema, (3) la exigencia de `approvedSourceRef`, (4) el respeto de
  `AbortSignal` en retry, y (5) la guarda de concurrencia de idempotencia, hizo fallar la
  suite oficial en los 5 casos — la suite sí detecta regresiones en estas reglas centrales.
- **`ProviderRouter` con configuración por defecto (sin opciones)** enruta correctamente
  los 5 componentes de tolerancia cero solo al proveedor por defecto con
  `countryOfResidence === "US"`, y rechaza explícitamente (`ModelGateFailedError`) el
  enrutamiento alternativo si falta evidencia o falla cualquiera de los 5 gates, sin
  degradar silenciosamente — el defecto (AG-06) es específicamente que esa buena
  configuración por defecto es reemplazable, no que el comportamiento por defecto sea
  incorrecto.
- **README.md transparente**: la sección "Pendientes" declara honestamente que la
  integración real con OpenAI nunca se ejerció contra la red, que el streaming está
  deliberadamente sin implementar, que la verificación de rol del aprobador en `resume()`
  se delega a `apps/api`, y que la verificación LLM del guardrail queda pendiente — ninguno
  de estos puntos se presenta como resuelto cuando no lo está.

---

## Nota metodológica

Todas las pruebas adversariales y las 5 mutaciones se ejecutaron en
`git worktree add <scratchpad>/wt-agents-audit HEAD`, nunca en el árbol principal; el
worktree fue eliminado al finalizar (`git worktree remove --force`) y no se modificó ningún
archivo de `packages/agents/src` ni `packages/agents/test` de forma persistente. El único
archivo de prueba adversarial creado (`test/adversarial-audit.test.ts`) se borró antes de
cerrar el worktree y nunca se commiteó. Este documento y
`docs/logs/audit-agents-ronda1.log` son los únicos artefactos persistentes de esta
auditoría.
