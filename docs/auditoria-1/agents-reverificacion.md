# Reverificación adversarial — packages/agents (ronda de corrección)

**Ámbito**: `packages/agents/**` en el estado tras la ronda de corrección cuyo último
commit citado es `6e0be34` (AG-14). Reverificación ejecutada en un `git worktree`
separado (`git worktree add <scratchpad>/reverify-agents HEAD`), `npm install` dentro
del worktree, nunca en el árbol principal; el worktree se eliminó al terminar. En el
repo principal solo se escribieron/commitearon este documento y
`docs/logs/reverify-agents-ronda1.log`.

**Reverificador**: agente Sonnet independiente, sin participación en la construcción
ni en la corrección de `packages/agents`. Repite los 16 hallazgos AG-01..AG-16 de
`docs/auditoria-1/agents.md`, ejecuta los tests citados en la columna "Estado
reparación", reintenta el ataque original de cada uno y agrega variantes nuevas no
probadas por el auditor original (30 pruebas adversariales propias en
`test/reverify-adversarial.test.ts`, creado y ejecutado solo en el worktree, borrado
antes de cerrarlo — nunca commiteado). Comandos y salida completa:
`docs/logs/reverify-agents-ronda1.log`.

**Nota sobre el repo compartido**: este repositorio recibe commits concurrentes de
otros agentes (`git log` movió de HEAD durante esta ronda). Se confirmó que el commit
`6e0be34` es ancestro de cualquier HEAD observado durante la reverificación
(`git merge-base --is-ancestor 6e0be34 <HEAD>` → sí) antes de crear el worktree.

---

## Resumen ejecutivo

Los 14 hallazgos con corrección de código (AG-01 a AG-14, excluyendo AG-15/AG-16 que
son "no aplica"/informativo) están **genuinamente corregidos para el ataque exacto que
el auditor original documentó**: los 14 commits citados existen, tocan los archivos que
dicen tocar (`git show --stat`), y los tests citados existen y pasan (182/182,
`13 archivos`, típecheck/lint/build limpios, cobertura 94.44%/91.28%/93.54%/94.44%,
igual a lo declarado por el implementador). El gate de cobertura (AG-14) se
reverificó de forma independiente: subir el umbral a 99.9% en el worktree produce
código de salida 1 con el mensaje exacto de vitest; el umbral de producción
(85/80/85/85) pasa con código de salida 0.

Sin embargo, la reverificación adversarial encontró que **el patrón de "invariante de
código, unión nunca reemplazo" que AG-03/AG-06 establecieron como el estándar de
reparación NO se aplicó de forma consistente a todo el resto de superficie de
configuración equivalente**, y que **la recursividad agregada por AG-10/AG-11 sigue
teniendo huecos estructurales del mismo tipo que originaron esos hallazgos, solo que
en formas de datos/esquema distintas**:

- `AuthorizationPolicy`'s `roleCeiling` (opción de constructor ya existente, no tocada
  por ninguna corrección) hace `{ ...default, ...override }` — reemplazo total por rol,
  no unión — permitiendo subir el techo de `consultor_externo` a `irreversible` y
  romper REQ-062 ("nunca 2/2") con una única opción de constructor documentada.
  Es el mismo patrón de bug que AG-03/AG-06, sin corregir, porque nunca fue
  auditado (AG-17 nuevo, **ALTA**).
- Los `Set` normalizados **por instancia** de `AuthorizationPolicy`
  (`normalizedHardProhibitedActions`, etc.) no están protegidos por el `Proxy` que
  AG-04 aplicó solo a los `Set` **por defecto a nivel de módulo**: cualquier código con
  una referencia a la instancia puede `.delete()` una prohibición vía acceso de
  reflexión a un campo `private` de TypeScript (que en runtime es una propiedad JS
  normal) (AG-18 nuevo, MEDIA).
- `scanForUnsourcedSensitiveData` (AG-10) recorre objetos/arrays planos, pero un valor
  sensible dentro de un `Map`, `Set` o `Buffer` no tiene propiedades enumerables
  propias vía `Object.entries()` y pasa sin ningún hallazgo (AG-19 nuevo, MEDIA).
- `findForbiddenFieldRecursive` (AG-11) recorre `ZodObject`/`ZodArray`/wrappers de una
  capa, pero no `ZodUnion`/`ZodRecord`/`ZodIntersection`/`ZodTuple`: un
  `organizationId` dentro de una rama de `z.union([...])` o de un
  `z.record(z.string(), z.object({organizationId}))` se registra sin lanzar (AG-20
  nuevo, MEDIA).

