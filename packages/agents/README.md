# @atiende/agents

Librería TypeScript **pura** (sin dependencia de ninguna base de datos) para
ejecutar agentes de IA con autorización, guardrails, idempotencia,
presupuesto, reintentos y trazabilidad completa. `apps/api` es quien la
consume y le provee implementaciones reales de persistencia (Postgres) para
las interfaces `RunStore`/`ToolCallStore` que aquí solo existen en memoria.

Alcance de esta ronda: `packages/agents/**`. No depende de `packages/db` ni
de `apps/api`; solo define contratos (interfaces) que esos paquetes deberán
implementar.

## Pruebas y cobertura

`npm run -w packages/agents test` corre la suite (vitest). `npm run
-w packages/agents test:coverage` corre la misma suite con
`@vitest/coverage-v8` y **falla si la cobertura real cae por debajo del
umbral** configurado en `vitest.config.ts` (AG-14: líneas ≥85%, ramas ≥80%,
funciones ≥85%, statements ≥85% — calibrado con margen contra la cobertura
real medida en esta ronda, ver `docs/logs/fix-agents-ronda1.log`). El
umbral se verificó realmente gatilla el fallo: se probó momentáneamente con
un umbral de 99.9% (que la suite actual no alcanza) y `test:coverage`
terminó con código de salida distinto de cero, antes de fijar los valores
de producción. Este repositorio no tiene todavía un pipeline de CI
(`.github/workflows` no existe); `test:coverage` queda listo para
invocarse en cuanto se agregue uno — mientras tanto, ejecutarlo
manualmente antes de cada release es la única puerta activa.

## Arquitectura

```
src/
  types.ts                    Role, RiskLevel, ModelTier, tipos compartidos
  errors.ts                   Jerarquía de errores + classifyError() (retryable/no)
  tool-registry.ts            ToolRegistry: esquemas zod, riskLevel, idempotent, tenantScoped
  authorization.ts            AuthorizationPolicy: auto/pending/denied + prohibiciones duras
  guardrails/anticorruption.ts AntiCorruptionGuardrail: patrones + hooks extensibles
  no-fabrication.ts           NoFabricationPolicy: valores sensibles con approvedSourceRef
  dependency-invalidation.ts  DependencyInvalidationRegistry: invalida runs por cambio de origen
  idempotency.ts              IdempotencyStore en memoria por [organizationId, key]
  retry.ts                    RetryPolicy: backoff exponencial + jitter
  budget-ledger.ts            BudgetLedger: reserva/consume/límite por organización
                               (AG-08: rechaza montos negativos/NaN/infinitos)
  rate-limiter.ts             TokenBucketRateLimiter por organización
                               (AG-09: rechaza tokens negativos/NaN/infinitos/no-enteros)
  stores.ts                   RunStore/ToolCallStore (interfaces) + implementación en memoria
  tracing.ts                  hashValue/estimateTokens/estimateCostUsd
  agent-runner.ts             AgentRunner: orquesta un AgentRun paso a paso
  llm/
    provider.ts                Interfaz LLMProvider (complete/stream/supportsToolCalls)
    fake-provider.ts           FakeProvider determinista (sin red) para tests/dev
    openai-responses-provider.ts OpenAIResponsesProvider real (fetch a Responses API)
    router.ts                  ProviderRouter: tolerancia cero + 5 gates de modelo alternativo
```

### ToolRegistry (REQ-069)

Cada herramienta declara `inputSchema`/`outputSchema` (zod), `riskLevel`
(`read`/`write`/`external`/`irreversible`), `actionKind` (AG-01: categoría
semántica cerrada de lo que la herramienta REALMENTE hace —
`read`/`write`/`external_send`/`sign`/`portal_action`/`contact_third_party`/
`payment` — obligatoria; `register()` rechaza cualquier herramienta sin un
`actionKind` válido de este enum), `declaredEffects` (AG-05: lista no vacía
del enum cerrado `read_only`/`internal_write`/`external_send`/`sign`/
`portal_action`/`contact_third_party`/`payment` — obligatoria;
`register()` rechaza cualquier herramienta con `riskLevel: "read"` que
declare un efecto fuera de `read_only`, una contradicción explícita entre
"esto solo lee" y "esto también firma/envía/paga"), `idempotent` y
`tenantScoped`.
`register()` también **rechaza cualquier nombre de herramienta fuera de
ASCII snake_case** (`[a-z0-9_]+`, AG-02): esto bloquea en origen tanto
mayúsculas/separadores como homoglifos Unicode (p. ej. una letra cirílica
que visualmente parece latina) que intenten registrar una herramienta cuyo
nombre "parece" uno prohibido sin serlo textualmente. Como defensa adicional
(no sustituta), `AuthorizationPolicy` normaliza (NFKC + minúsculas + sin
separadores) antes de comparar contra las listas de prohibiciones.
`register()` **rechaza** cualquier esquema de entrada que declare
`organizationId`/`tenant_id`/`org_id` (o variantes) **en cualquier
profundidad** (AG-11: recorrido recursivo de objetos anidados y arrays de
objetos, no solo el nivel raíz): el tenant lo inyecta siempre el runtime en
`ToolExecutionContext`, nunca el modelo — mismo patrón que "properties: {}
vacías a propósito" de Likida (`docs/investigacion/likida-arquitectura.md`,
patrón #4).
`validateInput`/`validateOutput` rechazan cualquier `tool_call` cuyos
argumentos no validen contra el esquema.

