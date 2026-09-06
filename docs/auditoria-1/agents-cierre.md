# Reverificación adversarial — packages/agents (vuelta 3, FINAL)

**Ámbito**: cierre de los 4 hallazgos residuales de la reverificación vuelta 2
(`docs/auditoria-1/agents-reverificacion-2.md`, AG-19/AG-20 en su forma
residual = AG-21/AG-22) tras el commit de corrección `9cb38be`
("fix(agents): AG-21/AG-22 cierre de PARCIAL en no-fabrication y
tool-registry"). Reverificación ejecutada por un tercer agente Sonnet
independiente, sin participación en la construcción ni en las tres rondas de
corrección/reverificación previas de `packages/agents`. Todo el trabajo se
hizo en `git worktree add <scratchpad>/reverify3-agents HEAD`, `npm install`
solo dentro del worktree, nunca en el árbol principal; el worktree se
eliminó al terminar. En el repo principal solo se escribieron/commitearon
este documento y `docs/logs/reverify3-agents.log`.

Comandos y salida completa: `docs/logs/reverify3-agents.log`.

---

## 1. Ancestría y contenido exacto del commit de corrección

```
$ git log --oneline -5
802cff6 docs: corrección agents vuelta 3; despacho reverificación final
80fb455 docs: cierre api ronda 2; despacho reverificación db-api y ronda 3 ...
9cb38be fix(agents): AG-21/AG-22 cierre de PARCIAL en no-fabrication y tool-registry
da36f65 fix(db): 0026b — ...
baa262f docs: reverificación worker; despacho corrección vuelta 2

$ git merge-base --is-ancestor 9cb38be HEAD && echo "9cb38be IS ancestor of HEAD"
9cb38be IS ancestor of HEAD
```

`git show --stat 9cb38be` toca **exactamente 8 archivos** (coincide con el
mandato):

```
docs/auditoria-1/agents-reverificacion-2.md |  47 +++++-
docs/logs/fix-agents-ronda3.log             | 149 +++++++++++++++++
packages/agents/README.md                   | 106 +++++++++++-
packages/agents/src/errors.ts               |  69 ++++++++
packages/agents/src/no-fabrication.ts       | 225 ++++++++++++++++++++++---
packages/agents/src/tool-registry.ts        | 245 +++++++++++++++++++++++++---
packages/agents/test/no-fabrication.test.ts | 101 ++++++++++++
packages/agents/test/tool-registry.test.ts  | 203 +++++++++++++++++++++++
8 files changed, 1091 insertions(+), 54 deletions(-)
```

**Veredicto: CUMPLE.** El commit existe, es ancestro de HEAD, y toca
exactamente los 4 archivos de código/test de `packages/agents` que dice
tocar, más README y los 3 artefactos de gobierno (2 del despacho anterior +
el propio log de la corrección).

---

## 2. Reproducibilidad de la suite oficial y consumidores

| Paso | Resultado |
|---|---|
| `npm install` en worktree nuevo | OK |
| `npm run -w packages/agents typecheck` | OK, sin errores |
| `npm run -w packages/agents lint` | OK, sin hallazgos |
| `npm run -w packages/agents test` | **13 archivos / 241 pruebas, todas en verde** (215 de la ronda anterior + 26 nuevas: 12 describe "AG-21" en `test/no-fabrication.test.ts`, 14 describe "AG-22" en `test/tool-registry.test.ts` — coincide exactamente con lo declarado por el commit) |
| `npm run -w packages/agents build` | OK |
| `npm run -w packages/agents test:coverage` | Statements 94.07% · Branches 90.79% · Funcs 94.18% · Lines 94.07% — el commit declara 90.82% de ramas; diferencia de 0.03pp no material (variación de entorno), ambos muy por encima del umbral de producción 85/80/85/85 |
| `npm run -w apps/api typecheck` | **OK, sin errores** |
| `npm run -w apps/worker typecheck` | **OK, sin errores** |
| `npm run -w apps/worker test` | 8 archivos pasan / 3 saltados (necesitan Postgres real); 55 pruebas pasan / 5 saltadas; **0 fallos** |

**Veredicto: CUMPLE.** La suite es reproducible byte-a-byte contra lo
declarado en el commit `9cb38be` y en `docs/logs/fix-agents-ronda3.log`
(241/241, cobertura equivalente). Ningún consumidor (`apps/api`,
`apps/worker`) está roto por esta ronda de corrección — a diferencia de la
regresión de `apps/worker` detectada y luego cerrada en rondas anteriores
(AG-05/`declaredEffects`).

---

## 3. Ataques adversariales finales (27 pruebas propias, ejecutadas solo en
   el worktree, borradas antes de cerrarlo, nunca commiteadas)