Además se confirmó una **regresión real**: `apps/worker/src/handlers/run-agent.ts`
(commit `069f690`, creado ANTES del fix de AG-05 `480d183` en este repo compartido sin
coordinación entre agentes) registra su única herramienta (`llm_complete`) sin
`declaredEffects`, campo que AG-05 volvió obligatorio. Esto rompe `typecheck`, `build`
y 3/36 tests de `apps/worker` (ver sección "Regresiones").

**Conteo de veredictos**: 11 CERRADO · 3 PARCIAL (AG-05 ya era parcial reconocido;
AG-10 y AG-11 tienen huecos nuevos) · 0 NO CERRADO · 2 NO APLICA (AG-15, AG-16).
**4 hallazgos nuevos** (AG-17 ALTA, AG-18/19/20 MEDIA). **1 regresión real** confirmada
(apps/worker).

---

## Reproducibilidad (repetida de forma independiente)

| Paso | Resultado |
|---|---|
| `npm install` en worktree nuevo | OK |
| `npm run -w packages/agents typecheck` | OK, sin errores |
| `npm run -w packages/agents lint` | OK, sin hallazgos |
| `npm run -w packages/agents test` | **13 archivos / 182 pruebas, todas en verde** (127 originales + 55 agregadas por la corrección) |
| `npm run -w packages/agents build` | OK |
| `npm run -w packages/agents test:coverage` | Statements 94.44% · Branches 91.28% · Funcs 93.54% · Lines 94.44% — **idéntico** a lo declarado en el README/commit `6e0be34` |
| Gate de cobertura: umbral mutado a 99.9% en `vitest.config.ts` (worktree) | **Falla con código de salida 1** y mensaje `ERROR: Coverage for lines (94.44%) does not meet global threshold (99.9%)` (y los otros 3). Se restauró el umbral de producción tras la prueba. Confirma que el gate no es decorativo. |
| `npm run -w apps/worker typecheck` | **FALLA** (regresión, ver abajo) |
| `npm run -w apps/api typecheck` | OK (apps/api todavía no importa `@atiende/agents`, confirmado con `grep -rl "@atiende/agents" apps/api/src apps/api/test` → vacío) |

---

## Tabla de hallazgos (AG-01 a AG-16)