### AuthorizationPolicy (REQ-044/REQ-046/REQ-068 + ampliación back office)

`decide()` resuelve `auto | pending | denied` en este orden:

1. **Prohibición dura por `actionKind` semántico** (AG-01, REQ-165):
   `HARD_PROHIBITED_ACTION_KINDS` (`external_send`, `sign`, `portal_action`,
   `contact_third_party`) es un enum cerrado **sin ninguna opción de
   constructor** — ni siquiera se puede añadir a esta lista, a diferencia
   de las prohibiciones por nombre. `ToolDefinition.actionKind` declara la
   categoría real de lo que la herramienta hace; `ToolRegistry.register()`
   la exige siempre. Esto cierra el hueco de que un alias/sinónimo con
   nombre inocuo (p. ej. `enviar_paquete_final_al_comprador`) evadiera la
   prohibición por no coincidir con ningún nombre de la lista.
2. **Prohibiciones duras por nombre** (`DEFAULT_HARD_PROHIBITED_ACTIONS`):
   presentar/enviar ofertas, firmar o suplantar firma, actuar en portales
   oficiales, contactar terceros. Siempre `denied`, **sin importar el rol**
   —ni `superadmin`— y sin ruta de aprobación dentro del sistema: solo el
   humano las realiza, y siempre *fuera* del sistema (firma en su propio
   dispositivo, sube el acuse a mano, etc.). `AgentRunner` nunca permite que
   un `resume('approve')` las ejecute, porque nunca llegan a quedar en
   `pendingApprovals` en primer lugar. **Invariante de código (AG-03)**: el
   constructor de `AuthorizationPolicy` solo puede AÑADIR nombres a esta
   lista — pasar `hardProhibitedActions: []` (o cualquier iterable) nunca
   la reemplaza ni la reduce, siempre se une con el default.
2. **Techo de riesgo por rol**: `consultor_externo` es el único rol capado
   en `read` — no puede ni *pedir* nada por encima (REQ-062: "nunca 2/2").
   El resto de roles operativos puede llegar hasta `irreversible` en modo
   `pending`. **Invariante de código (AG-17, ALTA, REQ-062)**: la opción de
   constructor `roleCeiling` solo puede BAJAR (hacer más restrictivo) el
   techo por defecto de un rol, nunca subirlo — a diferencia de
   `hardProhibitedActions`/`prohibitedActions` (AG-03, unión-nunca-reemplazo,
   que no aplica aquí porque `RiskLevel` es un orden total, no un conjunto),
   aquí la invariante se hace cumplir **lanzando `InvalidRoleCeilingError`
   en el constructor** si algún override intenta subir el techo de
   cualquier rol por encima de su default. Como `consultor_externo` ya
   tiene el default más bajo posible (`read`), esto lo vuelve un techo
   verdaderamente invariante: `new AuthorizationPolicy({ roleCeiling: {
   consultor_externo: "irreversible" } })` lanza en vez de crear
   silenciosamente una instancia que rompería REQ-062.
3. **Prohibiciones blandas** (`DEFAULT_PROHIBITED_ACTIONS`: pagar, fijar
   precio final, emitir paquete final): siempre `pending`, pero sí
   ejecutables dentro del sistema una vez que un humano aprueba vía
   `AgentRunner.resume()`.
4. `riskLevel === 'irreversible'` o `'external'`: `pending`.
5. Política específica de la herramienta (`requiresAuthorization` por rol).
6. Si nada de lo anterior aplica: `auto`.