### AG-19/AG-21 (`scanForUnsourcedSensitiveData`) — 12 ataques

| Ataque | Resultado |
|---|---|
| Valor sensible en JSON a caballo justo antes del offset 8192 (8182) | **Detectado** |
| Valor sensible empezando justo después del offset 8192 (8202) | **Detectado** |
| Valor sensible empezando exactamente en el offset 8192 | **Detectado** — las ventanas solapadas (8192 bytes, solape 512) cubren correctamente los 3 puntos del borde |
| Buffer de exactamente 5 MiB (el límite, no lo excede) | Escaneado con normalidad, **NO** produce `no_evaluable` — confirma que el límite es `>` estricto, no `>=` |
| Buffer de 5 MiB + 1 byte | Produce **exactamente** `[{kind:"no_evaluable"}]`; el precio realmente presente en el buffer **no se reporta por separado** — no pasa silenciosamente como `completed` |
| base64 con padding inválido (longitud rota, no múltiplo de 4) | **No decodificado** (falla el chequeo de longitud), sin crash |
| base64 con padding extra (`===`) | No lanza, tratado con seguridad (rechazado por el patrón estricto) |
| base64 de JSON con espacios/indentación (`JSON.stringify(...,null,2)`) | **Detectado** — el `TextDecoder` UTF-8 maneja espacios/saltos de línea con normalidad, la heurística "parece JSON" no se ve afectada |
| base64 URL-safe (`-`/`_` en vez de `+`/`/`) | **No detectado** — confirma el límite ya documentado en el README: la heurística solo reconoce el alfabeto base64 **estándar** |
| Doble base64 (`base64(base64(json))`) | **No detectado en un solo paso** — **hallazgo no documentado explícitamente antes**: la capa externa decodifica a un string que es la representación base64 *interna*, que no "parece JSON" (no contiene `{`/`[`), así que `tryDecodeBase64Json` no vuelve a intentar decodificar esa capa. No hay recursión de la heurística de base64 sobre sí misma. |
| Array de arrays de Buffers (`Array > Array > Buffer`) | JSON sensible dentro **detectado** — la recursión de `walk()` atraviesa arrays anidados con normalidad |
| Array de arrays de Buffers, cada uno > 5 MiB | **2 hallazgos `no_evaluable` independientes**, uno por Buffer — el límite se aplica por contenedor binario individual, no de forma agregada |

**Veredicto AG-19: CERRADO.** Todos los puntos de frontera de las ventanas
solapadas (offset 8182/8192/8202) se cubren correctamente sin bypass.