| ID | Severidad | Commit citado existe y toca lo que dice | Test citado existe y pasa | Ataque original reintentado | Variante nueva probada | Veredicto |
|---|---|---|---|---|---|---|
| AG-01 | ALTA | Sí, `df9f6dc` (bundleado con otro commit del repo compartido, confirmado con `git show --stat` — toca `authorization.ts`, `tool-registry.ts`, `types.ts`, `errors.ts` + tests) | Sí, `test/authorization.test.ts` casos "AG-01" (líneas 136/149/188), `test/tool-registry.test.ts` "AG-01: actionKind obligatorio", `test/agent-runner.test.ts` "AG-01 (ALTA)" — todos en el run de 182 verdes | Alias con nombre inocuo y `actionKind: "external_send"` sigue `denied` (confirmado con prueba propia) | Nombre visualmente confuso (`subrnit_proposal_to_portal`, "rn" por "m") con `actionKind` honesto **sigue bloqueado** — la detección por `actionKind` es independiente del nombre, como se espera | **CERRADO** |
| AG-02 | ALTA | Sí, `6d15186`, toca `authorization.ts` (normalización) + `tool-registry.ts` (`VALID_TOOL_NAME`) | Sí, ambos describe existen y pasan | `Sign_Document`/homoglifo cirílico ya no evaden (confirmado) | Nombre ASCII con `0`/`o` y `rn`/`m` (substitución visual, no homoglifo real): correctamente **NO** normaliza como el mismo nombre (`normalizeToolName("subrnit") !== normalizeToolName("submit")`) — es un string ASCII distinto, no una evasión, así que el comportamiento correcto es que sea un nombre nuevo válido, no que colisione | **CERRADO** |
| AG-03 | CRÍTICA | Sí, `114a2fb`, toca `authorization.ts` (`unionWithDefaults`) | Sí, casos "AG-03" (líneas 94/102/114) pasan | `hardProhibitedActions: []` y un `Set` completo de reemplazo ya no reducen el default (confirmado) | Reflexión directa sobre el campo `private` de TS (`(policy as any).normalizedHardProhibitedActions.delete(...)`) **SÍ logra borrar la prohibición de esa instancia** — el ataque original (opción de constructor) está cerrado, pero la instancia sigue sin ser un objeto realmente inmutable en runtime a diferencia de los defaults de módulo (AG-04). Ver AG-18 nuevo. | **CERRADO** (para el ataque original vía opciones del constructor); ver AG-18 para el gap nuevo relacionado |
| AG-04 | MEDIA | Sí, `01550ad`, toca `authorization.ts` (`freezeSet` con `Proxy`) | Sí, casos "AG-04" (líneas 172/182) pasan | `.add()`/`.delete()`/`.clear()` sobre `DEFAULT_HARD_PROHIBITED_ACTIONS` lanzan (confirmado) | `Object.defineProperty` para intentar reemplazar `add` en el Proxy: **también lanza** (el Proxy intercepta el `get`, no solo la llamada). `structuredClone()` sí produce una copia mutable normal, pero **no afecta el original exportado** (confirmado: `DEFAULT_HARD_PROHIBITED_ACTIONS.has("sign_document")` sigue `true` tras mutar el clon) | **CERRADO** |
| AG-05 | MEDIA (límite de diseño) | Sí, `480d183`, toca `tool-registry.ts`/`types.ts` (`declaredEffects`) | Sí, describe "AG-05 (MEDIA)" pasa | Handler-envoltorio con `riskLevel`/`actionKind`/`declaredEffects` TODOS mintiendo a la vez sigue ejecutando la sub-acción real sin pasar por `AuthorizationPolicy` (confirmado, **exactamente igual que documenta el propio README** en "Límite conocido (AG-05)") | Mismo resultado reproducido: el wrapper con los 3 campos honestos en apariencia (`read`/`read`/`["read_only"]`) pero que ejecuta lógica de firma internamente se autoriza `auto` y el handler corre sin gate — **límite arquitectónico reconocido, no una regresión** | **PARCIAL** (sin cambio de veredicto: el propio implementador y el auditor original ya clasifican esto como límite de diseño no resoluble en este paquete, documentado honestamente) |
| AG-06 | CRÍTICA | Sí, `f8ef82f`, toca `llm/router.ts` (`REQUIRED_COUNTRY_FOR_ZERO_TOLERANCE` fijo) | Sí, casos "AG-06" (líneas 175/200) pasan | `zeroToleranceComponents: []` ya no quita los 5 componentes; `requiredCountry: "EU"` (no tipado) ya no se lee (confirmado) | Proveedor con `countryOfResidence: "US "` (espacio final) o `"us"` (minúsculas): la comparación estricta (`!==`) los trata correctamente como **no conformes** y lanza `NoCompliantProviderError` — **falla cerrado**, no es una vía de evasión (comparación exacta funciona en la dirección segura) | **CERRADO** |
| AG-07 | MEDIA | Sí, `f41d3ce`, toca `guardrails/anticorruption.ts` (`inputHash`/`inputExcerpt`) | Sí, describe "AG-07 (MEDIA)" pasa | Revisión de código confirma que `GuardrailEvent` ya no tiene el campo `input` con texto crudo, solo `inputHash` (sha256) e `inputExcerpt` (truncado a 160 chars, dígitos de 4+ enmascarados) | No se requiere variante adicional: el cambio es estructural (campo eliminado del tipo) y no configurable, por lo que no hay superficie de evasión análoga a AG-03/06 | **CERRADO** |
| AG-08 | ALTA | Sí, `4731139`, toca `budget-ledger.ts` (`assertValidAmount`) + `agent-runner.ts` (saneamiento) | Sí, describe "AG-08 (ALTA)" en `budget-ledger.test.ts` y en `agent-runner.test.ts` pasan | `reserve(-1000)`/`consume(NaN)` lanzan `InvalidAmountError` (confirmado) | `-0`: pasa la validación pero es benigno (equivalente numérico a 0, no incrementa el presupuesto disponible). `1e309` (= `Infinity` en JS): **rechazado** (`!Number.isFinite`). `BigInt` (vía `as unknown as number`, bypaseando el tipo): **rechazado** (falla `Number.isFinite`/comparación, aunque por una vía distinta al mensaje literal) | **CERRADO** |
| AG-09 | MEDIA | Sí, `f6a89f1`, toca `rate-limiter.ts` (`tryConsume`) | Sí, describe "AG-09 (MEDIA)" pasa | `tryConsume(org, -1000)` lanza en vez de rellenar el bucket (confirmado) | `-0`: pasa pero es no-op real (no rellena el bucket, confirmado midiendo tokens disponibles antes/después). `1e309`/`BigInt`: **rechazados** | **CERRADO** |
| AG-10 | ALTA | Sí, `5dff06e`, toca `no-fabrication.ts` (`scanForUnsourcedSensitiveData`) + `agent-runner.ts` (siempre invocado) | Sí, describe "AG-10 (ALTA)" en `no-fabrication.test.ts` y "AG-10 evaluación por defecto" en `agent-runner.test.ts` pasan | `compute_price_leaky` original (campo `costo` no declarado, anidado en array, sin `extractSensitiveValues`) ahora es detectado y bloquea `needs_data` (confirmado) | **Bypass confirmado**: un `Map`/`Set` que contiene `{precio: 999999}` produce **0 hallazgos** (`Object.entries()` de un `Map`/`Set` no expone su contenido interno, solo propiedades propias enumerables, que no tiene ninguna). Un `Buffer` con el precio serializado dentro también produce 0 hallazgos. Campo con typo `precio_unit` **SÍ se detecta** (substring del sinónimo `precio`). JSON serializado dentro de un string **solo** se detecta si el número tiene formato reconocible (`$`, sufijo de moneda, fecha ISO); un `JSON.stringify({precio: 999999})` sin ese formato no dispara la heurística de texto libre (limitación ya inherente al diseño heurístico, no nueva) | **PARCIAL** — el caso reportado originalmente está cerrado; ver AG-19 nuevo para el bypass de `Map`/`Set`/`Buffer` |
| AG-11 | MEDIA | Sí, `b300521`, toca `tool-registry.ts` (`findForbiddenFieldRecursive`) | Sí, casos "AG-11 (MEDIA)" pasan | `z.object({meta: z.object({organizationId: z.string()})})` ahora sí lanza `UnauthorizedToolInputError` (confirmado, caso de control positivo también reproducido en esta reverificación) | **Bypass confirmado**: `z.union([z.object({foo}), z.object({organizationId})])` y `z.record(z.string(), z.object({organizationId}))` se registran **sin lanzar** — `findForbiddenFieldRecursive` no desciende a `ZodUnion`/`ZodRecord`/`ZodIntersection`/`ZodTuple`, el mismo tipo de hueco de recursividad que originó AG-11, en combinadores distintos | **PARCIAL** — el caso reportado originalmente (objeto anidado directo) está cerrado; ver AG-20 nuevo |
| AG-12 | BAJA | Sí, `1acf087`, agrega la suite independiente a `test/guardrails.test.ts` (sin tocar `anticorruption.ts`, correctamente delegado) | Sí, describe "AG-12 (BAJA)" pasa | Medido de forma independiente en esta reverificación (mismo run oficial): **1/31 (3.2%)** de detección en la suite de vocabulario independiente, **0/3** en los mensajes partidos en 2 turnos — coincide EXACTAMENTE con lo reportado (~3%, 1/31) | Ver sección "¿Qué significa ese 3%?" abajo | **CERRADO** (el alcance de esta corrección era agregar una medición honesta, no cambiar el guardrail — cumplido) |
| AG-13 | BAJA | Sí, `b5c8a38`, agrega caso a `agent-runner.test.ts` | Sí, pasa dentro del run de 182 | Confirmado con el run oficial (el nuevo caso usa `Promise.all` con la misma `idempotencyKey` y un handler instrumentado) | No se requiere variante adicional (era una prueba faltante, no un bug de código) | **CERRADO** |
| AG-14 | BAJA | Sí, `6e0be34`, agrega `vitest.config.ts` con `coverage.thresholds` + `test:coverage` | N/A (es infraestructura de test, no un test individual) | Confirmado de forma independiente: cobertura real 94.44%/91.28%/93.54%/94.44% pasa contra el umbral 85/80/85/85 | Mutación propia: subir el umbral a 99.9% en el worktree **hace fallar** `test:coverage` con código de salida 1 (ver tabla de reproducibilidad) — el gate no es decorativo | **CERRADO** |
| AG-15 | BAJA | N/A — hallazgo de trazabilidad documental, no de código | N/A | N/A | N/A | **NO APLICA** (confirmado: fuera del mandato de corrección de este paquete, correctamente etiquetado como tal por el implementador) |
| AG-16 | INFORMATIVO | N/A — verificación positiva | N/A | Los 3 archivos de `test/llm/*` siguen presentes y coherentes en el HEAD actual | N/A | **NO APLICA** (verificación positiva, sin acción de corrección esperada ni pendiente) |