### AntiCorruptionGuardrail (REQ-072/REQ-111-118)

Lista de patrones regex (soborno/dádiva, pago indebido a servidor público,
regalo a funcionario, coordinación de precios con competidor, manipulación
de evaluación/fallo, contacto informal con servidor público) + `hooks`
extensibles (p. ej. un clasificador LLM que `apps/api` agregue después).
Cada bloqueo se registra como `GuardrailEvent` auditable
(`getAuditLog()`); un hook roto nunca tumba la verificación
("registrar/verificar nunca debe lanzar", patrón de
`docs/investigacion/likida-arquitectura.md`). **AG-07**: `GuardrailEvent`
guarda `inputHash` (sha256, mismo patrón que `ToolCallTrace`) e
`inputExcerpt` (extracto truncado a 160 caracteres y con secuencias largas
de dígitos enmascaradas), **nunca** el texto crudo completo del tool_call
bloqueado — evita que datos personales de un intento bloqueado queden en
texto plano indefinidamente en memoria vía `getAuditLog()`.
`test/guardrails.test.ts`
incluye una suite generada de >200 prompts maliciosos y >100 legítimos
(REQ-072/REQ-114: detección ≥99%, falsos positivos ≤2%) — es una capa
determinista de patrones conocidos; **no sustituye** un clasificador
semántico/LLM para intentos no cubiertos por los patrones, que debe
añadirse en `apps/api` vía `addHook()`.

### Límite conocido (AG-12)

La suite de ">200 prompts" de arriba es una combinación cartesiana del
**mismo vocabulario** que `DEFAULT_PATTERNS` — su ≥99% de detección es
tautológico, no una medición independiente. `test/guardrails.test.ts`
también incluye una suite separada de **≥30 casos independientes** del
vocabulario del regex (eufemismos como "endulzarle la mano"/"un pequeño
peaje", ofuscación ortográfica como "s0born0"/"s o b o r n o", inglés
natural más allá de "bribe"/"kickback", contextos alternos como "cobrar"
en vez de "precio/oferta/postura", e instrucciones partidas en 2 mensajes)
que **reporta la tasa de detección real, sin inflarla**: en esta ronda fue
**~3% (1/31)**, y **0% en los 3 casos partidos en 2 mensajes** (el
guardrail no tiene memoria de intención entre llamadas a `check()`, por
diseño). Esto confirma literalmente lo que el README ya admitía: esta capa
es patrones deterministas conocidos, no un clasificador semántico. El
hook de un clasificador LLM/juez calibrado (REQ-127) sigue pendiente en
`apps/api`, fuera del alcance de este paquete puro — ninguna reparación de
código en `packages/agents` puede cerrar esta brecha sin dejar de ser una
capa determinista.

### NoFabricationPolicy (ampliación back office §6)

Cualquier valor de precio, certificación, experiencia, referencia, firma o
vigencia que una herramienta produzca debe venir acompañado de un
`approvedSourceRef` (`{docId, page?, capturedAt}`). Si falta el valor o la
referencia, `evaluate()` retorna `pendiente_no_evaluable` con la lista
exacta de campos faltantes — **nunca** se completa parcialmente con un
valor inventado. Una herramienta puede integrarse de forma explícita
declarando `extractSensitiveValues` en su `ToolDefinition` (máxima
precisión: `kind` correcto, `approvedSourceRef` estructurado).

**AG-10 (REQ-164, evaluación por defecto, no opt-in)**: `AgentRunner`
además corre **siempre** `scanForUnsourcedSensitiveData()` sobre el
`output` completo de cada tool_call, recorriendo recursivamente objetos y
arrays con un diccionario de sinónimos (`precio`/`importe`/`costo`/`monto`/
`tarifa`, `vigencia`/`vigente_hasta`, `certificación`, `referencia`,
`experiencia`, `firma`, etc.) y detectando números/fechas sospechosos en
texto libre que combine una palabra clave sensible. Antes, un valor
sensible bajo un nombre de campo no declarado (`costo` en vez de
`precioUnitario`), anidado en un array, simplemente nunca se evaluaba y la
corrida terminaba `completed`. No existe ningún flag para desactivar este
escaneo por defecto para las categorías sensibles — solo declarar
`extractSensitiveValues` con la fuente correcta hace que un campo cuente
como abastecido. `AgentRunner` evalúa ambos mecanismos después de validar
el `outputSchema` y, si falta algo (por cualquiera de los dos), detiene la
corrida como `needs_data` (el `ToolCallTrace` correspondiente queda en
`pending_no_fabrication` con `missingSourcedFields`). Complementa (no
reemplaza) el guardrail `no_unsourced_claims` de REQ-027/REQ-085, que aplica
a `Claim`s de texto libre, no a valores estructurados.