**Veredicto AG-21: CERRADO para el mecanismo de ventanas/límite total**
(comportamiento exacto al documentado, incluida la semántica `no_evaluable`
que bloquea la corrida en vez de dejarla pasar). **Límites residuales
confirmados y ya aceptados como decisión de producto** (no defectos nuevos
que exijan corrección): base64 URL-safe no se decodifica (documentado en el
propio README), y se confirma además que la heurística de base64 **no es
recursiva** (doble base64 evade), variante del mismo límite conservador
("no decodificar automáticamente cualquier string que parezca base64, para
evitar falsos positivos") — se documenta explícitamente aquí por primera vez
para que quede registrado, sin abrir un hallazgo nuevo porque es la misma
categoría de trade-off ya reconocido y aceptado.

### AG-20/AG-22 (`findForbiddenFieldRecursive` / `findForbiddenKeyAtRuntime`) — 15 ataques

| Ataque | Resultado |
|---|---|
| Runtime `{orgId: 1}` dentro de `z.record(z.string(), z.any())` | **Rechazado** (`ForbiddenRuntimeInputFieldError`) — coincidencia literal exacta |
| Runtime `{ORG_ID: 1}` (mayúsculas) | **NO rechazado** — bypass confirmado |
| Runtime `{"org-id": 1}` (guion en vez de guion bajo) | **NO rechazado** — bypass confirmado |
| Matriz de 11 variantes (`organizationId`/`organization_id`/`tenantId`/`tenant_id`/`orgId`/`org_id` vs `OrgId`/`ORGID`/`Organization_Id`/`"org id"`/`orgid`) | Confirma el criterio exacto: **`FORBIDDEN_INPUT_FIELDS` es una lista fija de 6 strings comparados por igualdad estricta (`Array.includes`)**, sin NFKC, sin `toLowerCase()`, sin normalización de separadores — a diferencia del patrón ya establecido en el propio paquete por AG-02 (`AuthorizationPolicy` normaliza nombres de herramienta con NFKC+minúsculas+sin separadores precisamente para este tipo de evasión) |
| Profundidad de esquema 255 (< `MAX_SCHEMA_RECURSION_DEPTH`=256) | Registra sin error |
| Profundidad de esquema 257 (> 256) | `SchemaTooDeepError`, **no** `RangeError` |
| Profundidad de argumentos runtime 255 (< `MAX_RUNTIME_ARGS_DEPTH`=256) | Sin error |
| Profundidad de argumentos runtime 257 (> 256) | `RuntimeArgsTooDeepError`, **no** `RangeError` |
| `ZodPipeline` dentro de `ZodBranded` dentro de `ZodLazy` con `organizationId` | **Rechazado** en el registro |
| `ZodBranded` dentro de `ZodPipeline` dentro de `ZodLazy` (orden inverso) | **Rechazado** en el registro |
| Triple envoltura legítima equivalente sin `organizationId` | Registra sin error (sin falso positivo) |
| `z.custom()` con forma `{organizationId}` | **No detectado** en el registro (esperado: sin `_def.shape` que inspeccionar — límite arquitectónico ya reconocido para combinadores opacos, no un bug nuevo) |
| `z.custom()` con `organizationId` real en runtime | **Sí detectado** por `findForbiddenKeyAtRuntime` — el dato ya parseado sigue siendo un objeto plano recorrible sin importar qué esquema lo validó; mitigación incidental pero real |
| `z.instanceof()` con propiedad `organizationId` en la clase | **No detectado** en el registro (mismo motivo que `z.custom()`) |
| `z.instanceof()` con instancia real en runtime | **Sí detectado** por `findForbiddenKeyAtRuntime` (`Object.entries()` de una instancia de clase con propiedades propias enumerables se comporta igual que un objeto plano) |

**Veredicto AG-20: CERRADO.** Ningún combinador anidado (`ZodPipeline`
dentro de `ZodBranded` dentro de `ZodLazy`, en cualquier orden) logra evadir
`findForbiddenFieldRecursive`; la guarda de profundidad (256) funciona
exactamente como está documentada en ambos lados de la frontera (255 pasa,
257 lanza el error tipado, nunca `RangeError` crudo).

**Veredicto AG-22: PARCIAL — cierra los 3 bypasses/gaps que motivaron el
hallazgo original (`ZodPipeline`/`ZodBranded` sin desenvolver, `keyType`
de `ZodRecord`/`ZodMap` no revisado, sin guarda de profundidad), pero
introduce un hueco residual nuevo en la propia mitigación de runtime que
agregó**: ver hallazgo nuevo **AG-23** abajo. `z.custom()`/`z.instanceof()`
no son un bypass real de extremo a extremo porque `findForbiddenKeyAtRuntime`
los cubre incidentalmente en la práctica (mientras el dato validado siga
siendo un objeto/array/Map/Set plano, que es el caso normal).

---

## 4. Hallazgo nuevo (AG-23)

| ID | Severidad | Hallazgo (evidencia) | Estado |
|---|---|---|---|
| AG-23 | MEDIA | `FORBIDDEN_INPUT_FIELDS` (`packages/agents/src/tool-registry.ts:34-41`) es una lista fija de 6 strings (`organizationId`, `organization_id`, `tenantId`, `tenant_id`, `orgId`, `org_id`) comparados por **igualdad estricta** (`Array.includes`) tanto en `findForbiddenFieldRecursive` (chequeo estático de nombres de campo del esquema) como en `findForbiddenKeyAtRuntime` (AG-22, la mitigación de runtime construida específicamente para cerrar el hueco arquitectónico de `z.record(z.string(), ...)`/`z.map(z.string(), ...)` de clave genérica). Un `tool_call` que use una clave con variación de mayúsculas (`ORG_ID`, `OrgId`, `ORGID`) o de separador (`org-id`, `"org id"`) — o simplemente `orgid` sin separador — dentro de un record de clave genérica **evade completamente** la verificación de runtime que AG-22 introdujo precisamente para ese escenario. Es el mismo patrón de bug que motivó AG-02 (nombres de herramienta sin normalizar) y que `AuthorizationPolicy` ya resuelve con NFKC+minúsculas+sin separadores para el problema análogo de nombres de tool — el patrón no se generalizó a `FORBIDDEN_INPUT_FIELDS`. Confirmado con 4 pruebas propias (11 variantes en una matriz), sin falsos positivos en los 6 nombres canónicos. | **Abierto — no corregido.** Fuera de mi mandato de esta ronda (soy verificador adversarial, no corrector); reparación sugerida (no aplicada): normalizar la clave (NFKC + `toLowerCase()` + `replace(/[^a-z0-9]/g, "")`) antes de comparar contra una versión igualmente normalizada de `FORBIDDEN_INPUT_FIELDS`, en ambos puntos de chequeo (`findForbiddenFieldRecursive` y `findForbiddenKeyAtRuntime`), replicando el patrón ya usado en `authorization.ts` para nombres de herramienta (AG-02). |

**Nota de alcance**: la explotabilidad real depende de que exista una
`ToolDefinition` que use `z.record(z.string(), ...)`/`z.map(z.string(), ...)`
de clave genérica en el nivel superior de datos que el handler trate como de
confianza — exactamente el patrón que el propio README ya señala como
"superficie a evitar cuando sea posible" (límite arquitectónico de AG-22).
AG-23 no abre una vía nueva de explotación por sí solo, pero **reduce
significativamente la cobertura real de la mitigación de runtime que AG-22
declaró como cierre** de ese límite: la mitigación solo cubre las 6
grafías exactas, no el espacio de variantes triviales que un modelo podría
producir sin intención adversarial siquiera (p. ej. por convención de
mayúsculas distinta).

---

## 5. Balance final del paquete `packages/agents` (los 22 hallazgos AG-01 a AG-22, más AG-23 nuevo)

| ID | Severidad | Estado definitivo | Nota |
|---|---|---|---|
| AG-01 | ALTA | **CERRADO** | `actionKind` obligatorio, reverificado en ronda 1 |
| AG-02 | ALTA | **CERRADO** | Normalización NFKC + ASCII snake_case obligatorio |
| AG-03 | CRÍTICA | **CERRADO** | Unión-nunca-reemplazo en `hardProhibitedActions` |
| AG-04 | MEDIA | **CERRADO** | `Proxy` inmutable en constantes de módulo |
| AG-05 | MEDIA | **PARCIAL — límite arquitectónico reconocido, no cerrable en este paquete** | Handler que miente en 3 metadatos a la vez; mitigación delegada a revisión humana/sandbox en `apps/api` |
| AG-06 | CRÍTICA | **CERRADO** | País/componentes de tolerancia cero no configurables |
| AG-07 | MEDIA | **CERRADO** | `GuardrailEvent` guarda hash + extracto, no texto crudo |
| AG-08 | ALTA | **CERRADO** | `BudgetLedger` rechaza montos negativos/NaN/infinitos |
| AG-09 | MEDIA | **CERRADO** | `TokenBucketRateLimiter` idem |
| AG-10 | ALTA | **CERRADO** (bypass original cerrado; huecos residuales rastreados como AG-19→AG-21) | Escaneo automático obligatorio, no opt-in |
| AG-11 | MEDIA | **CERRADO** (bypass original cerrado; huecos residuales rastreados como AG-20→AG-22) | Recursión en esquemas anidados |
| AG-12 | BAJA | **CERRADO — alcance acotado por diseño** | Medición honesta del ~3% de detección; clasificador semántico (REQ-127) sigue pendiente en `apps/api`, fuera de este paquete |
| AG-13 | BAJA | **CERRADO** | Test de concurrencia real agregado |
| AG-14 | BAJA | **CERRADO** | Gate de cobertura verificado que realmente falla |
| AG-15 | BAJA | **CERRADO (atendido por despacho transversal)** | Commit `d8e6d29` agregó columna "Paquete(s) responsable(s)" a `docs/ACEPTACION.md` para los 171 REQ |
| AG-16 | INFORMATIVO | **NO APLICA** | Verificación positiva del incidente reportado, sin defecto |
| AG-17 | ALTA | **CERRADO** | `roleCeiling` solo puede bajar el techo, invariante reforzada con `Object.freeze` |
| AG-18 | MEDIA | **CERRADO** | Sets por-instancia inmutables + `Object.freeze(this)` |
| AG-19 | MEDIA | **CERRADO** (esta ronda: ventanas/offsets de borde confirmados sin bypass) | |
| AG-20 | MEDIA | **CERRADO** (esta ronda: combinadores anidados en cualquier orden + guarda de profundidad confirmados) | |
| AG-21 | MEDIA | **CERRADO** (mecanismo de ventanas/límite total); límites de base64 URL-safe/doble base64 documentados como aceptados, no defectos nuevos | |
| AG-22 | MEDIA | **PARCIAL** — cierra los 3 gaps originales; introduce hueco residual nuevo → **AG-23** | |
| **AG-23** (nuevo) | **MEDIA** | **Abierto — no corregido** (fuera de mandato de esta ronda, solo verificación) | Case-sensitividad/separadores en `FORBIDDEN_INPUT_FIELDS`, estático y runtime |

**Conteo definitivo**: 19 CERRADO (14 sin matices + AG-15/AG-16 resueltos +
AG-19/AG-20/AG-21 de esta ronda) · 2 PARCIAL con causa reconocida (AG-05
límite arquitectónico; AG-22 con hueco residual nuevo) · 0 NO CERRADO entre
los 22 originales · **1 hallazgo nuevo abierto** (AG-23, MEDIA).

---

## 6. Límites aceptados (no defectos pendientes de corrección) y su causa

| Límite | Causa | Dónde está documentado |
|---|---|---|
| **AG-05**: handler que miente simultáneamente en `riskLevel`/`actionKind`/`declaredEffects` no es detectable | Arquitectónico: cualquier gate basado en metadatos que el propio autor de la herramienta declara no puede detectar una mentira consistente en todos los campos a la vez. Mitigación fuera de este paquete (revisión humana / sandbox de red en `apps/api`). | `packages/agents/README.md`, sección "Límite conocido (AG-05)" |
| **AG-12**: guardrail regex detecta ~3% de intentos con vocabulario disfrazado | El guardrail es una capa determinista de patrones conocidos, no un clasificador semántico; el 0% de falsos positivos en lenguaje legítimo de licitaciones es una propiedad real y valiosa, pero la cobertura contra ofuscación real requiere un hook LLM/juez (REQ-127) que vive en `apps/api`, no en este paquete puro. | `packages/agents/README.md`, sección "Límite conocido (AG-12)" |
| **Compresión/cifrado no detectables por `scanForUnsourcedSensitiveData`** | El escaneo es una capa de heurísticas sobre representaciones texto/JSON/base64; no decodifica gzip/deflate/brotli ni contenido cifrado. Decisión consciente de costo/beneficio: la propia herramienta debe declarar `extractSensitiveValues` si produce ese tipo de payload. | `packages/agents/README.md`, sección "Límite conocido residual (AG-19/AG-21)" |
| **`z.record(z.string(), ...)`/`z.map(z.string(), ...)` de clave genérica** | Irreducible en el registro estático: un record de clave libre no "declara" ningún campo en particular, cualquier string es válido por diseño de Zod. Mitigado (no eliminado) con verificación de runtime (`findForbiddenKeyAtRuntime`, AG-22) — que a su vez tiene el hueco de normalización descrito en AG-23. | `packages/agents/README.md`, sección "ToolRegistry", párrafo "Límite arquitectónico irreducible" |
| **base64 URL-safe / doble base64 no decodificados** | Heurística deliberadamente conservadora para minimizar falsos positivos (muchos strings legítimos — IDs, hashes, tokens — "parecen" base64 por forma); decodificar automáticamente cualquier variante de alfabeto o recursar indefinidamente aumentaría el riesgo de falsos positivos sin garantía de cerrar el espacio completo de ofuscación posible. | `packages/agents/README.md`, sección "Límite conocido residual (AG-19/AG-21)"; el caso específico de doble base64 se documenta explícitamente por primera vez en `docs/logs/reverify3-agents.log` de esta ronda |

---

## 7. REQ candidatos a CUMPLIDO vs los que deben quedar EN_EVIDENCIA en `docs/ACEPTACION.md`

**No se editó `docs/ACEPTACION.md`** (fuera de mi mandato); esta sección es
una lista para que el orquestador la aplique.

### Candidatos a pasar de EN_EVIDENCIA a CUMPLIDO

- **REQ-062** (`Ningún rol "administrador" puede saltar la doble
  confirmación`): la fila actual de `ACEPTACION.md` dice "EN_EVIDENCIA
  (corregido; sin reverificación adversarial independiente de la
  corrección)". Esa independencia **ya existe**: `agents-reverificacion-2.md`
  (segundo agente, sección 3 "AG-17 — 8 ataques, 0 bypasses", veredicto
  CERRADO) reverificó AG-17 de forma independiente, y esta ronda (tercer
  agente) confirma que `9cb38be` no tocó `authorization.ts` y que la suite
  con los tests de AG-17 (`test/authorization.test.ts`, 29 tests) sigue en
  verde. **Candidato a CUMPLIDO.**
- **REQ-125** (tolerancia cero de proveedores): ya está `CUMPLIDO` en
  `ACEPTACION.md` — sin cambios, se reconfirma con esta ronda (router.ts no
  tocado por `9cb38be`, 17 tests de `test/llm/router.test.ts` en verde).

### Deben permanecer en EN_EVIDENCIA (no promover a CUMPLIDO todavía)

- **REQ-164** (prohibido inventar datos/precios/certificaciones sin fuente):
  la fila cita el gap de `evidenceDocId` en `resolveExperience`
  (`packages/expediente`, REQ-143) como no cubierto — eso es ajeno a esta
  ronda de `packages/agents` y sigue sin evidencia de cierre. Además, dentro
  de `packages/agents` mismo, AG-23 (nuevo, esta ronda) es un hueco real en
  la detección de `organizationId`/datos de tenant colado en argumentos —
  aunque REQ-164 es sobre valores fabricados (no sobre aislamiento de
  tenant), el patrón de "coincidencia exacta sin normalizar" que motiva
  AG-23 es la misma familia de riesgo que ya mantiene la fila en
  EN_EVIDENCIA. **Mantener EN_EVIDENCIA.**
- **REQ-165** (prohibido enviar/firmar/actuar sin autorización explícita):
  la fila actual dice "CUMPLIDO (packages/expediente) / EN_EVIDENCIA
  (packages/agents, corregido sin reverificar; límite de diseño AG-05
  persiste)". La parte "sin reverificar" de `packages/agents` **ya se
  cerró** (ronda 2 y esta ronda 3 confirman AG-17/18/19/20/21/22
  independientemente), pero **AG-05 sigue siendo un límite de diseño
  irresoluble reconocido** (no un defecto pendiente de "reverificar", sino
  una limitación arquitectónica aceptada) — la calificación correcta pasa de
  "EN_EVIDENCIA por falta de reverificación" a **"EN_EVIDENCIA por límite de
  diseño AG-05 documentado y aceptado, no por trabajo pendiente"**: sigue sin
  ser candidato a CUMPLIDO estricto porque REQ-165 se lee como invariante
  ("no existe ruta de ejecución que... sin un approval_request explícito
  previo") y AG-05 es, por construcción, una ruta residual no cubierta por
  metadatos declarados. **Mantener EN_EVIDENCIA**, con la nota actualizada.
- **REQ-166/168/169/170/171**: sin cambios respecto a lo ya registrado en
  `ACEPTACION.md` (dependen de `packages/sources`/`apps/api`/`apps/web`, no
  de esta ronda de `packages/agents`). Sin evidencia nueva de esta
  reverificación que las mueva.

---

## 8. Metodología

Todo el trabajo (`npm install`, `typecheck`/`lint`/`test`/`build`/
`test:coverage` de `packages/agents`, `typecheck`/`test` de `apps/api` y
`apps/worker`, y las 27 pruebas adversariales propias) se ejecutó en
`git worktree add <scratchpad>/reverify3-agents HEAD`, nunca en el árbol
principal. El worktree se eliminó al finalizar
(`git worktree remove --force`); no se modificó de forma persistente ningún
archivo de `packages/agents/src`, `packages/agents/test`, `apps/worker` ni
`apps/api`. El único archivo de prueba creado
(`packages/agents/test/reverify3-adversarial.test.ts`, 27 casos) se borró
antes de cerrar el worktree y nunca se commiteó. Este documento y
`docs/logs/reverify3-agents.log` son los únicos artefactos persistentes de
esta reverificación. No se editó `docs/ACEPTACION.md` (sección 7 es una
lista para el orquestador, no una edición aplicada).