---

## ¿Qué significa el ~3% de detección de AG-12? ¿El guardrail regex es útil o decorativo?

Medido de forma independiente en esta reverificación (mismo test oficial, mismo run):
**1 de 31 prompts adversariales con vocabulario independiente del regex fue detectado
(3.2%)**, y **0 de 3 mensajes partidos en 2 turnos** fueron detectados. Esto confirma
al dígito el número que el implementador reportó, sin inflarlo.

Interpretación honesta: `AntiCorruptionGuardrail` es un **filtro de palabras clave
literal** (regex sobre `DEFAULT_PATTERNS`), no un clasificador semántico. Es:

- **Útil** contra el ataque más simple y más probable en la práctica: un usuario o un
  LLM mal alineado que use directamente el vocabulario obvio ("soborno",
  "dádiva a funcionario", "coordinar precios con el competidor") — ese vocabulario SÍ
  se bloquea (la suite ">200 prompts" cartesiana original, aunque tautológica en su
  construcción, sí demuestra que el regex cubre bien su propio vocabulario, y el 0% de
  falsos positivos en lenguaje legítimo de licitaciones es una propiedad real y
  valiosa: no bloquea "garantía de cumplimiento" ni "penalizaciones").
- **Prácticamente decorativo** contra cualquier adversario con un mínimo de esfuerzo
  de reformulación: eufemismos ("endulzarle la mano"), errores ortográficos
  deliberados ("s0born0"), inglés natural más allá de 2 palabras aisladas, o instrucción
  partida en 2 mensajes (el guardrail no tiene memoria de intención entre llamadas a
  `check()` — esto es un límite de diseño explícito, no un bug). 3% de detección real
  significa que **97% de las formas más obvias de evadirlo, evaden**.