### DependencyInvalidationRegistry (ampliación back office §3/§7)

Un `AgentRunRequest.dependsOn` declara de qué versión de qué entidad de
origen depende la corrida (p. ej. `{key: "convocatoria-1:bases", version:
"v1"}`). Cuando llega un evento real de cambio (`invalidate(key,
newVersion, reason)`), toda corrida que dependía de una versión anterior
queda marcada `isInvalidated()`. `AgentRunner` revisa esto antes de cada
paso **y** antes de ejecutar un `resume('approve')`: una aprobación humana
que llega después de que las bases cambiaron nunca ejecuta sobre datos
obsoletos — la corrida termina como `invalidated`, no como `completed`.

### AgentRunner (REQ-043/REQ-073/REQ-077/REQ-078/REQ-125/REQ-128)

Ejecuta un `AgentRunRequest.steps` en orden. Por cada paso, en este orden:
invalidación por dependencia → guardrail anticorrupción → validación de
esquema → autorización → idempotencia + rate limit + presupuesto +
reintentos con backoff + timeout/cancelación → validación de esquema de
salida → no-fabricación. Dejamos traza (`ToolCallTrace`) de **cada** paso,
con `inputHash`/`outputHash` (sha256), `attempts`, tokens y costo
estimados, y `correlationId` para enlazar toda la cadena desde la
convocatoria de origen hasta cada artefacto derivado.

