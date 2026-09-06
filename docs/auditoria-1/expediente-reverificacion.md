# Reverificación adversarial — `packages/expediente` (ronda 1 de corrección)

**Auditor**: agente Sonnet reverificador independiente, sin participación en la
construcción del paquete ni en la ronda de corrección original. Ejecución real de
`npm install`, `typecheck`/`lint`/`test`/`build`, `vitest run --coverage`, y 6 scripts
`.mjs` adversariales propios contra el `dist/` compilado — todo en un `git worktree`
separado, nunca en el árbol principal. El worktree se eliminó al terminar.

**Ámbito**: `packages/expediente/**` en el commit corregido `49141fb` (worktree pinneado
en `f9b25ba`, que lo incluye íntegro; commits posteriores concurrentes en el repo — `f9b25ba`
de `packages/sources`, `6d4e5a1` de docs — no tocan `packages/expediente`).

**Comandos y salida completa**: `docs/logs/reverify-expediente-ronda1.log`.

**Hallazgo original reverificado**: `docs/auditoria-1/expediente.md` (10 hallazgos
EX-EXP-01..10, todos marcados "Corregido"/"Corregido (documentación)").

---

## Resumen ejecutivo

La ronda de corrección es **real y mayormente sólida**: los cuatro hallazgos CRÍTICOS
(EX-EXP-01/02/03/04) tienen código nuevo, tests nuevos que reproducen el ataque exacto del
auditor original, y la suite completa pasa (14 archivos / 118 pruebas, idéntico al log de
la corrección). Sin embargo, la reverificación adversarial encontró que **3 de los 4
hallazgos CRÍTICOS quedan solo parcialmente cerrados** porque las reparaciones defienden
el vector exacto reproducido por el auditor original pero no generalizan la regla, y
**se descubrieron 6 hallazgos nuevos** (EX-EXP-11 a EX-EXP-16), dos de severidad ALTA:

- **EX-EXP-01 (invalidación automática)**: la comparación estricta de `inputsHash` en
  `PackageAssembler`/`ApprovalWorkflow.revalidateAgainstCurrentHash` es correcta y bien
  probada para el vector exacto (tarifa), pero **no hay ningún mecanismo dentro del
  paquete que garantice qué insumos entran al hash** — `ProposalVersionRegistry.createVersion`
  acepta cualquier `Record<string, unknown>` que el llamador decida pasarle. Se reprodujo
  que cambiar un documento de empresa o la versión de bases **después** de la aprobación,
  sin que el llamador los incluya en el hash (el único test oficial solo hashea
  `economicTotals`), deja `isFullyApprovedForCurrentHash` y `manifest.status` completamente
  ciegos al cambio → `"ready"` persiste. Además `ProposalVersionRegistry.inputChanged()`
  sigue siendo código muerto (0 referencias, 33% cobertura de funciones).
- **EX-EXP-03 (requisito obligatorio sin evidencia)**: el fix protege exactamente
  `obligatoriedad === "obligatorio"`, pero dejó **sin protección idéntica el valor
  `"condicional"`** del mismo enum `Obligatoriedad` — un requisito condicional que en la
  práctica aplica (p. ej. "si subcontrata, debe declarar...") y sin evidencia mapeable
  **desaparece en silencio otra vez**, exactamente el defecto original, solo que bajo una
  etiqueta distinta.