Ni el README ni la corrección pretenden lo contrario: ambos declaran explícitamente
que esta capa "no sustituye un clasificador semántico/LLM" y que ese hook queda
pendiente en `apps/api` (REQ-127). El riesgo real no está en `packages/agents` sino en
que, **mientras ese hook no exista en `apps/api`**, el guardrail vigente en producción
tendría esta misma tasa de ~3% contra cualquier intento de corrupción mínimamente
disfrazado — y no hay ningún control compensatorio (revisión humana, clasificador de
segunda línea) documentado como obligatorio antes de ir a producción con agentes que
puedan iniciar acciones `pending`/`auto` de riesgo.

---

## Hallazgos nuevos (AG-17 a AG-20)

> **Nota (ronda de corrección posterior a esta reverificación)**: la columna
> "Estado reparación" se agregó en esta ronda para dar seguimiento a los 4
> hallazgos nuevos, siguiendo el mismo formato que la tabla de
> `docs/auditoria-1/agents.md`. El resto del texto de esta sección
> (columnas "Hallazgo (evidencia)" y "Reparación sugerida") es el original
> de la reverificación, sin alterar.
>
> **Nota de transparencia sobre los commits**: el mandato de esta ronda pide
> pathspec `-- packages/agents docs/auditoria-1/agents-reverificacion.md
> docs/logs/fix-agents-ronda2.log` por commit. Como `packages/agents` es un
> directorio, `git commit -- packages/agents ...` captura el estado COMPLETO
> del árbol de trabajo bajo ese directorio en ese momento, no solo los
> archivos que se pretendía aislar para un hallazgo puntual. El código de
> AG-17, AG-19 y AG-20 ya estaba implementado en el árbol de trabajo antes
> del primer commit de esta ronda, así que el commit `fix(agents): AG-17 ...`
> terminó incluyendo también el código+tests de AG-19 y AG-20 (verificado:
> ese commit sí falla contra el código previo para los 3 hallazgos, ver
> `docs/logs/fix-agents-ronda2.log`). AG-18 se separó correctamente en su
> propio commit posterior porque su código se re-aplicó después de ese
> primer commit. Esta nota documenta la desviación honestamente en vez de
> fabricar commits de AG-19/AG-20 sin diff real.