Un paso `pending` detiene la corrida en `needs_approval`; `resume(runId,
'approve'|'reject', approverId)` la reanuda **una sola vez** — una segunda
llamada sobre la misma aprobación falla porque la entrada en
`pendingApprovals` ya se consumió (REQ-043: "doble aprobación no duplica
ejecución"). Una `denied` (por prohibición dura o techo de rol) nunca es
bypasseable, ni siquiera desde `resume()`.

### LLMProvider / ProviderRouter (REQ-124/REQ-125/REQ-126)

`ProviderRouter` aplica dos reglas:

1. Los 5 **componentes de tolerancia cero** (`analista_recall`,
   `auditor_juez`, `redactor_legal`, `verificador_entailment`,
   `clasificador_anticolusion`) siempre van al proveedor por defecto, que
   debe declarar `countryOfResidence === REQUIRED_COUNTRY_FOR_ZERO_TOLERANCE`
   (`"US"`, **invariante de código, no configurable** — AG-06: ni el país
   exigido ni la lista de los 5 componentes son opciones de constructor que
   puedan reemplazarse; `zeroToleranceComponents` en `ProviderRouterOptions`
   solo puede **añadir** componentes adicionales, nunca quitar los 5 de
   REQ-125). Ignora cualquier `preferredProviderId` para estos componentes.
2. Cualquier otro componente ("de volumen") solo se enruta a un proveedor
   alternativo si `evaluateModelGates()` confirma que los **5 gates**
   (calidad, cumplimiento de esquema, residencia de datos, suite de
   alineación ≥200 prompts/≤1% rechazo, operación) pasan **todos**. Si
   falta evidencia o falla cualquier gate, se lanza `ModelGateFailedError`
   en vez de degradar silenciosamente al proveedor por defecto.

`OpenAIResponsesProvider` construye la solicitud real contra
`https://api.openai.com/v1/responses` (modelo por `ModelTier`, mensajes,
`tools`, `max_output_tokens`), lee `OPENAI_API_KEY` de variables de entorno
(nunca hardcodeada) y clasifica 429/5xx como reintentable
(`RetryableProviderError`) y 4xx como no reintentable
(`NonRetryableProviderError`). `FakeProvider` es determinista y nunca toca
la red — para tests y desarrollo sin credenciales.

## Cómo lo consumirá `apps/api`

1. Implementar `RunStore`/`ToolCallStore` contra Postgres, siguiendo el
   patrón `agent_runs`/`tool_calls` de
   `docs/investigacion/likida-arquitectura.md` (`organization_id` nullable
   = corrida de plataforma; `unique(tool_name, run_id)` para idempotencia
   real en base, más allá de la `IdempotencyStore` en memoria de este
   paquete que solo cubre la vida de un proceso).
2. Registrar las herramientas de negocio reales en un `ToolRegistry`,
   inyectando `organizationId` desde el JWT/sesión autenticada en
   `ToolExecutionContext` — nunca desde argumentos del modelo.
3. Instanciar `OpenAIResponsesProvider` con `OPENAI_API_KEY` real de
   entorno/secret manager, y envolverlo en `ProviderRouter` junto con
   cualquier proveedor alternativo de volumen (con su evidencia de gates
   documentada en `tasks/evidence/`, per REQ-126).
4. Exponer `AgentRunner.resume()` detrás de los endpoints de aprobación del
   back office (con verificación de rol/re-autenticación para
   riesgo `irreversible`, per REQ-044).
5. Llamar `DependencyInvalidationRegistry.invalidate()` desde el pipeline de
   ingesta cuando detecte una nueva versión de bases/plazo (ver
   `packages/sources`), y registrar `dependsOn` al crear cada
   `AgentRunRequest` derivado de una convocatoria.

## Límite conocido (AG-05)

`AgentRunner.executeStep` solo evalúa el nombre/`actionKind`/`riskLevel` de
la tool_call de nivel superior. Un handler "envoltorio" con
`riskLevel: "read"`, `actionKind: "read"` y `declaredEffects: ["read_only"]`
que MIENTE en los tres campos a la vez (es decir, que internamente ejecuta
lógica equivalente a firmar/enviar/pagar sin que ninguno de sus metadatos
declarados lo refleje) puede ejecutar sin pasar por `AuthorizationPolicy`
para esa sub-acción. Esto es un límite arquitectónico inherente a
cualquier gate basado en metadatos que el propio autor de la herramienta
declara — no un bug puntual de código, y `declaredEffects` (AG-05) no lo
resuelve por completo: solo detecta la contradicción cuando el autor
declara honestamente AL MENOS uno de los dos campos (`riskLevel` o
`declaredEffects`) de forma inconsistente con el otro. Mitigación
obligatoria fuera de este paquete: checklist de revisión humana de cada
`ToolDefinition.handler` antes de merge a producción (¿llama a algo que
envía/firma/actúa en un portal/paga, sin que `actionKind`/`declaredEffects`
lo reflejen?), y/o instrumentar un límite de red saliente por `riskLevel` a
nivel de proceso/sandbox en `apps/api`.

## Pendientes

- **Integración real con OpenAI Responses API sin ejercitar contra
  credenciales de producción.** `OpenAIResponsesProvider` está implementado
  contra la forma documentada de la API y probado con `fetch` simulado
  (429/5xx/mapeo de payload), pero **nunca se ha llamado a la red real** —
  eso requiere `OPENAI_API_KEY` de producción (decisión reservada al
  fundador, REQ-130). Que la suite pase con `FakeProvider`/`fetch` mockeado
  **no certifica** la integración real.
- **Streaming real de OpenAI Responses API**: `OpenAIResponsesProvider.stream()`
  lanza `MissingCredentialsError` deliberadamente — no está implementado
  hasta validar el formato real de streaming de la API contra credenciales
  reales.
- **Persistencia real de `RunStore`/`ToolCallStore`/`IdempotencyStore`**:
  esta ronda solo entrega interfaces + implementación en memoria, correcta
  para pruebas de este paquete pero que no sobrevive un reinicio de
  proceso. `apps/api`/`packages/db` deben proveer las implementaciones
  contra Postgres.
- **Verificación LLM del guardrail anticorrupción**: la capa actual es
  regex + hooks extensibles; para prompts adversariales no cubiertos por
  los patrones conocidos hace falta un hook con un clasificador LLM/juez
  calibrado (REQ-127), fuera del alcance de este paquete puro.
- **Verificación de rol del aprobador en `resume()`**: hoy `resume()` recibe
  `approverId` como string libre para trazabilidad, pero no valida contra
  un directorio de roles/permisos (eso vive en `apps/api`, que sí conoce la
  sesión autenticada) que el aprobador tenga el rol correcto para esa
  aprobación específica (p. ej. re-autenticación passkey/OTP para 2/2
  económica, REQ-044).
- **Cascada de modelos caro→medio→barato ante 429/5xx (REQ-078)**:
  `ProviderRouter` resuelve *a qué proveedor* enrutar; la cascada dinámica
  de reintento entre niveles de modelo ante fallos del proveedor principal
  queda para que `apps/api` la orqueste combinando `RetryPolicy` +
  `ProviderRouter` con más de un `ModelTier` por intento.