- **EX-EXP-05 (apócope UN/VEINTIÚN)**: el fix solo cubre los casos exactos probados (1,
  21, 31, 101, 1000001, 21000000). `apocopeUno` no reconoce "veintiuno" cuando aparece
  **fusionado al final de una cadena más larga** ("ciento veintiuno", "doscientos
  veintiuno", "mil ciento veintiuno" y su propagación a "mil"/"millones": "ciento veintiuno
  mil", "ciento veintiuno millones"). Cualquier monto en las decenas de centena/millar/millón
  terminado en 21 (121, 221, 1121, 2121, 21121, 121000, 121000000, …) sigue imprimiendo
  **"VEINTIUNO" en vez de "VEINTIÚN"** — el mismo bug original, sin cerrar para esta familia
  de valores.
- **EX-EXP-04 (fechas sin offset)**: la corrección central (rechazar fechas naive) es
  sólida y bien probada. Pero se encontró un **hallazgo nuevo más grave en el mismo código**:
  `assertExplicitOffset` valida solo el *formato* del offset (`±HH:MM`), no su rango
  numérico ni la validez calendárica de la fecha. Un offset imposible como `"+99:00"` pasa
  la validación, produce `Date` inválida (`NaN`), y `isPast()` la evalúa como **`false`
  (nunca vencida)** en vez de lanzar — un *fail-open* silencioso sobre la garantía central
  de vigencias que el propio EX-EXP-04 pretendía cerrar.
- **EX-EXP-06 (fechas DD/MM/AAAA)**: el reconocimiento de los formatos numérico y "del
  AAAA" es correcto. Hallazgo nuevo: el patrón numérico asume siempre DD/MM sin marcar
  ambigüedad ni bajar `confidence` cuando día y mes son ambos ≤12 (p. ej. "05/09/2026"
  podría ser 5-sep o 9-may) — contradice la filosofía explícita del extractor de "nunca
  elegir en silencio ante ambigüedad".
- **EX-EXP-02, 07, 08, 09, 10**: reverificados sólidamente **CERRADOS** para sus vectores
  originales y variantes nuevas, con una excepción menor en EX-EXP-02 (ver hallazgo nuevo
  EX-EXP-14, scope/scopeRef inconsistente).

**Conteo de veredictos**: CERRADO: 5 (EX-EXP-02\*, 07, 08, 09, 10) · PARCIAL: 4
(EX-EXP-01, 04, 05, 06) · NO CERRADO: 1 (EX-EXP-03). \*EX-EXP-02 cerrado para su vector
original; ver hallazgo nuevo asociado (EX-EXP-14, severidad MEDIA).

**Hallazgos nuevos**: 6 — EX-EXP-11 (ALTA), EX-EXP-12 (CRÍTICA/ALTA), EX-EXP-13 (ALTA),
EX-EXP-14 (MEDIA), EX-EXP-15 (MEDIA), EX-EXP-16 (BAJA).

**Regresión en consumidores**: no evaluable — ningún paquete de `apps/` o `packages/`
importa `@atiende/expediente` todavía (`grep` sin coincidencias). No aplica
`npm run -w apps/api typecheck`.

**A6–A15 (docs/ACEPTACION.md)**: siguen honestamente marcadas **PENDIENTE**; no se
degradó ni se infló su estado. `test/expediente-flow.test.ts` ejercita un flujo
integrado *dentro de la librería pura* (bases → matriz → propuesta → checklist →
aprobación → ZIP), útil como necessary-but-insufficient, pero **no** es el flujo
integrado con API/UI/portal autenticado que `docs/ACEPTACION.md` exige explícitamente
para marcar A6–A15 como cumplidas — ver hallazgo EX-EXP-16 sobre el docstring de ese test.

---

## 1. Reproducibilidad

| Paso | Resultado | Evidencia |
|---|---|---|
| `npm install` (worktree nuevo) | OK, 677 paquetes | log |
| `npm run -w packages/expediente typecheck` | OK, exit 0 | log |
| `npm run -w packages/expediente lint` | OK, exit 0 | log |
| `npm run -w packages/expediente test` | **14 archivos / 118 pruebas, todas en verde** — idéntico a lo declarado en `docs/logs/fix-expediente-ronda1.log` | log |
| `npm run -w packages/expediente build` | OK, exit 0 | log |
| `npx vitest run --coverage` | Statements 91.03% · Branches 88.4% · Funcs 89.1% · Lines 91.03% — idéntico (redondeo) a lo declarado | log |

**Veredicto: CUMPLE.** Reproducibilidad perfecta.

`proposal-version.ts` sigue en **68.75% stmts / 33.33% funcs** — exactamente como
señalaba el hallazgo EX-EXP-01 original: `getVersion()`, `latest()`, `all()` e
`inputChanged()` (líneas 42-59) permanecen sin ejercitar por ningún test. Ninguna
prueba en toda la suite llama a `versions.latest()`, `versions.getVersion()` ni a
`ProposalVersionRegistry.inputChanged()` — todos los tests usan directamente
`.hash` del objeto que devuelve `createVersion()`.

---

## 2. Tabla de reverificación por hallazgo

### EX-EXP-01 — Invalidación automática por hash divergente (CRÍTICA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (tarifa $850→$2,550 tras aprobación, sin `recordChange`) | **Falla el ataque (correcto).** `isFullyApprovedForCurrentHash` invalida automáticamente; `PackageAssembler.buildManifest` exige `inputsHash === currentInputsHash` como defensa independiente. | `test/proposal-invalidation.test.ts`, control en `attack-ex01.mjs` |
| **Variante nueva: documento de empresa (no tarifa) cambia tras aprobación** | **Éxito parcial del ataque.** Si el `currentInputsHash` que calcula el llamador solo cubre `economicTotals` (como hace el único test oficial), sustituir el acta constitutiva por otra versión **no cambia el hash** → `isFullyApprovedForCurrentHash` sigue devolviendo `true` y `manifest.status` sigue `"ready"`. | `attack-ex01.mjs` variante `.a`; log sección "EX-EXP-01.a" |
| **Variante nueva: nueva versión de bases (convocatoria v2) tras aprobación** | **Éxito parcial del ataque**, mismo mecanismo: si "bases" no entra al hash, el cambio de convocatoria no se detecta. | `attack-ex01.mjs` variante `.b` |
| **Variante nueva: colisión de serialización por orden de claves** | **Falla el ataque (correcto).** `stableStringify`/`sortKeysDeep` ordena recursivamente todas las claves antes de `JSON.stringify`; dos objetos con las mismas claves en distinto orden producen el mismo hash **por diseño correcto**, no por accidente. | `attack-ex01.mjs` variante `.c` (segunda parte) |
| **Variante nueva: colisión de serialización por claves `undefined`** | **Éxito del ataque (hallazgo nuevo).** `JSON.stringify` descarta silenciosamente claves con valor `undefined`; `{total: "X", descuento: undefined}` y `{total: "X"}` producen el **mismo hash** aunque sean lógicamente distintos si la presencia/ausencia del campo es información relevante. | `attack-ex01.mjs` variante `.c` (primera parte) → EX-EXP-11 |

**Veredicto: PARCIAL.** El comparador de hash es correcto y a prueba de lo que le pasen,
pero el paquete **no define ni exige** cuáles insumos deben entrar al hash de alcance
"expediente" — esa responsabilidad es 100% de `apps/api`, sin ningún contrato de tipos
o runtime que la fuerce. Esto reproduce, en una forma más sutil, exactamente el problema
estructural que el resumen ejecutivo de la auditoría original ya advertía ("el ensamblaje
entre módulos... no existe todavía dentro del paquete"). Ver EX-EXP-11 y EX-EXP-12.

### EX-EXP-02 — Ready exige aprobación vigente de alcance "expediente" (CRÍTICA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (aprobación de alcance "documento" + `isFullyApproved` forzado) | **Falla el ataque (correcto).** `AssembleInput.isFullyApproved` ya no existe; `approvedOk` se deriva solo de `approvals`. | `test/package-assembler.test.ts` describe "EX-EXP-02" |
| **Variante nueva: dos aprobaciones parciales de scope "documento" que "suman"** | **Falla el ataque (correcto).** El filtro exige `a.scope === "expediente"` exacto; ninguna combinación de aprobaciones "documento"/"sección" cuenta, sin importar cuántas haya. | `attack-ex02.mjs` variante `.a` |
| **Variante nueva: hash-actual que extiende como prefijo al hash aprobado** | **Falla el ataque (correcto).** Comparación `===` estricta, no `startsWith`/substring. | `attack-ex02.mjs` variante `.b` |
| **Variante nueva: `scope: "expediente"` con `scopeRef` distinto de la cadena `"expediente"`** | **Éxito del ataque (hallazgo nuevo).** Ni `approve()` ni `buildManifest` validan que `scope === "expediente" ⟹ scopeRef === "expediente"`; una aprobación mal construida con `scopeRef: "expediente-OTRO-EXPEDIENTE"` pero `scope: "expediente"` cuenta igual como aprobación total. | `attack-ex02.mjs` variante `.c` → EX-EXP-14 |

**Veredicto: CERRADO** para el vector original y las dos primeras variantes (defensa
correcta y robusta). Hallazgo nuevo de severidad MEDIA (EX-EXP-14) por la tercera
variante.

### EX-EXP-03 — Requisito obligatorio sin evidencia queda PENDIENTE (CRÍTICA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (requisito `obligatoriedad: "obligatorio"` sin evidencia) | **Falla el ataque (correcto).** Genera sección `"PENDIENTE: ..."` con `SectionBlocker`. | `test/technical-proposal.test.ts`, control en `attack-ex03.mjs` |
| **Variante nueva: requisito `obligatoriedad: "condicional"` que aplica, sin evidencia mapeable** | **Éxito del ataque.** `technical-proposal.ts:72` solo distingue `obligatoriedad !== "obligatorio"` → un condicional (que en el caso concreto SÍ aplica al licitante) se trata igual que un opcional puramente procedimental: **0 secciones, 0 bloqueos**, desaparece sin rastro. | `attack-ex03.mjs` variante `.a`: `sections.length: 0` |
| **Variante nueva: requisito duplicado en dos documentos (misma obligación, distinta fuente)** | **Sin bloqueo pero cosmético, no fabricación (no se cuenta como hallazgo nuevo numerado).** Se generan 2 secciones idénticas (una por cada `RequirementItem`); no hay deduplicación por contenido/topicKey en `TechnicalProposalBuilder`. No inventa nada ni produce una falsa señal de completitud (si el mapeo falla, ambas fallan igual), pero es ruido/duplicación en el documento final — ver nota en "Comprobado correcto". | `attack-ex03.mjs` variante `.b` |

**Veredicto: NO CERRADO.** El defecto central del hallazgo original — un requisito que en
la práctica es de cumplimiento obligatorio desaparece de la propuesta técnica sin sección
ni bloqueo — **sigue reproduciéndose sin cambios** para `obligatoriedad: "condicional"`.
La propia reparación sugerida por la auditoría original decía explícitamente "reservar el
skip silencioso solo para tipos verdaderamente procedimentales", pero el código
implementado agrupa "condicional" con "opcional" sin distinción. Ver EX-EXP-12.

### EX-EXP-04 — Rechazar fechas sin offset explícito (CRÍTICA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (`"2026-10-20T23:59:59"` naive, veredicto distinto por TZ) | **Falla el ataque (correcto).** `assertExplicitOffset` rechaza cualquier fecha sin `Z`/`±HH:MM` de forma determinista en las 3 zonas probadas. | `test/timezone-determinism.test.ts`, control en `attack-ex04.mjs` |
| **Variante nueva: vigencia solo-fecha `"2026-09-05"` (sin hora, sin offset)** | **Falla el ataque (correcto).** Rechazada igual que cualquier naive. | `attack-ex04.mjs` |
| **Variante nueva: plazo con hora sin offset `"2026-09-05T23:59"`** | **Falla el ataque (correcto).** Rechazada igual. | `attack-ex04.mjs` |
| **Variante nueva: 29 de febrero de 2026 (año NO bisiesto) con offset válido** | **Éxito del ataque (hallazgo nuevo, menor).** `assertExplicitOffset` solo valida el sufijo de offset, no la validez calendárica; `"2026-02-29T00:00:00-06:00"` pasa la validación y `new Date(...)` la reinterpreta silenciosamente como 1 de marzo, sin error. | `attack-ex04.mjs` |
| **Variante nueva: offset numéricamente imposible `"+99:00"`** | **Éxito del ataque (hallazgo nuevo, grave).** El regex `[+-]\d{2}:\d{2}$` solo exige 2 dígitos, no un rango 00-23/00-59; el offset pasa la validación, `new Date(...)` produce `Invalid Date` (`NaN`), y `isPast()` — que solo hace `getTime() < getTime()` — evalúa `NaN < NaN` como `false`: la fecha corrupta se trata como **"nunca vencida"** en vez de lanzar. | `attack-ex04b.mjs` → EX-EXP-13 |

**Veredicto: PARCIAL.** El vector original (naive/TZ-dependiente) está sólidamente
cerrado. El hallazgo nuevo de offset inválido (EX-EXP-13) es más grave que el original en
un aspecto: falla *abierto* (nunca vencido) en vez de fallar *cerrado* (excepción), sobre
exactamente la misma garantía de vigencias que EX-EXP-04 pretendía asegurar.

### EX-EXP-05 — Apócope de UN/VEINTIÚN peso (ALTA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original y casos del mandato (1, 21, 31, 101, 1,000,001, 21,000,000, 21.21, 99.99 centavos) | **Falla el ataque (correcto)** para todos los casos exactos pedidos. | `attack-ex05.mjs` primera sección; `test/number-to-words.test.ts` describe "EX-EXP-05" |
| **Variante nueva: "veintiuno" fusionado al final de una cadena más larga** (121, 221, 1121, 2121, 21121 pesos) | **Éxito del ataque.** `centsToPesosWords(12100n)` → `"SON: CIENTO VEINTIUNO PESOS..."` (debería ser "CIENTO VEINTIÚN"). Se repite para 221, 1121, 2121, 21121 — `apocopeUno` solo reconoce los casos exactos `"uno"`, `"veintiuno"` y el sufijo `" uno"` (con espacio), pero no el sufijo fusionado `"...veintiuno"` sin espacio previo al `"uno"`. | `attack-ex05.mjs` segunda sección |
| **Variante nueva: propagación del mismo bug a "mil"/"millones"** (121,000 y 121,000,000 pesos) | **Éxito del ataque.** `integerToWords(121000)` → `"ciento veintiuno mil"` (debería ser `"ciento veintiún mil"`); mismo patrón en millones. El bug no es solo del paso final de `centsToPesosWords`, sino de `apocopeUno` en sí, reutilizada también dentro de `integerToWords` para las centenas de millar/millón. | `attack-ex05b.mjs` |

**Veredicto: NO CERRADO** para esta familia de valores — es el mismo defecto original
(apócope de "uno"/"veintiuno" faltante), simplemente no generalizado más allá de los
casos exactos cubiertos por los 6 tests nuevos. Cualquier monto real de licitación con
centenas/millares/millones terminados en 21 (p. ej. $121,450.00, $2,121,000.00) sigue
imprimiéndose mal en la carta de proposición económica. Ver EX-EXP-12 (agrupado con
EX-EXP-03 por ser del mismo patrón: "el fix cubre los ejemplos citados, no la regla
general").

### EX-EXP-06 — Extractor de fechas DD/MM/AAAA y "del AAAA" (ALTA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (`"15/10/2026"`, `"25-09-2026"`, `"25 de septiembre del 2026"`) | **Falla el ataque (correcto).** Los 3 formatos se reconocen y asignan `topicKey`. | `test/requirement-matrix.test.ts` describe "EX-EXP-06" |
| **Variante nueva: `"05/09/2026"` vs `"09/05/2026"` (ambigüedad DD/MM vs MM/DD)** | **Comportamiento cuestionable, no un "ataque" que rompa una garantía explícita, pero sí una omisión.** El extractor SIEMPRE asume DD/MM (razonable como convención mexicana por defecto) sin marcar la fecha como ambigua ni bajar `confidence` cuando día y mes son ambos ≤12 — a diferencia de la filosofía declarada ("ante ambigüedad, clasifica como condicional/sin fecha antes que inventar un valor"), aquí sí "inventa" una interpretación de una fecha genuinamente ambigua. `confidence: 0.7` idéntico para `"05/09/2026"` (ambigua) y `"25/09/2026"` (inequívoca). | `attack-ex06.mjs` → EX-EXP-15 |
| **Variante nueva: `"5 de septiembre del 2026"` (día de un dígito + "del")** | **Falla el ataque (correcto).** Se reconoce igual que "25 de septiembre del 2026". | `attack-ex06.mjs` |

**Veredicto: PARCIAL.** El vector original está cerrado. La ambigüedad DD/MM vs MM/DD es
un hallazgo nuevo real pero de severidad MEDIA (no rompe ninguna garantía explícita del
README, y DD/MM es la convención correcta por defecto en licitaciones mexicanas) — ver
EX-EXP-15.

### EX-EXP-07 — Validación runtime de ivaRate/moneda (MEDIA)

Ataque original (IVA 250%, moneda distinta de MXN vía JSON no tipado) **falla
correctamente**: `assertValidIvaRate` rechaza `[0, 0.3]` fuera de rango;
`resolveApprovedRate` lanza si `rate.currency !== "MXN"` (comparación case-sensitive,
`"mxn"` en minúsculas también se rechaza — falla cerrado, correcto). `maxIvaRate` es
ajustable por el llamador por diseño explícito y documentado; no es una debilidad nueva,
es el mismo patrón de "confía en que `apps/api` lo justifique" ya aceptado en EX-EXP-08.

**Veredicto: CERRADO.**

### EX-EXP-08 — Documentar riesgo de autoaprobación multi-cuenta (MEDIA)

Reparación documentada exactamente como se declaró: sección "Limitaciones conocidas" en
`README.md` (líneas 112-124), sin cambio de código ni de tests — consistente con su
propio "Estado reparación" ("Corregido (documentación)"). No se encontró ninguna
discrepancia entre lo declarado y lo verificado.

**Veredicto: CERRADO.**

### EX-EXP-09 — Cota superior a `quantity` (BAJA)

`MAX_QUANTITY = 1e7` (`src/money.ts:68`), rechaza `quantity > MAX_QUANTITY` con error
explícito. Verificado con cantidad 1e10 (rechazada) y cantidades realistas < 1e6
(aceptadas). Consistente con `test/money.test.ts` describe "EX-EXP-09".

**Veredicto: CERRADO.**

### EX-EXP-10 — Documentar riesgo de fabricar consistencia_cruzada (BAJA)

Reparación documentada exactamente como se declaró: comentario en
`src/integrity-checklist.ts:190-200` + sección README. Se confirmó que el código **no**
cambió de comportamiento (`checkConsistenciaCruzada` sigue sin validar que los
`documentLabel` de `crossDocumentTotals` sean distintos entre sí — duplicar la misma
fuente sigue produciendo "verde" técnicamente), pero esto es exactamente lo que el
"Estado reparación" original declaraba ("sin cambio de comportamiento... no hace falta
test nuevo porque no cambia ninguna lógica ejecutable"). No es un hallazgo nuevo: es la
misma limitación ya conocida y correctamente etiquetada como riesgo residual documentado,
no como defecto corregido en código.

**Veredicto: CERRADO** (para el alcance declarado, que era solo documental).

---

## 3. Preguntas específicas del mandato

**¿El cambio de EX-EXP-01 deja `ProposalVersionRegistry.inputChanged()` como código
muerto o inconsistente?**
Sí, confirmado por dos vías independientes: `grep -rn "inputChanged" src test` no
devuelve ninguna llamada fuera de la propia definición del método estático, y el reporte
de cobertura real (`vitest run --coverage`) marca `proposal-version.ts` en 33.33% de
funciones cubiertas — exactamente la fracción que corresponde a dejar sin ejercitar
`getVersion()`, `latest()`, `all()` e `inputChanged()`. La reparación de EX-EXP-01 resolvió
el problema por una ruta completamente distinta (comparación directa de `inputsHash` en
`ApprovalWorkflow`/`PackageAssembler`) y **nunca conectó** `inputChanged()` a ningún flujo
real. Esto deja dos mecanismos paralelos para la misma idea ("¿cambió un insumo?"): uno
usado y probado (comparación directa de hash), y uno declarado en la interfaz pública del
paquete pero inerte — riesgo de confusión para un futuro implementador de `apps/api` que
lea el README/tipos y asuma que `inputChanged()` es el mecanismo soportado.

**¿La cobertura de 68% en `proposal-version.ts` oculta un camino no probado que un
atacante use?**
No hay un vector de ataque directo a través de `getVersion()`/`latest()`/`all()` — son
simples getters de solo lectura sin lógica de decisión de seguridad. El riesgo real no es
"un atacante explota una rama no probada de estos getters", sino que **REQ-161
("versionado + hash reconstruible") depende de una API que nadie ejercita**: si
`apps/api` llega a depender de `getVersion(n)` para "reconstruir exactamente los insumos
usados en esa versión" (como promete el docstring del módulo) y esa función tiene un bug
sutil (p. ej. off-by-one en `version: this.versions.length + 1`, o un fallo si se llama
`getVersion` con `version: 0`), ningún test de este paquete lo detectaría antes de llegar
a producción. Es un hallazgo de calidad/cobertura, no de explotación directa dentro del
alcance de esta librería pura. Ver EX-EXP-11.

**¿A6–A15 siguen cubiertas por tests INTEGRADOS (flujo completo), no solo unitarios?**
No, y **no deberían estarlo todavía** en esta capa: `docs/ACEPTACION.md` exige
explícitamente para A6-A15 tipos de prueba "integración"/"E2E"/"adversarial" que
ejerciten "el flujo integrado real" con "UI real", "API + UI" o "portal autenticado" —
ninguno de los cuales existe aún (`apps/api` no importa `@atiende/expediente`, confirmado
por `grep`). `docs/ACEPTACION.md` mantiene A6-A15 honestamente en estado **PENDIENTE**, lo
cual es correcto y consistente con el alcance real del trabajo. El único punto de fricción
encontrado es cosmético pero real: el docstring de `test/expediente-flow.test.ts` (línea
21, preexistente desde el commit base `467be32`, no modificado en esta ronda) afirma
"Cubre A6-A15 de docs/ACEPTACION.md ejercitando el flujo completo, no helpers aislados ni
mocks de integración" — una afirmación que sobreestima lo que un test 100% in-memory,
sin HTTP/DB/UI, puede certificar según el propio estándar de `ACEPTACION.md`. Ver
EX-EXP-16.

**Regresión en consumidores (`npm run -w apps/api typecheck`)**: no aplica. `grep -rn
"@atiende/expediente" apps/ packages/` (excluyendo el propio paquete) no devuelve
coincidencias — ningún consumidor real existe todavía.

---

## 4. Tabla de hallazgos nuevos (EX-EXP-11 a EX-EXP-16)

| ID | Severidad | Relacionado con | Hallazgo | Evidencia | Reparación sugerida (separada del hallazgo) |
|---|---|---|---|---|---|
| EX-EXP-11 | **ALTA** | EX-EXP-01 | El paquete no define ni exige qué insumos deben entrar a `currentInputsHash`/`ProposalVersionRegistry.createVersion(...)`; el único test oficial (`proposal-invalidation.test.ts`) solo hashea `economicTotals`. Se reprodujo que un documento de empresa sustituido o una nueva versión de bases publicada **después** de la aprobación de alcance "expediente", si no están incluidos en ese hash por el llamador, nunca invalidan la aprobación ni impiden `"ready"` — el hash-check de EX-EXP-01 protege perfectamente el vector que reprodujo, pero no generaliza a "cualquier insumo cambiado" como promete el README ("cualquier cambio... invalida automáticamente"). Además, `sha256Hex`/`stableStringify` (vía `JSON.stringify`) descarta silenciosamente claves con valor `undefined`, produciendo el mismo hash para `{x: undefined}` y `{}` — una colisión real de serialización cuando la presencia/ausencia de un campo es información relevante. Adicionalmente, `ProposalVersionRegistry.inputChanged()`/`getVersion()`/`latest()`/`all()` quedan sin usar ni probar (33% cobertura de funciones), un mecanismo paralelo inerte a la solución realmente usada. | `src/proposal-version.ts:26-40` (`createVersion` genérico), `src/types.ts:82-95` (`stableStringify`); `attack-ex01.mjs` variantes `.a`, `.b`, `.c` | Definir en el paquete (no dejarlo 100% a discreción de `apps/api`) una función canónica `buildExpedienteInputsHash(...)` que enumere explícitamente TODOS los insumos de alcance "expediente" (tarifas, documentos de empresa, versión de bases, matriz de requisitos, checklist) y sea la única forma soportada de producir `currentInputsHash`; documentar en el README que pasar un hash construido a mano fuera de esa función invalida la garantía. Corregir `stableStringify` para serializar `undefined` explícitamente (p. ej. como `null` o un sentinela) en vez de dejar que `JSON.stringify` lo descarte. Eliminar `inputChanged()`/conectar sus llamadas reales, o documentar explícitamente que quedó deprecado en favor de la comparación directa de `inputsHash`, y agregar tests para `getVersion()`/`latest()`/`all()`. |
| EX-EXP-12 | **ALTA** (misma clase que los CRÍTICOS/ALTA originales EX-EXP-03/05, no generalizados) | EX-EXP-03, EX-EXP-05 | Dos reparaciones de esta ronda corrigen exactamente los ejemplos citados por el auditor, no la regla general de la que esos ejemplos eran instancia: (a) `TechnicalProposalBuilder.build` (`src/technical-proposal.ts:72`) solo protege `obligatoriedad === "obligatorio"`; un requisito `"condicional"` que en el caso concreto SÍ aplica y no tiene evidencia mapeable **desaparece en silencio** exactamente como el defecto original (0 secciones, 0 bloqueos). (b) `apocopeUno` (`src/number-to-words.ts:106-112`) solo reconoce los sufijos exactos `"uno"`, `"veintiuno"` y `" uno"` (con espacio); no reconoce `"veintiuno"` fusionado al final de una cadena más larga (`"ciento veintiuno"`, `"doscientos veintiuno"`, y su propagación a `"...mil"/"...millones"`). Montos reales como $121,450.00 o $2,121,000.00 siguen imprimiendo "VEINTIUNO" en vez de "VEINTIÚN" en la carta de proposición económica. | `src/technical-proposal.ts:71-78`; `src/number-to-words.ts:106-112`; `attack-ex03.mjs` variante `.a`, `attack-ex05.mjs`/`attack-ex05b.mjs` | (a) Cambiar la condición de `technical-proposal.ts:72` de `requirement.obligatoriedad !== "obligatorio"` a una lista explícita de obligatoriedades verdaderamente procedimentales (solo `"opcional"`), o mejor, exigir que el llamador declare explícitamente si un `"condicional"` aplica al caso concreto (un campo `appliesToThisCase: boolean` en el mapeo) antes de decidir el skip silencioso — nunca inferirlo del valor de `obligatoriedad` a secas. (b) Reescribir `apocopeUno` para operar por palabras (`words.split(" ")`, apocopar la última palabra si es exactamente `"uno"` o `"veintiuno"`, reconstruir) en vez de comparar sufijos de cadena completa; agregar casos de test 121, 221, 1121, 2121, 21121, 121000, 121000000 (todas las combinaciones de centena-terminada-en-21 en cada orden de magnitud). |
| EX-EXP-13 | **ALTA** | EX-EXP-04 | `assertExplicitOffset` (`src/types.ts:49-55`) valida solo el *formato* del offset horario (`/(?:Z\|[+-]\d{2}:\d{2})$/`), no su rango numérico (00-23 horas, 00-59 minutos) ni que el resto de la fecha sea un calendario válido. Un offset numéricamente imposible como `"+99:00"` pasa la validación; `new Date(...)` produce `Invalid Date` (`getTime()` = `NaN`); `isPast()` calcula `NaN < NaN`, que en JavaScript es `false` — la fecha corrupta se evalúa silenciosamente como **"nunca vencida"** en vez de lanzar una excepción. Es un *fail-open* sobre exactamente la garantía de vigencias (REQ-160) que EX-EXP-04 pretendía cerrar, y es potencialmente más grave que el bug original porque no depende del `TZ` del proceso ni de ninguna condición de entorno: basta con que el dato de origen (una migración, un adaptador Postgres con un valor corrupto) tenga un offset mal formado. Adicionalmente, `"2026-02-29T00:00:00-06:00"` (2026 no es año bisiesto) pasa la validación y `Date` la reinterpreta silenciosamente como 1 de marzo — impacto menor (corrimiento de un día) pero mismo patrón de "no se valida la validez semántica de la fecha, solo su forma". | `src/types.ts:37,49-55,58-62`; `attack-ex04.mjs`, `attack-ex04b.mjs` | Tras pasar el chequeo de formato, parsear el offset numéricamente y rechazar horas fuera de `[00,23]`/minutos fuera de `[00,59]`. Además, después de `new Date(iso)`, comprobar explícitamente `Number.isNaN(date.getTime())` en `isPast()`/donde se parsee cualquier fecha de este paquete y lanzar una excepción explícita en vez de dejar que la comparación numérica con `NaN` se evalúe silenciosamente como `false` — un `Date` inválido nunca debe interpretarse como "no vencido". Opcionalmente, validar la fecha calendárica reconstruyendo year/month/day desde el `Date` parseado y comparando contra los componentes originales de la cadena, para detectar el caso 29-feb en año no bisiesto. |
| EX-EXP-14 | MEDIA | EX-EXP-02 | Ni `ApprovalWorkflow.approve()` ni `PackageAssembler.buildManifest` validan la consistencia semántica entre `scope` y `scopeRef`: `buildManifest` filtra únicamente por `a.scope === "expediente"`, sin exigir además `a.scopeRef === "expediente"`. Una aprobación construida (por un eventual bug de `apps/api`, p. ej. un formulario que fija `scope` de un desplegable independiente del `scopeRef` calculado dinámicamente) con `scope: "expediente"` pero `scopeRef` arbitrario ("expediente-OTRO-EXPEDIENTE") cuenta igual como aprobación total válida del expediente correcto. | `src/package-assembler.ts:116-119`; `attack-ex02.mjs` variante `.c` | Exigir en `approve()` que si `scope === "expediente"` entonces `scopeRef` deba ser exactamente la cadena `"expediente"` (rechazar la llamada en caso contrario), y/o que `buildManifest` filtre por `a.scope === "expediente" && a.scopeRef === "expediente"` en vez de solo por `scope`. |
| EX-EXP-15 | MEDIA | EX-EXP-06 | El patrón numérico de `extractDeadline` (`src/requirement-matrix.ts:284-293`) siempre interpreta `DD/MM/AAAA`/`DD-MM-AAAA` sin marcar ambigüedad ni ajustar `confidence` cuando día y mes son ambos ≤12 (p. ej. "05/09/2026" podría razonablemente ser 5-sep o 9-may si el documento de origen usa convención estadounidense por error de copiado). `confidence: 0.7` es idéntico para el caso ambiguo y el inequívoco (día > 12). Esto contradice la filosofía declarada del extractor ("ante ambigüedad, clasifica como condicional/sin fecha antes que inventar un valor") para este patrón específico — DD/MM es la convención correcta por defecto en licitaciones mexicanas, pero el sistema nunca señala que asumió una interpretación entre dos posibles. | `src/requirement-matrix.ts:284-293`, `classifySentence:141`; `attack-ex06.mjs` | Cuando `día <= 12 && mes <= 12` en el patrón numérico, bajar `confidence` (p. ej. a 0.5) o agregar un campo/anotación explícita de "fecha numérica ambigua (DD/MM asumido por convención; podría ser MM/DD)" para que un revisor humano lo confirme, sin cambiar la interpretación por defecto (que debe seguir siendo DD/MM). |
| EX-EXP-16 | BAJA | Documentación / A6-A15 | El docstring de `test/expediente-flow.test.ts:17-23` (preexistente desde el commit base `467be32`, no tocado en esta ronda de corrección) afirma "Cubre A6-A15 de docs/ACEPTACION.md ejercitando el flujo completo, no helpers aislados ni mocks de integración". Es un test 100% in-memory (sin HTTP, sin base de datos real, sin UI) dentro de una librería pura — no satisface el estándar que el propio `docs/ACEPTACION.md` exige explícitamente para A6-A15 ("integración"/"E2E" con "UI real"/"API + UI"/"portal autenticado"), que además siguen correctamente marcadas PENDIENTE en esa tabla. El riesgo es que un futuro lector o agente automatizado, al ver "Cubre A6-A15" en el código, asuma erróneamente que esas pruebas de aceptación ya están satisfechas. | `test/expediente-flow.test.ts:17-23`; comparación con `docs/ACEPTACION.md:180-200` | Reformular el docstring para decir explícitamente que este test cubre el flujo integrado *dentro de la librería pura* como precondición necesaria pero no suficiente para A6-A15, y que las pruebas de aceptación reales (integración/E2E con API/UI) siguen pendientes en `apps/api`/`apps/web` según `docs/ACEPTACION.md`. |

---

## 5. Comprobado correcto (verificado independientemente en esta ronda)

- Reproducibilidad exacta: mismo conteo de archivos/tests (14/118), mismo resultado de
  typecheck/lint/build, cobertura idéntica (91.03% stmts) a lo declarado en
  `docs/logs/fix-expediente-ronda1.log`.
- `stableStringify`/`sortKeysDeep` (`src/types.ts:82-95`) ordena recursivamente las claves
  de cualquier objeto anidado antes de hashear — dos objetos lógicamente iguales con
  distinto orden de claves producen el **mismo** hash por diseño correcto (no es una
  colisión, es la garantía que se pretendía).
- `PackageAssembler.buildManifest` rechaza correctamente: comparación de hash por
  substring/prefijo (falla), múltiples aprobaciones parciales de scope "documento"/"sección"
  que intentan "sumar" a nivel de expediente (falla), y aprobación de una versión N
  aplicada contra insumos de la versión N+1 (falla, cubierto por el mismo mecanismo de
  hash de EX-EXP-01).
- `EX-EXP-07` (validación de `ivaRate`/moneda): la comparación de moneda es case-sensitive
  y falla cerrado (`"mxn"` en minúsculas se rechaza igual que cualquier otra moneda).
- `EX-EXP-08` y `EX-EXP-10`: ambas reparaciones son exactamente lo que declaran ser
  (documentación, sin cambio de comportamiento) — no hay discrepancia entre lo declarado
  en la tabla de hallazgos original y lo verificado en el código.
- `EX-EXP-09`: `MAX_QUANTITY = 1e7` rechaza cantidades absurdas (1e10) y acepta
  cantidades realistas de licitación sin falsos positivos.
- Ningún consumidor real (`apps/api`, `apps/web`, otros `packages/*`) importa
  `@atiende/expediente` todavía — no hay superficie de regresión que evaluar fuera del
  propio paquete en esta ronda.
- `docs/ACEPTACION.md` mantiene A6-A15 honestamente en PENDIENTE; ningún documento de
  esta ronda de corrección reclama falsamente haberlas cerrado.
- Un requisito duplicado en dos documentos (misma obligación, distinta fuente) genera dos
  secciones idénticas en `TechnicalProposalBuilder` en vez de deduplicarse — es ruido
  cosmético en el documento final, no una fabricación ni una señal falsa de completitud
  (si el mapeo de datos falla, ambas copias fallan igual); no se eleva a hallazgo numerado
  por no violar ningún invariante de "nunca listo si incompleto"/"nunca inventar".

---

## Notas de alcance

- Reverificación limitada a `packages/expediente/**`; no se evaluaron `packages/db` ni
  `apps/api`/`apps/web` (siguen sin implementación real que los conecte a este paquete).
- El worktree de esta reverificación (`git worktree add`) se eliminó al finalizar; no
  quedan scripts `.mjs` adversariales ni cambios de código en el árbol principal — todos
  los hallazgos son de solo lectura sobre el commit `49141fb` (y su árbol de archivos,
  idéntico en `packages/expediente/**` al commit padre `421317f`, ya que `49141fb` solo
  tocó `README.md`/`docs/logs/`).

---

## 6. Estado reparación (ronda 2 de corrección)

Sección añadida en la ronda 2 de corrección (agente corrector Sonnet,
docs/logs/fix-expediente-ronda2.log) para no alterar el texto de las
secciones 1-5 anteriores (que documentan la reverificación tal como se
entregó). Un hallazgo se marca "Corregido" solo cuando existe un test nuevo
que reproduce y falla contra el código anterior, la corrección lo hace
pasar, y la suite completa queda verde (evidencia real en
`docs/logs/fix-expediente-ronda2.log`).

| ID | Estado reparación | Commit / evidencia |
|---|---|---|
| EX-EXP-01 / EX-EXP-11 | **Corregido** | `fix(expediente): EX-EXP-01/EX-EXP-11 hash de insumos cerrado y obligatorio (computeInputsHash)`. `ProposalVersionRegistry.createVersion`/`computeInputsHash` exigen `ExpedienteInputs` (conjunto cerrado: versión de bases, documentos de empresa con vigencia, tarifas, perfil, plantillas), validado en runtime; el llamador ya no puede omitir una categoría ni pasar un hash arbitrario. `stableStringify` ya no colisiona `undefined` con clave ausente. `inputChanged()` conectado vía `changedInputsSince`. Tests: `test/proposal-invalidation.test.ts` (describe "EX-EXP-11" y describe de cobertura de `ProposalVersionRegistry`); se verificó que 7/10 tests nuevos fallaban contra el código previo (commit `467be32`) antes de aplicar la corrección. |
| EX-EXP-03 / EX-EXP-12(a) | **Corregido** | `fix(expediente): EX-EXP-03/EX-EXP-12 requisito condicional que aplica ya no desaparece en silencio`. `TechnicalProposalBuilder.build` distingue `obligatorio`/`condicional_aplica`/`no_evaluable` (fail-closed: PENDIENTE + bloqueo `"condicion_no_evaluable"`)/`no_aplica` (solo `opcional`, o `condicional` declarado EXPLÍCITAMENTE como no aplicable vía el nuevo parámetro `conditionEvaluations`); ya no se infiere del valor de `obligatoriedad` a secas. Tests: `test/technical-proposal.test.ts` (describe nuevo) y `test/technical-proposal-property.test.ts` (200 casos aleatorios deterministas, invariante "ningún requisito desaparece sin razón explícita"); se verificó en worktree separado que 98/330 tests fallaban contra el código previo. |
| EX-EXP-05 / EX-EXP-12(b) | **Corregido** | `fix(expediente): EX-EXP-05/EX-EXP-12 apócope 'veintiún' fusionado al final de centenas/millares/millones`. `apocopeUno` (`src/number-to-words.ts`) ahora reconoce el sufijo `"veintiuno"` fusionado (sin espacio previo) además del caso aislado `" uno"`/`"uno"` exacto; cubre 121, 221, 1121, 2121, 21121, 121000, 121000000 y su propagación a "...mil"/"...millones". Tests: `test/number-to-words.test.ts` describe "EX-EXP-05/EX-EXP-12(b)"; se verificó en worktree separado que 8/339 tests fallaban contra el código previo. |
| EX-EXP-04 / EX-EXP-13 | **Corregido** | `fix(expediente): EX-EXP-04/EX-EXP-13 rango de offset y validez calendárica (fail-closed)`. `assertExplicitOffset` (`src/types.ts`) ahora valida además el RANGO numérico del offset (-12:00 a +14:00, minutos 00-59) y la validez CALENDÁRICA (día/mes real, años bisiestos), con una defensa final `Number.isNaN`; `isPast` ya no puede recibir una fecha inválida sin que se lance antes — nunca "no vencido" sobre una fecha corrupta. Tests: `test/types.test.ts` (nuevo) y `test/timezone-determinism.test.ts` (3 casos nuevos EX-EXP-13 en las 3 zonas horarias reales); se verificó en worktree separado que 11/357 tests fallaban contra el código previo. |
| EX-EXP-02 (residual) / EX-EXP-14 | **Corregido** | `fix(expediente): EX-EXP-02/EX-EXP-14 scope 'expediente' exige scopeRef == 'expediente'`. `ApprovalWorkflow.approve()` rechaza `scope === "expediente"` con `scopeRef` distinto de la cadena `"expediente"` (`scope_scopeRef_inconsistente`); `PackageAssembler.buildManifest` filtra además por `scopeRef === "expediente"` como defensa en profundidad independiente. Tests: `test/approval-workflow.test.ts` y `test/package-assembler.test.ts` (describes nuevos); se verificó en worktree separado que 2/360 tests fallaban contra el código previo — el más grave producía `manifest.status === "ready"` con un `scopeRef` arbitrario. |