| ID | Severidad | Hallazgo (evidencia) | Reparación sugerida (separada, no aplicada) | Estado reparación |
|---|---|---|---|---|
| AG-17 | **ALTA** | `AuthorizationPolicy` acepta `options.roleCeiling` y hace `this.roleCeiling = { ...ROLE_RISK_CEILING, ...options?.roleCeiling }` — **reemplazo total por rol, no unión** (a diferencia de `hardProhibitedActions`/`prohibitedActions`, ya corregidos en AG-03, y de `zeroToleranceComponents`, corregido en AG-06). `new AuthorizationPolicy({ roleCeiling: { consultor_externo: "irreversible" } })` hace que `consultor_externo` deje de estar capado en `read` y pueda solicitar/llegar a `pending`/`auto` en riesgo `irreversible`, rompiendo literalmente REQ-062 ("nunca 2/2", "el único rol capado en read"). Esta opción de constructor **ya existía antes de la ronda de corrección** y ningún AG-01..16 la señaló ni ningún commit la tocó. Evidencia: `packages/agents/src/authorization.ts:171-190`; prueba propia confirmó `decision.decision !== "denied"` para `consultor_externo`/`irreversible` tras el override. | Aplicar el mismo patrón de AG-03: el constructor solo debe poder **reducir** (hacer más restrictivo) el techo de un rol respecto al default, nunca elevarlo — p. ej. `roleCeiling[role] = min(RISK_LEVEL_ORDER, default, override)` por `RISK_LEVEL_ORDER`, o prohibir explícitamente cualquier override de `consultor_externo` por ser la garantía específica de REQ-062. | **Corregido** — `AuthorizationPolicy` ahora valida cada entrada de `options.roleCeiling` contra `ROLE_RISK_CEILING` y **lanza `InvalidRoleCeilingError`** si el override subiría el techo de cualquier rol por encima de su default (bajar el techo sigue permitido libremente); como `consultor_externo` ya tiene el default mínimo (`read`), esto lo vuelve invariante de facto. Test: `test/authorization.test.ts` describe "AG-17 (ALTA, REQ-062)" (intento de subir el techo de `consultor_externo`/otros roles → throw; bajar el techo → permitido; REQ-062 se mantiene tras el rechazo). |
| AG-18 | MEDIA | Los `Set` normalizados **por instancia** de `AuthorizationPolicy` (`normalizedHardProhibitedActions`, `normalizedProhibitedActions`, y sus versiones no normalizadas) son `Set` mutables planos, no envueltos en el `Proxy` de `freezeSet()` que AG-04 aplicó solo a las constantes **de módulo** (`DEFAULT_HARD_PROHIBITED_ACTIONS`/`DEFAULT_PROHIBITED_ACTIONS`). Como son campos `private` de TypeScript (protección solo de compilación, no de runtime), cualquier código con una referencia a la instancia puede `(policy as any).normalizedHardProhibitedActions.delete(normalizeToolName("sign_document"))` y la prohibición desaparece para esa instancia — sin pasar por ninguna opción pública del constructor. Evidencia: `packages/agents/src/authorization.ts:165-190`; prueba propia confirmó que tras la reflexión, `decide()` deja de retornar `denied` para `sign_document`. Nota: distinto del ataque de prototype-pollution sobre `Set.prototype.has` (también confirmado posible, pero es un límite fundamental de JS con ejecución de código compartida en el mismo proceso, no específico de este paquete — no se propone reparación para ese caso). | Envolver también los `Set` por-instancia (`hardProhibitedActions`, `normalizedHardProhibitedActions`, `prohibitedActions`, `normalizedProhibitedActions`) con el mismo `freezeSet()`/`Proxy` ya usado para los defaults de módulo, o migrar a campos verdaderamente privados de JS (`#hardProhibitedActions`) en vez de `private` de TypeScript. | **Corregido** — los 4 `Set` por-instancia ahora se construyen con el mismo `freezeSet()`/`Proxy` que ya protegía los defaults de módulo (AG-04): `.add()`/`.delete()`/`.clear()` lanzan por reflexión igual que antes solo lanzaban en los defaults. Además, `Object.freeze(this)` al final del constructor bloquea también la REASIGNACIÓN de cualquier campo por reflexión (`(policy as any).campo = x`), cerrando el hueco más allá de lo pedido por el hallazgo. Test: `test/authorization.test.ts` describe "AG-18 (MEDIA)" (reflexión sobre las 4 colecciones + reasignación de campo). |
| AG-19 | MEDIA | `scanForUnsourcedSensitiveData()` (AG-10) recorre `Array.isArray(value)` y `typeof value === "object"` usando `Object.entries(obj)` — esto **no expone el contenido** de un `Map` o `Set` (sus entradas no son propiedades propias enumerables), ni el de un `Buffer`/`Uint8Array` (expone índices numéricos de bytes, no las claves originales del payload serializado dentro). Un `output` de herramienta que envuelva un precio/vigencia/certificación dentro de un `Map`, `Set` o `Buffer` produce **0 hallazgos**, contradiciendo la garantía "sin opt-out, recorrido recursivo obligatorio" para ese caso concreto (aunque el caso reportado originalmente por el auditor —objeto/array plano anidado— sí está cerrado). Evidencia: `packages/agents/src/no-fabrication.ts:192-220`; 3 pruebas propias confirmaron 0 hallazgos con `new Map([["precio", 999999]])`, `new Set([{precio: 999999}])` y `Buffer.from(JSON.stringify({precio: 999999}))` como valor de un campo del `output`. | Agregar casos especiales en `walk()` para `Map`/`Set` (iterar `.entries()`/`.values()` recursivamente) y tratar `Buffer`/`TypedArray` como opaco pero exigir declaración explícita vía `extractSensitiveValues` si una herramienta legítimamente necesita retornar binarios (documentar que binarios sin declarar están fuera del escaneo automático, en vez de fallar silenciosamente). | **Corregido** (commit `fix(agents): AG-17 ...` — ver "Nota de transparencia sobre los commits" arriba: el código de AG-19 quedó incluido en ese commit por el pathspec de directorio) — `walk()` ahora desciende en `Map` (entradas tratadas igual que propiedades de un objeto, mismo chequeo de sinónimos/`approvedSourceRef`), `Set` (valores recorridos recursivamente), y `Buffer`/`TypedArray` (decodificados como UTF-8 con límite defensivo de bytes, buscando JSON embebido o texto libre sospechoso); cualquier string (incluido el decodificado de un binario) también se analiza en busca de JSON serializado embebido (`JSON.parse` de substrings acotados por `{`/`[`...`}`/`]`) y, si parsea a un objeto/array, se recorre igual que el resto del `output`. `Date` se trata como hoja inerte. Test: `test/no-fabrication.test.ts` describe "AG-19 (MEDIA)" (Map/Set/Buffer/TypedArray/Date/JSON embebido/combinaciones anidadas, más un caso de control sin falsos positivos con binario aleatorio). |
| AG-20 | MEDIA | `findForbiddenFieldRecursive()` (AG-11) desciende en `ZodObject` (shape), `ZodArray` (elemento), y una capa de wrappers (`optional`/`nullable`/`default`/`effects`), pero **no** en `ZodUnion`/`ZodDiscriminatedUnion` (ramas), `ZodIntersection` (operandos), `ZodRecord`/`ZodMap` (tipo de valor), ni `ZodTuple` (items). Un esquema `z.union([z.object({foo: z.string()}), z.object({organizationId: z.string()})])` o `z.record(z.string(), z.object({organizationId: z.string()}))` se registra **sin lanzar** `UnauthorizedToolInputError`, exactamente el mismo tipo de garantía-más-débil-que-lo-documentado que originó AG-11, en combinadores de Zod distintos a los ya cubiertos. Sin explotación end-to-end demostrada (ningún handler de ejemplo lee este tipo de esquema). Evidencia: `packages/agents/src/tool-registry.ts:237-262`; 2 pruebas propias confirmaron el registro sin lanzar para `z.union` y `z.record`, y una prueba de control confirmó que el caso ya cubierto (objeto anidado directo) sí sigue lanzando. | Extender `findForbiddenFieldRecursive` para descender también en las opciones de `ZodUnion`/`ZodDiscriminatedUnion` (`_def.options`), los operandos de `ZodIntersection` (`_def.left`/`_def.right`), el tipo de valor de `ZodRecord`/`ZodMap` (`_def.valueType`), y los items de `ZodTuple` (`_def.items`). | **Corregido** (commit `fix(agents): AG-17 ...` — ver "Nota de transparencia sobre los commits" arriba: el código de AG-20 quedó incluido en ese commit por el pathspec de directorio) — `findForbiddenFieldRecursive` ahora también desciende en `ZodUnion`/`ZodDiscriminatedUnion` (cada rama de `_def.options`), `ZodIntersection` (`_def.left`/`_def.right`), `ZodRecord`/`ZodMap` (`_def.valueType`), `ZodTuple` (`_def.items` + `_def.rest` variádico) y `ZodLazy` (resuelto vía `_def.getter()`, con protección de ciclos para esquemas auto-referenciados). Test: `test/tool-registry.test.ts` describe "AG-20 (MEDIA)" (un caso rechazado por combinador + casos legítimos que no deben lanzar + `z.lazy()` recursivo legítimo sin recursión infinita + caso de control de AG-11 que sigue lanzando). |

**Cierre de PARCIAL AG-10/AG-11**: los veredictos "PARCIAL" de AG-10 y AG-11
en la tabla de arriba (sección "Tabla de hallazgos (AG-01 a AG-16)") quedaban
así específicamente por los bypasses documentados en AG-19 y AG-20
respectivamente. Con AG-19 y AG-20 corregidos (ver columna "Estado
reparación" de esta tabla) y sus tests en verde dentro de la misma suite de
`packages/agents`, ambos huecos estructurales quedan cerrados; el texto
original de los veredictos PARCIAL de AG-10/AG-11 no se modifica aquí (fuera
del ámbito de esta columna), pero su cierre queda documentado en esta nota y
en `docs/logs/fix-agents-ronda2.log`.

---

## Regresiones

### Confirmada: `apps/worker` roto por AG-05 (`declaredEffects` obligatorio)

`apps/worker/src/handlers/run-agent.ts` (commit `069f690`, `2026-09-05 19:36:13`,
**creado antes** del fix de AG-05 `480d183` de `2026-09-05 19:44:07` — ambos agentes
trabajando en este repo compartido sin worktrees coordinados) registra su única
herramienta de demostración (`llm_complete`) sin el campo `declaredEffects`, que AG-05
volvió obligatorio en `ToolDefinition`.

- `npm run -w apps/worker typecheck` → **falla**: `error TS2345: ... Property
  'declaredEffects' is missing in type '{...}' but required in type
  'ToolDefinition<...>'` (`src/handlers/run-agent.ts:62:21`).
- `npm run -w apps/worker build` → falla con el mismo error.
- `npm run -w apps/worker test` → **3 de 36 pruebas fallan** en runtime (no solo
  typecheck) con `InvalidDeclaredEffectsError: La herramienta "llm_complete" declara
  efectos inválidos: declaredEffects es obligatorio y no puede estar vacío`, en
  `test/run-agent-handler.test.ts` (los 3 casos que efectivamente invocan el handler).

Esta regresión **no fue detectada por la ronda de corrección** porque cada commit de
corrección solo ejecutó la suite de `packages/agents` de forma aislada — el mandato
del despacho (según su propia nota en AG-01) es "packages/agents/\*\* + logs +
tabla", que no incluye correr `typecheck`/`test` de los consumidores reales
(`apps/worker`, futuramente `apps/api`). El propio README de `packages/agents` señala
esto como un riesgo estructural del formato de despacho por paquete en un repo
compartido sin gate de integración cruzada.

**Reparación sugerida (fuera de mi mandato de solo verificación)**: agregar
`declaredEffects: ["read_only"]` a la definición de `llm_complete` en
`apps/worker/src/handlers/run-agent.ts:62`, y agregar un paso de CI (cuando exista,
ver AG-14) que corra `typecheck`/`test` de **todos** los workspaces que dependen de
`packages/agents`, no solo del paquete que cambió.

### `apps/api` — sin regresión

`npm run -w apps/api typecheck` pasa limpio. Confirmado que `apps/api` todavía no
importa `@atiende/agents` en ningún archivo (`grep -rl "@atiende/agents" apps/api/src
apps/api/test` → vacío), consistente con la sección "Cómo lo consumirá apps/api" del
README (trabajo futuro, no implementado todavía).

---

## Comprobado correcto (adicional a lo ya listado en `agents.md`)

- Los 14 commits de corrección citados (`df9f6dc`, `6d15186`, `114a2fb`, `01550ad`,
  `480d183`, `f8ef82f`, `f41d3ce`, `4731139`, `f6a89f1`, `5dff06e`, `b300521`,
  `1acf087`, `b5c8a38`, `6e0be34`) existen y su `git show --stat` toca exactamente los
  archivos de `packages/agents` (y solo esos, salvo `df9f6dc` que llegó bundleado con
  un commit de auditoría de `db-api` de otro agente concurrente, verificado que el
  contenido de `packages/agents` es coherente con lo descrito).
- Los 21 describe/test citados por nombre en la tabla de `agents.md` existen tal cual
  se citan (confirmado con `grep` por archivo) y pasan en el run de 182 pruebas.
- El gate de cobertura de AG-14 realmente falla si se exige más cobertura de la real
  (reproducido de forma independiente en esta ronda, no solo confiando en la nota del
  commit).
- AG-06: la comparación exacta de país (`!==`) falla cerrado ante variantes con
  espacio o minúsculas — no es una vía de evasión, es un caso ya cubierto
  correctamente por el diseño (aunque puede producir un falso rechazo operativo si un
  dato de país llega mal formateado, eso es un problema de calidad de datos de
  `apps/api`, no de seguridad).
- AG-08/AG-09: `-0` como monto/tokens pasa la validación pero es numéricamente
  equivalente a 0 — no corrompe el ledger ni el rate limiter (confirmado midiendo el
  estado antes/después). `1e309` (que en JS se evalúa como `Infinity`) y `BigInt`
  (pasado con un cast forzado que bypasea el tipo) son rechazados correctamente por
  ambos guards.
- El campo con typo `precio_unit` (variante del hallazgo AG-10) **sí es detectado**
  por `scanForUnsourcedSensitiveData` gracias al match por substring contra el
  sinónimo `precio`.

---

## Metodología

Las 30 pruebas adversariales propias y las mutaciones de umbral de cobertura se
ejecutaron en `git worktree add <scratchpad>/reverify-agents HEAD`, nunca en el árbol
principal. El worktree se eliminó al finalizar (`git worktree remove --force`); no se
modificó de forma persistente ningún archivo de `packages/agents/src`,
`packages/agents/test`, `apps/worker` ni `apps/api`. El único archivo de prueba
creado (`packages/agents/test/reverify-adversarial.test.ts`, 30 casos) se borró antes
de cerrar el worktree y nunca se commiteó. Este documento y
`docs/logs/reverify-agents-ronda1.log` son los únicos artefactos persistentes de esta
reverificación.
